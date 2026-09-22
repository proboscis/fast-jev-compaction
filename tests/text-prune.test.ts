import { describe, expect, it } from 'vitest';
import {
  applyDecisions,
  collectToolCalls,
  compact,
  deliveryIds,
  isCompactionSummary,
  planMessagePrune,
  resolveOptions,
  type JevAsker,
  type JevQuestions,
  type Message,
} from '../src/index.js';
import { parseResolvedIds, resolveHookConfig, summarize } from '../hooks/fast-jev.ts';

function message(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}

/** A delivery bundle long enough for the dedupe floor (200 chars). */
function delivery(sender: string, body: string): string {
  return `[まとめて届いた 1 通 — 到着順]\n\n--- 1/1 通目 ---\n[agmsg from ${sender}] ${body.repeat(8)}`;
}

const SUMMARY =
  'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request and Intent: ' +
  'x'.repeat(400);

function filler(n: number): Message[] {
  return Array.from({ length: n }, (_, i) => message('assistant', `working ${i}`));
}

/** Newest-message pinning off, so the rules may look at everything but the first. */
const options = resolveOptions({ preserveRecentMessages: 0 });

describe('isCompactionSummary', () => {
  it('knows the engine\'s summary from a normal body', () => {
    expect(isCompactionSummary(SUMMARY)).toBe(true);
    expect(isCompactionSummary(`\n  ${SUMMARY}`)).toBe(true);
    expect(isCompactionSummary('This session is great')).toBe(false);
  });
});

describe('deliveryIds', () => {
  it('reads the sender of a delivery header and the ledger ids of the body', () => {
    expect(deliveryIds('[agmsg from s-2bb522decd] hello')).toEqual(['s-2bb522decd']);
    expect(deliveryIds('[agmsg from integration-lead] a [agmsg from integration-lead] b')).toEqual([
      'integration-lead',
    ]);
    expect(deliveryIds('答えた手紙 lt-7E9PFKCPBG3KK5N7 と ob-hkft を閉じた')).toEqual([
      'lt-7E9PFKCPBG3KK5N7',
      'ob-hkft',
    ]);
    expect(deliveryIds('plain prose with no delivery at all')).toEqual([]);
  });
});

describe('planMessagePrune: repeated deliveries', () => {
  const body = delivery('s-2bb522decd', 'the same bundle arrived again. ');
  const messages: Message[] = [
    message('user', 'first message, always pinned'),
    message('user', body),
    ...filler(2),
    message('user', body),
    ...filler(2),
    message('user', body),
  ];

  it('keeps the newest copy and removes the older ones', () => {
    const decisions = planMessagePrune(messages, options);
    expect(decisions.map((d) => [d.index, d.reason])).toEqual([
      [1, 'repeated_user_text'],
      [4, 'repeated_user_text'],
    ]);
    const kept = applyDecisions(messages, [], [], 300, decisions);
    expect(kept[1]!.text).toMatch(/removed a repeated delivery/);
    expect(kept[7]!.text).toBe(body);
    expect(kept[1]!.text.length).toBeLessThan(body.length);
  });

  it('leaves a body that is not repeated, a short repeat, and an assistant repeat alone', () => {
    const short = 'Continue from where you left off.';
    const others: Message[] = [
      message('user', 'first'),
      message('user', delivery('s-1', 'unique one. ')),
      message('user', short),
      message('user', short),
      message('assistant', SUMMARY),
      message('assistant', SUMMARY),
    ];
    expect(planMessagePrune(others, options)).toEqual([]);
  });

  it('does nothing when dedupeRepeatedUserText is off', () => {
    expect(
      planMessagePrune(messages, resolveOptions({ preserveRecentMessages: 0, dedupeRepeatedUserText: false })),
    ).toEqual([]);
  });

  it('never touches the first message or the newest preserved ones', () => {
    const pinnedBoth: Message[] = [message('user', delivery('s-1', 'same body. ')), ...filler(1), message('user', delivery('s-1', 'same body. '))];
    expect(planMessagePrune(pinnedBoth, resolveOptions({ preserveRecentMessages: 2 }))).toEqual([]);
  });
});

describe('planMessagePrune: superseded summaries', () => {
  const messages: Message[] = [
    message('user', 'first message, always pinned'),
    message('user', SUMMARY),
    ...filler(2),
    message('user', `${SUMMARY}\nand a second round`),
    ...filler(2),
  ];

  it('keeps the newest summary and removes the earlier ones', () => {
    const decisions = planMessagePrune(messages, options);
    expect(decisions.map((d) => [d.index, d.reason])).toEqual([[1, 'superseded_summary']]);
    expect(applyDecisions(messages, [], [], 300, decisions)[1]!.text).toMatch(
      /superseded compaction summary/,
    );
  });

  it('leaves a single summary alone and does nothing when the option is off', () => {
    expect(planMessagePrune([message('user', 'first'), message('user', SUMMARY), ...filler(1)], options)).toEqual([]);
    expect(
      planMessagePrune(messages, resolveOptions({ preserveRecentMessages: 0, dropSupersededSummaries: false })),
    ).toEqual([]);
  });
});

describe('planMessagePrune: answered deliveries', () => {
  const answered = delivery('s-answered', 'please review this. ');
  const mixed = `${delivery('s-answered', 'please review this. ')}\n[agmsg from s-open] still waiting`;
  const messages: Message[] = [
    message('user', 'first message, always pinned'),
    message('user', answered),
    message('user', mixed),
    message('user', delivery('s-other', 'unanswered. ')),
    ...filler(2),
  ];

  it('removes a delivery whose ids are all answered, and only that one', () => {
    const decisions = planMessagePrune(messages, {
      ...options,
      resolvedIds: ['s-answered'],
    });
    expect(decisions.map((d) => [d.index, d.reason])).toEqual([[1, 'resolved_ids']]);
    expect(applyDecisions(messages, [], [], 300, decisions)[1]!.text).toMatch(/s-answered/);
  });

  it('removes nothing without ids, and nothing for a body that names none', () => {
    expect(planMessagePrune(messages, options)).toEqual([]);
    expect(
      planMessagePrune([message('user', 'first'), message('user', 'prose only, no ids at all'), ...filler(1)], {
        ...options,
        resolvedIds: ['s-answered'],
      }),
    ).toEqual([]);
  });
});

describe('a pruned message keeps its tool blocks', () => {
  it('replaces the body and leaves the tool result in place', () => {
    const body = delivery('s-1', 'repeated with a tool result attached. ');
    const messages: Message[] = [
      message('user', 'first'),
      message('user', body, { toolResults: [{ tool_use_id: 'tool-1', text: 'FAIL' }] }),
      ...filler(2),
      message('user', body),
    ];
    const kept = applyDecisions(messages, [], [], 300, planMessagePrune(messages, options));
    expect(kept).toHaveLength(messages.length);
    expect(kept[1]!.toolResults).toEqual([{ tool_use_id: 'tool-1', text: 'FAIL' }]);
    expect(kept[1]!.text).toMatch(/repeated delivery/);
  });
});

const keepEverything: JevAsker = {
  async ask(_state, questions: JevQuestions) {
    return {
      answers: Object.fromEntries(
        Object.keys(questions).map((name) => [name, { type: 'noul' as const, noul: 1 }]),
      ),
    };
  },
};

describe('compact', () => {
  it('counts the three rules in the stats and shrinks the history without Jev', async () => {
    const body = delivery('s-2bb522decd', 'a bundle delivered again and again. ');
    const messages: Message[] = [
      message('user', 'first message, always pinned'),
      message('user', SUMMARY),
      message('user', body),
      ...filler(2),
      message('user', `${SUMMARY}\nsecond round`),
      message('user', body),
      ...filler(6),
    ];
    const result = await compact(messages, keepEverything, { preserveRecentMessages: 6 });
    expect(result.stats.repeatedTexts).toBe(1);
    expect(result.stats.supersededSummaries).toBe(1);
    expect(result.stats.resolvedDeliveries).toBe(0);
    expect(result.stats.textCharsDropped).toBeGreaterThan(500);
    expect(result.stats.charsAfter).toBeLessThan(result.stats.charsBefore);
    expect(result.messageDecisions).toHaveLength(2);
    expect(summarize(result)).toContain('text: 1 repeated, 1 old summaries, 0 answered');
    expect(collectToolCalls(result.messages, 6)).toEqual([]);
  });

  it('leaves everything in place when both rules are off', async () => {
    const body = delivery('s-1', 'a bundle delivered again. ');
    const messages: Message[] = [message('user', 'first'), message('user', body), ...filler(2), message('user', body)];
    const result = await compact(messages, keepEverything, {
      preserveRecentMessages: 0,
      dedupeRepeatedUserText: false,
      dropSupersededSummaries: false,
    });
    expect(result.messageDecisions).toEqual([]);
    expect(result.stats.charsAfter).toBe(result.stats.charsBefore);
  });
});

describe('parseResolvedIds', () => {
  it('reads one id per line and ignores blanks, comments and repeats', () => {
    expect(parseResolvedIds('lt-A\n\n  lt-B  \n# a note\nlt-A\n')).toEqual(['lt-A', 'lt-B']);
    expect(parseResolvedIds('')).toEqual([]);
  });

  it('is off by default in the hook config', () => {
    expect(resolveHookConfig({}).resolvedIdsCommand).toBe('');
    expect(resolveHookConfig({ resolvedIdsCommand: 'ai letters answered' }).resolvedIdsCommand).toBe(
      'ai letters answered',
    );
    expect(resolveHookConfig({ dedupeRepeatedUserText: false }).dedupeRepeatedUserText).toBe(false);
    expect(resolveHookConfig({}).dedupeRepeatedUserText).toBeUndefined();
  });
});
