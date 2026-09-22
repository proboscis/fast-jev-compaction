import { noulAnswer } from './request.js';
import { collectToolCalls, estimateTokens, fitState } from './state.js';
import type {
  CallAnswer,
  CallDecision,
  CompactOptions,
  CompactResult,
  CompactionState,
  JevAsker,
  JevQuestions,
  Message,
  ResolvedCompactOptions,
  ToolCall,
  ToolUse,
} from './types.js';

export const DEFAULT_OPTIONS: ResolvedCompactOptions = {
  goal: '',
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  truncateHeadChars: 300,
  maxRetainedTokens: 60_000,
};

/** Tokens the request envelope (`model`, key names) adds around state and questions. */
const REQUEST_OVERHEAD_TOKENS = 20;

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function resolveOptions(options: CompactOptions = {}): ResolvedCompactOptions {
  return {
    goal: options.goal ?? DEFAULT_OPTIONS.goal,
    keepThreshold: finite(options.keepThreshold, DEFAULT_OPTIONS.keepThreshold),
    preserveRecentMessages: Math.max(
      0,
      Math.floor(
        finite(options.preserveRecentMessages, DEFAULT_OPTIONS.preserveRecentMessages),
      ),
    ),
    maxStateTokens: Math.max(1, finite(options.maxStateTokens, DEFAULT_OPTIONS.maxStateTokens)),
    maxRequestTokens: Math.max(
      1,
      finite(options.maxRequestTokens, DEFAULT_OPTIONS.maxRequestTokens),
    ),
    truncateHeadChars: Math.max(
      0,
      Math.floor(finite(options.truncateHeadChars, DEFAULT_OPTIONS.truncateHeadChars)),
    ),
    maxRetainedTokens: Math.max(
      0,
      Math.floor(finite(options.maxRetainedTokens, DEFAULT_OPTIONS.maxRetainedTokens)),
    ),
  };
}

/** The two `noul` questions asked about one call: keep the call, keep its result. */
export function questionsFor(call: ToolCall): JevQuestions {
  return {
    [`call_${call.id}`]: {
      type: 'noul',
      instructions: `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
    },
    [`result_${call.id}`]: {
      type: 'noul',
      instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
    },
  };
}

/**
 * Splits the candidate calls into batches whose questions, together with the
 * (always complete) state, fit one request.
 */
export function batchCalls(
  calls: readonly ToolCall[],
  stateTokens: number,
  options: Pick<ResolvedCompactOptions, 'maxRequestTokens'>,
): ToolCall[][] {
  const budget = options.maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
  const batches: ToolCall[][] = [];
  let current: ToolCall[] = [];
  let currentTokens = 0;
  for (const call of calls) {
    const tokens = estimateTokens(JSON.stringify(questionsFor(call)));
    if (current.length > 0 && currentTokens + tokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && tokens > budget) {
      throw new Error(
        `state leaves no room for questions (~${stateTokens} of ${options.maxRequestTokens} tokens)`,
      );
    }
    current.push(call);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function decideCall(
  call: Pick<ToolCall, 'id' | 'tool' | 'pinned'>,
  answer: CallAnswer,
  options: Pick<ResolvedCompactOptions, 'keepThreshold'>,
): CallDecision {
  const base = { id: call.id, tool: call.tool, ...answer };
  if (call.pinned) return { ...base, action: 'keep', reason: 'pinned' };
  if (answer.keepResult >= options.keepThreshold) {
    return { ...base, action: 'keep', reason: 'kept' };
  }
  if (answer.keepCall >= options.keepThreshold) {
    return { ...base, action: 'drop_result', reason: 'result_dropped' };
  }
  return { ...base, action: 'drop_call', reason: 'call_dropped' };
}

async function askBatch(
  asker: JevAsker,
  state: CompactionState,
  batch: readonly ToolCall[],
): Promise<Map<string, CallAnswer>> {
  const questions: JevQuestions = Object.assign({}, ...batch.map(questionsFor));
  const { answers } = await asker.ask(state, questions);
  return new Map(
    batch.map((call) => [
      call.id,
      {
        keepCall: noulAnswer(answers, `call_${call.id}`),
        keepResult: noulAnswer(answers, `result_${call.id}`),
      },
    ]),
  );
}

function truncatedResultText(text: string, isError: boolean, headChars: number): string {
  if (text.length <= headChars + 120) return text;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : '';
  return `${head}[fast-jev-compaction truncated ${text.length - headChars} chars of this tool result${
    isError ? ' (error)' : ''
  }; re-run the tool if needed]`;
}

/**
 * Rebuilds the conversation from the decisions. A dropped call disappears
 * together with its result; a dropped result keeps a bounded head and note.
 * Messages that lose all their content are removed; untouched messages are
 * returned as the same objects they came in as.
 */
export function applyDecisions(
  messages: readonly Message[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  headChars: number,
): Message[] {
  const byId = new Map(calls.map((call) => [call.id, call]));
  const actions = new Map<string, CallDecision['action']>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (call && decision.action !== 'keep') actions.set(call.tool_use_id, decision.action);
  }
  const kept: Message[] = [];
  for (const message of messages) {
    const touched =
      message.toolUses.some((tool) => actions.has(tool.tool_use_id)) ||
      (message.toolResults ?? []).some((result) => actions.has(result.tool_use_id));
    if (!touched) {
      kept.push(message);
      continue;
    }
    const toolUses = message.toolUses
      .filter((tool) => actions.get(tool.tool_use_id) !== 'drop_call')
      .map((tool) => {
        if (actions.get(tool.tool_use_id) !== 'drop_result') return tool;
        const text = truncatedResultText(
          tool.text ?? '',
          tool.isError ?? false,
          headChars,
        );
        if ((tool.text ?? '') === text) return tool;
        const copy: ToolUse = {
          tool_use_id: tool.tool_use_id,
          tool: tool.tool,
          input: tool.input,
          text,
        };
        if (tool.isError) copy.isError = true;
        return copy;
      });
    const toolResults = (message.toolResults ?? [])
      .filter((result) => actions.get(result.tool_use_id) !== 'drop_call')
      .map((result) => {
        if (actions.get(result.tool_use_id) !== 'drop_result') return result;
        const text = truncatedResultText(result.text, result.isError ?? false, headChars);
        return text === result.text
          ? result
          : {
              tool_use_id: result.tool_use_id,
              text,
              isError: result.isError,
            };
      });
    if (
      !message.toolUses.some(
        (tool) => actions.get(tool.tool_use_id) === 'drop_call',
      ) &&
      !(message.toolResults ?? []).some(
        (result) => actions.get(result.tool_use_id) === 'drop_call',
      ) &&
      toolUses.every((tool, index) => tool === message.toolUses[index]) &&
      toolResults.every(
        (result, index) => result === message.toolResults?.[index],
      )
    ) {
      kept.push(message);
      continue;
    }
    if (message.text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) {
      continue;
    }
    const rebuilt: Message = { role: message.role, text: message.text, toolUses };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    kept.push(rebuilt);
  }
  return kept;
}

/** Characters of text, tool input and tool output a message holds. */
export function messageChars(message: Message): number {
  let total = message.text.length;
  for (const tool of message.toolUses) {
    try {
      total += JSON.stringify(tool.input).length;
    } catch {
      total += 20;
    }
  }
  for (const result of message.toolResults ?? []) total += result.text.length;
  return total;
}

/** Estimated tokens of text, tool input and tool output a message holds. */
export function messageTokens(message: Message): number {
  let total = estimateTokens(message.text);
  for (const tool of message.toolUses) {
    let input = '';
    try {
      input = JSON.stringify(tool.input);
    } catch {
      input = '{}';
    }
    total += estimateTokens(input) + estimateTokens(tool.text ?? '');
  }
  for (const result of message.toolResults ?? []) total += estimateTokens(result.text);
  return total;
}

/** Estimated tokens a whole transcript holds. */
export function retainedTokens(messages: readonly Message[]): number {
  return messages.reduce((sum, message) => sum + messageTokens(message), 0);
}

/**
 * What one call costs the history now, and what it would cost after each
 * further escalation. Measured over the places the call actually appears (the
 * tool_use block, a separate tool_result block, or both), so the budget pass
 * needs no rebuild per step.
 */
type CallCost = { now: number; afterDropResult: number; afterDropCall: number };

function callCosts(
  messages: readonly Message[],
  headChars: number,
): Map<string, CallCost> {
  const costs = new Map<string, CallCost>();
  const add = (id: string, now: number, afterDropResult: number): void => {
    const prior = costs.get(id) ?? { now: 0, afterDropResult: 0, afterDropCall: 0 };
    prior.now += now;
    prior.afterDropResult += afterDropResult;
    costs.set(id, prior);
  };
  for (const message of messages) {
    for (const tool of message.toolUses) {
      let input = '{}';
      try {
        input = JSON.stringify(tool.input);
      } catch {
        input = '{}';
      }
      const body = tool.text ?? '';
      const inputTokens = estimateTokens(input);
      add(
        tool.tool_use_id,
        inputTokens + estimateTokens(body),
        inputTokens + estimateTokens(truncatedResultText(body, tool.isError ?? false, headChars)),
      );
    }
    for (const result of message.toolResults ?? []) {
      add(
        result.tool_use_id,
        estimateTokens(result.text),
        estimateTokens(truncatedResultText(result.text, result.isError ?? false, headChars)),
      );
    }
  }
  return costs;
}

/**
 * Holds the compacted history under `maxRetainedTokens`.
 *
 * Jev decides what is still needed, but it has no notion of a budget: in a long
 * conversation it keeps a little more every time, so the retained size ratchets
 * upwards (measured 2026-09-22 on one conversation: 57k -> 167k tokens over
 * eight compactions, the reduction falling 65% -> 10% while the cache rewrite
 * the next request pays grew 177k -> 500k tokens). This pass escalates the kept
 * calls oldest-first — first dropping their results, then the calls themselves —
 * until the estimate fits. Pinned calls (the first message and the newest
 * `preserveRecentMessages`) are never touched and prose is never rewritten, so
 * the floor is the pinned frame plus the conversation's own text.
 */
export function trimToBudget(
  messages: readonly Message[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  headChars: number,
  maxRetainedTokens: number,
): { decisions: CallDecision[]; trimmed: number } {
  const out = decisions.map((decision) => ({ ...decision }));
  if (maxRetainedTokens <= 0) return { decisions: out, trimmed: 0 };
  let estimate = retainedTokens(applyDecisions(messages, out, calls, headChars));
  if (estimate <= maxRetainedTokens) return { decisions: out, trimmed: 0 };

  const byId = new Map(calls.map((call) => [call.id, call]));
  const costs = callCosts(messages, headChars);
  const escalatable = out
    .filter((decision) => decision.reason !== 'pinned')
    .sort((a, b) => (byId.get(a.id)?.callIndex ?? 0) - (byId.get(b.id)?.callIndex ?? 0));

  let trimmed = 0;
  // Two ladders, oldest first: take the bodies of kept results, then the calls themselves.
  for (const stage of ['keep', 'drop_result'] as const) {
    for (const decision of escalatable) {
      if (estimate <= maxRetainedTokens) break;
      if (decision.action !== stage) continue;
      const cost = costs.get(byId.get(decision.id)?.tool_use_id ?? '');
      if (!cost) continue;
      if (stage === 'keep') {
        estimate -= Math.max(0, cost.now - cost.afterDropResult);
        decision.action = 'drop_result';
        decision.reason = 'result_dropped';
      } else {
        estimate -= Math.max(0, cost.afterDropResult - cost.afterDropCall);
        decision.action = 'drop_call';
        decision.reason = 'call_dropped';
      }
      trimmed += 1;
    }
    if (estimate <= maxRetainedTokens) break;
  }
  return { decisions: out, trimmed };
}

export function reductionRatio(result: Pick<CompactResult, 'stats'>): number {
  const { charsBefore, charsAfter } = result.stats;
  return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}

function count(decisions: readonly CallDecision[], reason: CallDecision['reason']): number {
  return decisions.filter((decision) => decision.reason === reason).length;
}

/**
 * Compacts a transcript by asking Jev, for every tool call outside the pinned
 * first and newest messages, whether the call and whether its result must
 * stay. The whole history (results omitted, fitted into `maxStateTokens`) is
 * sent as state with every batch of questions. Whatever Jev keeps is then held
 * under `maxRetainedTokens` by `trimToBudget`, so successive compactions of one
 * conversation cannot ratchet the retained size upwards. Throws when Jev fails
 * or the history cannot be fitted; the caller decides whether to fall back.
 */
export async function compact(
  messages: readonly Message[],
  asker: JevAsker,
  options: CompactOptions = {},
): Promise<CompactResult> {
  const started = Date.now();
  const resolved = resolveOptions(options);
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const candidates = calls.filter((call) => !call.pinned);
  const charsBefore = messages.reduce((sum, message) => sum + messageChars(message), 0);

  let fitted: { tokens: number; stage: string } = { tokens: 0, stage: '' };
  let batches: ToolCall[][] = [];
  const answers = new Map<string, CallAnswer>();
  if (candidates.length > 0) {
    const state = fitState(messages, calls, resolved);
    fitted = state;
    batches = batchCalls(candidates, state.tokens, resolved);
    const answered = await Promise.all(
      batches.map((batch) => askBatch(asker, state.state, batch)),
    );
    for (const map of answered) for (const [id, answer] of map) answers.set(id, answer);
  }

  const judged = calls.map((call) =>
    decideCall(call, answers.get(call.id) ?? { keepCall: 1, keepResult: 1 }, resolved),
  );
  // Jev says what is still needed; the budget says how much of it fits.
  const { decisions, trimmed } = trimToBudget(
    messages,
    judged,
    calls,
    resolved.truncateHeadChars,
    resolved.maxRetainedTokens,
  );
  const kept = applyDecisions(
    messages,
    decisions,
    calls,
    resolved.truncateHeadChars,
  );
  return {
    messages: kept,
    decisions,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: kept.length,
      charsBefore,
      charsAfter: kept.reduce((sum, message) => sum + messageChars(message), 0),
      calls: calls.length,
      kept: count(decisions, 'kept'),
      resultsDropped: count(decisions, 'result_dropped'),
      callsDropped: count(decisions, 'call_dropped'),
      pinned: count(decisions, 'pinned'),
      retainedTokens: retainedTokens(kept),
      retainedTarget: resolved.maxRetainedTokens,
      budgetTrimmed: trimmed,
      stateTokens: fitted.tokens,
      stateStage: fitted.stage,
      requests: batches.length,
      ms: Date.now() - started,
    },
  };
}
