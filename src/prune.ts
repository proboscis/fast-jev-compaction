import { isPinned } from './state.js';
import type { Message, MessageDecision, ResolvedCompactOptions } from './types.js';

/**
 * Three bodies a history carries that are dead weight by rule, not by
 * judgement, so Jev is never asked about them.
 *
 * Measured 2026-09-22 on a live 209k-token history the plugin could not shrink:
 * 87% of what it had to keep was user message bodies, and one 10,813-character
 * bundle of deliveries sat in it 13 times with an identical body. Old
 * compaction summaries stay in the same way: a summary is delivered as a user
 * message, so every earlier one survives the next compaction unchanged.
 *
 * Nothing here rewrites a body. A removed one leaves a one-line note in its
 * place, so the turn structure, the role order, and any tool blocks the message
 * carries are untouched.
 */

/** The first words of a Claude Code compaction summary, delivered as a user message. */
export const SUMMARY_PREFIX = 'This session is being continued from a previous conversation';

/**
 * Ids as a delivery spells them: the sender of an `[agmsg from <who>]` header
 * (the shape 3,234 deliveries of the measured history used) and any ledger id
 * (`lt-`, `ob-`, `dav-`, `msg-`) the body names.
 */
const DELIVERY_ID =
  /\[agmsg (?:from )?([A-Za-z0-9][A-Za-z0-9_-]{2,})\]|\b((?:lt|ob|dav|msg)-[A-Za-z0-9]{4,})\b/g;

/**
 * Below this many characters a repeated body is left alone: a short turn
 * ("go ahead", "Continue from where you left off.") is a real turn of the
 * conversation, and removing it saves nothing worth the change in meaning.
 */
export const DEDUPE_MIN_CHARS = 200;

/** How many ids a note names before it counts the rest. */
const NOTE_IDS = 4;

/** Whether a user body is a compaction summary the engine wrote. */
export function isCompactionSummary(text: string): boolean {
  return text.trimStart().startsWith(SUMMARY_PREFIX);
}

/** Every id a delivery names, in order, without repeats. */
export function deliveryIds(text: string): string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(DELIVERY_ID)) {
    const id = match[1] ?? match[2];
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function repeatedNote(chars: number): string {
  return `[fast-jev-compaction removed a repeated delivery of ${chars} chars; the same body is delivered again later in this history]`;
}

function summaryNote(chars: number): string {
  return `[fast-jev-compaction removed a superseded compaction summary of ${chars} chars; the newest summary is kept]`;
}

function resolvedNote(chars: number, ids: readonly string[]): string {
  const named = ids.slice(0, NOTE_IDS).join(', ');
  const rest = ids.length > NOTE_IDS ? `, +${ids.length - NOTE_IDS} more` : '';
  return `[fast-jev-compaction removed a delivery of ${chars} chars; every item it names (${named}${rest}) is answered per the resolved-ids command]`;
}

type PruneOptions = Pick<
  ResolvedCompactOptions,
  'preserveRecentMessages' | 'dedupeRepeatedUserText' | 'dropSupersededSummaries' | 'resolvedIds'
>;

/**
 * Decides which user bodies the rules remove. Pinned messages (the first and
 * the newest `preserveRecentMessages`) and assistant messages are never
 * candidates, and a message gets at most one decision.
 */
export function planMessagePrune(
  messages: readonly Message[],
  options: PruneOptions,
): MessageDecision[] {
  const total = messages.length;
  const candidate = (index: number): boolean => {
    const message = messages[index];
    if (!message) return false;
    return (
      message.role === 'user' &&
      message.text.trim().length > 0 &&
      !isPinned(index, total, options.preserveRecentMessages)
    );
  };
  const decided = new Map<number, MessageDecision>();

  // Compaction summaries: the newest one in the whole history stays, whether or
  // not it is pinned; every earlier one is a summary of a summary.
  if (options.dropSupersededSummaries) {
    const summaries: number[] = [];
    messages.forEach((message, index) => {
      if (message.role === 'user' && isCompactionSummary(message.text)) summaries.push(index);
    });
    for (const index of summaries.slice(0, -1)) {
      if (!candidate(index)) continue;
      const chars = messages[index]!.text.length;
      decided.set(index, { index, reason: 'superseded_summary', chars, note: summaryNote(chars) });
    }
  }

  // Answered deliveries: only when the ledger answered every id the body names,
  // so a bundle holding one unanswered letter stays whole.
  const resolved = new Set(options.resolvedIds);
  if (resolved.size > 0) {
    messages.forEach((message, index) => {
      if (!candidate(index) || decided.has(index)) return;
      const ids = deliveryIds(message.text);
      if (ids.length === 0 || !ids.every((id) => resolved.has(id))) return;
      const chars = message.text.length;
      decided.set(index, { index, reason: 'resolved_ids', chars, note: resolvedNote(chars, ids) });
    });
  }

  // Re-deliveries: the newest copy of a body stays, the earlier ones go.
  if (options.dedupeRepeatedUserText) {
    const newest = new Map<string, number>();
    messages.forEach((message, index) => {
      if (message.role !== 'user') return;
      const key = message.text.trim();
      if (key.length >= DEDUPE_MIN_CHARS) newest.set(key, index);
    });
    messages.forEach((message, index) => {
      if (!candidate(index) || decided.has(index)) return;
      const key = message.text.trim();
      if (key.length < DEDUPE_MIN_CHARS) return;
      const last = newest.get(key);
      if (last === undefined || last === index) return;
      const chars = message.text.length;
      decided.set(index, { index, reason: 'repeated_user_text', chars, note: repeatedNote(chars) });
    });
  }

  return [...decided.values()].sort((a, b) => a.index - b.index);
}

/** How many decisions carry one reason. */
export function countPruned(
  decisions: readonly MessageDecision[],
  reason: MessageDecision['reason'],
): number {
  return decisions.filter((decision) => decision.reason === reason).length;
}

/** Characters of user text the decisions remove, minus the notes they leave. */
export function prunedChars(decisions: readonly MessageDecision[]): number {
  return decisions.reduce(
    (sum, decision) => sum + Math.max(0, decision.chars - decision.note.length),
    0,
  );
}
