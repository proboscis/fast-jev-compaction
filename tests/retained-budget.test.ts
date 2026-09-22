import { describe, expect, it } from 'vitest';
import {
  applyDecisions,
  collectToolCalls,
  compact,
  decideCall,
  resolveOptions,
  retainedTokens,
  trimToBudget,
  type JevAsker,
  type JevQuestions,
  type Message,
} from '../src/index.js';
import { minReductionPercentOf, resolveHookConfig } from '../hooks/fast-jev.ts';

function message(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): Message {
  return message('assistant', '', { toolUses: [{ tool_use_id: id, tool, input, text }] });
}

function result(id: string, text: string): Message {
  return message('user', '', { toolResults: [{ tool_use_id: id, text }] });
}

/** ~1,000 estimated tokens of plausible file text. */
function body(seed: string): string {
  return `export const ${seed} = ${seed.length};\n`.repeat(260);
}

/**
 * Eight reads of ~1k tokens each, framed by the pinned first message and the
 * six newest messages. This is the shape that made the retained size ratchet:
 * Jev keeps everything it was already shown, so nothing new is ever dropped.
 */
function transcript(): Message[] {
  const messages: Message[] = [message('user', 'Never touch src/generated. Fix the failing test.')];
  for (let i = 1; i <= 8; i += 1) {
    messages.push(call(`tool-${i}`, 'Read', { file_path: `src/f${i}.ts` }, body(`f${i}`)));
    messages.push(result(`tool-${i}`, body(`f${i}`)));
  }
  messages.push(message('assistant', 'Found it.'));
  messages.push(message('user', 'go ahead'));
  return messages;
}

/** Jev that wants to keep every call and every result — the ratchet's engine. */
const keepEverything: JevAsker = {
  async ask(_state, questions: JevQuestions) {
    return {
      answers: Object.fromEntries(
        Object.keys(questions).map((name) => [name, { type: 'noul' as const, noul: 1 }]),
      ),
    };
  },
};

describe('retainedTokens', () => {
  it('counts text, tool input and tool output', () => {
    expect(retainedTokens([message('user', '')])).toBe(0);
    expect(retainedTokens(transcript())).toBeGreaterThan(10_000);
  });
});

describe('trimToBudget', () => {
  const messages = transcript();
  const options = resolveOptions({});
  const calls = collectToolCalls(messages, options.preserveRecentMessages);
  const keptAll = calls.map((c) =>
    decideCall(c, { keepCall: 1, keepResult: 1 }, options),
  );

  it('leaves the decisions alone when the history already fits', () => {
    const { decisions, trimmed } = trimToBudget(messages, keptAll, calls, 300, 10_000_000);
    expect(trimmed).toBe(0);
    expect(decisions.map((d) => d.action)).toEqual(keptAll.map((d) => d.action));
  });

  it('is off when the budget is 0', () => {
    expect(trimToBudget(messages, keptAll, calls, 300, 0).trimmed).toBe(0);
  });

  it('brings the history under the budget Jev ignored', () => {
    const target = 8_000;
    const { decisions, trimmed } = trimToBudget(messages, keptAll, calls, 300, target);
    expect(trimmed).toBeGreaterThan(0);
    const kept = applyDecisions(messages, decisions, calls, 300);
    expect(retainedTokens(kept)).toBeLessThanOrEqual(target);
  });

  it('drops the oldest calls first and leaves the newest kept', () => {
    const { decisions } = trimToBudget(messages, keptAll, calls, 300, 6_000);
    const touched = decisions.filter((d) => d.reason !== 'pinned');
    const stillKept = touched.filter((d) => d.action === 'keep');
    const escalated = touched.filter((d) => d.action !== 'keep');
    // every escalated call is older than every call that survived intact
    const order = new Map(calls.map((c, i) => [c.id, i]));
    for (const dropped of escalated) {
      for (const survivor of stillKept) {
        expect(order.get(dropped.id)!).toBeLessThan(order.get(survivor.id)!);
      }
    }
  });

  it('never escalates a pinned call', () => {
    const { decisions } = trimToBudget(messages, keptAll, calls, 300, 1);
    for (const decision of decisions) {
      if (decision.reason === 'pinned') expect(decision.action).toBe('keep');
    }
  });

  it('falls back to dropping whole calls when truncating results is not enough', () => {
    const { decisions } = trimToBudget(messages, keptAll, calls, 300, 1);
    expect(decisions.some((d) => d.action === 'drop_call')).toBe(true);
  });

  it('stops at the pinned floor instead of touching what it must not', () => {
    // The newest six messages hold two whole reads; no budget can go below them.
    const { decisions } = trimToBudget(messages, keptAll, calls, 300, 1);
    const kept = applyDecisions(messages, decisions, calls, 300);
    const floor = retainedTokens(
      applyDecisions(
        messages,
        keptAll.map((d) =>
          d.reason === 'pinned' ? d : { ...d, action: 'drop_call' as const, reason: 'call_dropped' as const },
        ),
        calls,
        300,
      ),
    );
    expect(retainedTokens(kept)).toBe(floor);
    expect(floor).toBeGreaterThan(1);
  });
});

describe('compact under a retained budget', () => {
  it('removes nothing when Jev keeps everything and the budget is off', async () => {
    const result = await compact(transcript(), keepEverything, { maxRetainedTokens: 0 });
    expect(result.stats.budgetTrimmed).toBe(0);
    expect(result.stats.retainedTarget).toBe(0);
    expect(result.stats.charsAfter).toBe(result.stats.charsBefore);
  });

  it('holds the history under the budget even when Jev keeps everything', async () => {
    const target = 8_000;
    const result = await compact(transcript(), keepEverything, { maxRetainedTokens: target });
    expect(result.stats.retainedTarget).toBe(target);
    expect(result.stats.budgetTrimmed).toBeGreaterThan(0);
    expect(result.stats.retainedTokens).toBeLessThanOrEqual(target);
    expect(result.stats.charsAfter).toBeLessThan(result.stats.charsBefore);
  });

  it('does not ratchet: compacting the grown history again lands at the same ceiling', async () => {
    const target = 8_000;
    const first = await compact(transcript(), keepEverything, { maxRetainedTokens: target });
    // the conversation carries on: six more reads land on top of the compacted history
    const grown: Message[] = [...first.messages];
    for (let i = 9; i <= 14; i += 1) {
      grown.push(call(`tool-${i}`, 'Read', { file_path: `src/f${i}.ts` }, body(`f${i}`)));
      grown.push(result(`tool-${i}`, body(`f${i}`)));
    }
    grown.push(message('assistant', 'Still going.'));
    grown.push(message('user', 'continue'));
    expect(retainedTokens(grown)).toBeGreaterThan(target);

    const second = await compact(grown, keepEverything, { maxRetainedTokens: target });
    expect(second.stats.retainedTokens).toBeLessThanOrEqual(target);
    // the point of the fix: the second compaction does not keep more than the first
    expect(second.stats.retainedTokens).toBeLessThanOrEqual(first.stats.retainedTokens * 1.1);
  });

  it('defaults the budget to 60000 tokens', async () => {
    const result = await compact(transcript(), keepEverything);
    expect(result.stats.retainedTarget).toBe(60_000);
  });
});

describe('minReductionPercentOf', () => {
  it('defaults to 40 percent', () => {
    expect(minReductionPercentOf({})).toBe(40);
    expect(resolveHookConfig({}).minReductionPercent).toBe(40);
  });
  it('reads the percent when it is set', () => {
    expect(minReductionPercentOf({ minReductionPercent: 55 })).toBe(55);
  });
  it('still understands the retired ratio', () => {
    expect(minReductionPercentOf({ minReductionRatio: 0.25 })).toBe(25);
  });
  it('lets the percent win when both are set', () => {
    expect(minReductionPercentOf({ minReductionPercent: 40, minReductionRatio: 0.25 })).toBe(40);
  });
  it('passes maxRetainedTokens through to the library options', () => {
    expect(resolveHookConfig({ maxRetainedTokens: 30_000 }).maxRetainedTokens).toBe(30_000);
    expect(resolveOptions(resolveHookConfig({})).maxRetainedTokens).toBe(60_000);
  });
});
