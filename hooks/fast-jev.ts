import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { compact, reductionRatio, resolveOptions } from '../src/compact.js';
import {
  coldReason,
  lowReductionOutcome,
  parseState,
  serializeState,
  statePath,
  thresholdDue,
  type ColdState,
  type CompactionOrigin,
} from './cold.js';
import { buildJevRequest, DEFAULT_MODEL, parseJevResponse } from '../src/request.js';
import { estimateTokens } from '../src/state.js';
import type {
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  ToolResult,
  ToolUse,
} from '../src/types.js';

const HOOK_DEFAULTS = {
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  model: DEFAULT_MODEL,
  /** Compact when the next call will miss the prompt cache anyway. */
  coldCompaction: true,
  /** The prompt cache's TTL of disuse (5 minutes by default; 60 on accounts with the 1-hour cache). */
  cacheTtlMinutes: 5,
  /** Below this many estimated history tokens a cold compaction is not worth a Jev request. */
  minColdTokens: 20_000,
  /** A plugin-initiated compaction that removes too little falls back to the built-in summary only above this fill. */
  fallbackAtPercent: 85,
  /** Directory of the per-session state files; empty = `$HOME/.cache/fast-jev-compaction`. */
  stateDir: '',
};

export type HookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HookFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
};

/** The shape of `$.http.fetch`, so the hook can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

export type HookConfig = CompactOptions & {
  apiKey?: string;
  compactAtPercent: number;
  minReductionRatio: number;
  model: string;
  coldCompaction: boolean;
  cacheTtlMinutes: number;
  minColdTokens: number;
  fallbackAtPercent: number;
  stateDir: string;
};

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const numbers: Partial<Omit<CompactOptions, 'goal'>> = {};
  for (const key of [
    'keepThreshold',
    'preserveRecentMessages',
    'maxStateTokens',
    'maxRequestTokens',
    'truncateHeadChars',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  const config: HookConfig = {
    ...numbers,
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      HOOK_DEFAULTS.minReductionRatio,
    ),
    model: optionString(options, 'model') ?? HOOK_DEFAULTS.model,
    coldCompaction:
      typeof options['coldCompaction'] === 'boolean'
        ? (options['coldCompaction'] as boolean)
        : HOOK_DEFAULTS.coldCompaction,
    cacheTtlMinutes: optionNumber(options, 'cacheTtlMinutes', HOOK_DEFAULTS.cacheTtlMinutes),
    minColdTokens: optionNumber(options, 'minColdTokens', HOOK_DEFAULTS.minColdTokens),
    fallbackAtPercent: optionNumber(options, 'fallbackAtPercent', HOOK_DEFAULTS.fallbackAtPercent),
    stateDir: optionString(options, 'stateDir') ?? HOOK_DEFAULTS.stateDir,
  };
  const apiKey = optionString(options, 'apiKey');
  if (apiKey) config.apiKey = apiKey;
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  return config;
}

/** A `JevAsker` over the engine's `$.http.fetch`. */
export function jevAsker(fetchFn: HookFetch, apiKey: string, model: string): JevAsker {
  return {
    async ask(state, questions) {
      const request = buildJevRequest({ apiKey, model }, state, questions);
      const response = await fetchFn(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      return parseJevResponse(response.status, response.ok, response.text);
    },
  };
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: tool.input,
  };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return {
    tool_use_id: result.tool_use_id,
    text: result.text,
    isError: result.isError ?? false,
  };
}

/**
 * Maps the library's output back onto session messages. Whatever came back
 * unchanged (a message, a tool use, a tool result) is the engine's own object,
 * handle included; anything rebuilt is a fresh message without a handle, so the
 * engine takes the edited content instead of its original.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message, message);
    for (const tool of message.toolUses) uses.set(tool, tool);
    for (const result of message.toolResults ?? []) results.set(result, result);
  }
  return output.map((message) => {
    const own = messages.get(message);
    if (own) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) => results.get(result) ?? toolResultSummary(result),
      );
    }
    return rebuilt;
  });
}

export type SessionCompaction = {
  result: CompactResult;
  messages: SessionMessage[];
};

/** Runs the library over a session transcript; throws when the key is missing or Jev fails. */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fetchFn: HookFetch,
): Promise<SessionCompaction> {
  if (!config.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
  const result = await compact(messages, jevAsker(fetchFn, config.apiKey, config.model), config);
  return { result, messages: toSessionMessages(messages, result.messages) };
}

function percent0(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call_dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
  ].filter(Boolean);
  return `${percent0(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)`;
}

const UI_LOG_MAX_CHARS = 4096;

export function decisionLog(result: CompactResult): string {
  return result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map(
      (d) =>
        `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`,
    )
    .join(' ');
}

export function decisionLogLines(
  result: CompactResult,
  maxChars: number = UI_LOG_MAX_CHARS,
): string[] {
  const entries = decisionLog(result).split(' ').filter(Boolean);
  if (entries.length === 0) return ['decisions: (none)'];
  const chunks: string[] = [];
  let current = '';
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > maxChars - 24) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, index) =>
    chunks.length === 1
      ? `decisions: ${chunk}`
      : `decisions (${index + 1}/${chunks.length}): ${chunk}`,
  );
}

async function getApiKey(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  },
  config: HookConfig,
): Promise<string | undefined> {
  if (config.apiKey) return config.apiKey;
  const fromEnv = await $.env.get('TYPESAFE_API_KEY');
  if (fromEnv) return fromEnv;
  const settings = await $.settings.read();
  const env = settings['env'];
  if (env && typeof env === 'object') {
    const value = (env as Record<string, unknown>)['TYPESAFE_API_KEY'];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function notify(
  $: {
    ui: {
      log: (text: string) => void;
      toast: (text: string, options?: { timeoutMs?: number }) => void;
    };
  },
  text: string,
): void {
  $.ui.log(text);
  $.ui.toast(text, { timeoutMs: 15_000 });
}

/** Mutable per-process state of the hooks (one plugin instance per process). */
type Runtime = {
  config: HookConfig;
  compacting: boolean;
  /** Why this plugin asked for the compaction now running (null: not ours). */
  origin: CompactionOrigin;
  /** The fill at which a threshold compaction last skipped, to retry only after growth. */
  skippedAtPercent: number | null;
  /** Whether the "state dir not writable" line was already shown this session. */
  writeFailureNoted: boolean;
};

type SessionUsageOf = { session: { usage: () => Promise<{ context: { percent?: number } }> } };
type MessagesOf = { session: { messages: () => Promise<readonly SessionMessage[]> } };
type EnvOf = { env: { get: (name: string) => Promise<string | undefined> } };
type SessionIdOf = { session: { id: () => Promise<string>; model: () => Promise<string> } };
type FsOf = { fs: { read: (p: string) => Promise<string>; write: (p: string, t: string) => Promise<void> } };
type CompactOf = { session: { compact: () => Promise<unknown> }; ui: { log: (t: string) => void } };

/** Whether a `/compact` prompt asked for Jev pruning only (no summary fallback). */
export function jevOnly(instructions: string | undefined): boolean {
  return /\bfast-jev-only\b/.test(instructions ?? '');
}

async function contextPercent($: SessionUsageOf): Promise<number> {
  const { context } = await $.session.usage();
  return context.percent ?? 0;
}

/** The history's size as Jev's tokenizer would roughly count it (usage is empty before the first call). */
async function historyTokens($: MessagesOf): Promise<number> {
  const messages = await $.session.messages();
  return messages.reduce((sum, m) => {
    const results = (m.toolResults ?? []).reduce((r, x) => r + estimateTokens(x.text ?? ''), 0);
    const uses = m.toolUses.reduce((r, x) => r + estimateTokens(JSON.stringify(x.input ?? {})), 0);
    return sum + estimateTokens(m.text ?? '') + results + uses;
  }, 0);
}

/** A small journal beside the state files, since `$.ui.log` is invisible under `-p`. */
async function journal($: EnvOf & FsOf & UiLogOf, runtime: Runtime, line: string): Promise<void> {
  try {
    const dir = runtime.config.stateDir || `${(await $.env.get('HOME')) ?? '/tmp'}/.cache/fast-jev-compaction`;
    const path = `${dir.replace(/\/+$/, '')}/journal.log`;
    let prior = '';
    try {
      prior = await $.fs.read(path);
    } catch {
      prior = '';
    }
    const lines = prior.split('\n').filter(Boolean).slice(-400);
    lines.push(`${new Date().toISOString()} ${line}`);
    await $.fs.write(path, `${lines.join('\n')}\n`);
  } catch (error) {
    /* journaling never blocks a turn, but a silent failure hides the cold-start state; say it once */
    noteWriteFailure($, runtime, 'journal', error);
  }
}

type UiLogOf = { ui: { log: (line: string) => void } };

/** Says once per session that the state dir is not writable (otherwise every start reads "cold"). */
function noteWriteFailure($: UiLogOf, runtime: Runtime, what: string, error: unknown): void {
  if (runtime.writeFailureNoted) return;
  runtime.writeFailureNoted = true;
  const text = error instanceof Error ? error.message : String(error);
  $.ui.log(`fast-jev-compaction: ${what} write failed (${text}); cold-start state will not persist`);
}

async function stateFile($: EnvOf & SessionIdOf, runtime: Runtime): Promise<string> {
  const dir =
    runtime.config.stateDir || `${(await $.env.get('HOME')) ?? '/tmp'}/.cache/fast-jev-compaction`;
  return statePath(dir, await $.session.id());
}

async function nowState($: EnvOf & SessionIdOf): Promise<ColdState> {
  return {
    at: Date.now(),
    configDir: (await $.env.get('CLAUDE_CONFIG_DIR')) ?? '',
    model: await $.session.model(),
  };
}

async function readState($: EnvOf & SessionIdOf & FsOf, runtime: Runtime): Promise<ColdState | null> {
  try {
    return parseState(await $.fs.read(await stateFile($, runtime)));
  } catch {
    return null;
  }
}

async function writeState($: EnvOf & SessionIdOf & FsOf & UiLogOf, runtime: Runtime): Promise<void> {
  try {
    await $.fs.write(await stateFile($, runtime), serializeState(await nowState($)));
  } catch (error) {
    /* a state that cannot be written only means the next start reads "cold" */
    noteWriteFailure($, runtime, 'state', error);
  }
}

/** Runs one plugin-initiated compaction; `runtime.origin` tells the compact hook whose it is. */
async function requestCompaction(
  $: CompactOf & EnvOf & FsOf,
  runtime: Runtime,
  why: CompactionOrigin,
): Promise<boolean> {
  if (runtime.compacting) return false;
  runtime.compacting = true;
  runtime.origin = why;
  try {
    const outcome = await $.session.compact();
    await journal($, runtime, `session.compact() for ${why} resolved: ${JSON.stringify(outcome).slice(0, 300)}`);
    return true;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    $.ui.log(`compaction skipped (${text})`);
    await journal($, runtime, `session.compact() for ${why} rejected: ${text}`);
    return false;
  } finally {
    runtime.compacting = false;
    runtime.origin = null;
  }
}

/** Before a model call: compact if the prompt cache will miss anyway. */
async function coldCheck(
  $: EnvOf & SessionIdOf & FsOf & CompactOf & MessagesOf,
  runtime: Runtime,
  when: string,
): Promise<void> {
  if (!runtime.config.coldCompaction) return;
  const prev = await readState($, runtime);
  const now = await nowState($);
  const reason = coldReason(prev, now, runtime.config.cacheTtlMinutes * 60_000);
  if (!reason) return;
  const tokens = await historyTokens($);
  if (tokens < runtime.config.minColdTokens) {
    await journal($, runtime, `${when}: cache cold (${reason}) but history ~${tokens} tokens < ${runtime.config.minColdTokens}; not compacting`);
    await writeState($, runtime);
    return;
  }
  const line = `${when}: cache cold (${reason}), history ~${tokens} tokens: compacting`;
  $.ui.log(line);
  await journal($, runtime, line);
  // A rejected compaction (the engine counts a session started with an initial prompt as
  // headless until its first turn) leaves the state alone: the next check point still reads
  // cold and tries again before the first model call, instead of paying the cache write.
  if (await requestCompaction($, runtime, 'cold')) await writeState($, runtime);
}

export const register: Register = (on: On, options: PluginOptions) => {
  const runtime: Runtime = {
    config: resolveHookConfig(options),
    compacting: false,
    origin: null,
    skippedAtPercent: null,
    writeFailureNoted: false,
  };

  on('session.compact', async ($, event, next) => {
    // `/compact fast-jev-only` (a worker that knows the cache is cold): never fall back to the summary.
    const mine: CompactionOrigin = runtime.origin ?? (jevOnly(event.instructions) ? 'cold' : null);
    await journal($, runtime, `session.compact hook: trigger=${event.trigger} origin=${mine ?? 'none'} messages=${event.messages.length}`);
    try {
      const config = { ...runtime.config, apiKey: await getApiKey($, runtime.config) };
      const { result, messages } = await compactSession(event.messages, config, async (url, init) => {
        const response = await $.http.fetch(url, init);
        return { status: response.status, ok: response.ok, text: response.text };
      });
      for (const line of decisionLogLines(result)) $.ui.log(line);
      if (reductionRatio(result) < config.minReductionRatio) {
        const percent = await contextPercent($);
        const outcome = lowReductionOutcome(event.trigger, mine, percent, config.fallbackAtPercent);
        if (outcome === 'skip') {
          if (mine === 'threshold') runtime.skippedAtPercent = percent;
          notify($, `skipped (below ${percent0(config.minReductionRatio)} minimum: ${summarize(result)})`);
          await journal($, runtime, `compact(${event.trigger}${mine ? `/${mine}` : ''}): skipped, ${summarize(result)}`);
          return { skip: 'fast-jev-compaction: too little to remove' };
        }
        notify(
          $,
          `fallback to built-in summary (below ${percent0(config.minReductionRatio)} minimum: ${summarize(result)})`,
        );
        return next(event);
      }
      runtime.skippedAtPercent = null;
      const kept = `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result)})`;
      notify($, kept);
      await journal($, runtime, `compact(${event.trigger}${mine ? `/${mine}` : ''}): ${kept}`);
      return { messages };
    } catch (error) {
      await journal($, runtime, `compact(${event.trigger}${mine ? `/${mine}` : ''}): error ${error instanceof Error ? error.message : String(error)}`);
      if (mine === 'cold') {
        notify($, `skipped (${error instanceof Error ? error.message : String(error)})`);
        return { skip: 'fast-jev-compaction: unavailable' };
      }
      notify(
        $,
        `fallback to built-in summary (${error instanceof Error ? error.message : String(error)})`,
      );
      return next(event);
    }
  });

  on('session.start', async ($, event, next) => {
    try {
      await coldCheck($, runtime, 'session.start');
    } catch (error) {
      $.ui.log(`cold check skipped (${error instanceof Error ? error.message : String(error)})`);
    }
    return next(event);
  });

  on('prompt.submit', async ($, event, next) => {
    try {
      await coldCheck($, runtime, 'prompt.submit');
    } catch (error) {
      $.ui.log(`cold check skipped (${error instanceof Error ? error.message : String(error)})`);
    }
    return next(event);
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    await writeState($, runtime);
    if (runtime.compacting) return next(event);
    try {
      const percent = await contextPercent($);
      if (!thresholdDue(percent, runtime.config.compactAtPercent, runtime.skippedAtPercent)) return next(event);
      await requestCompaction($, runtime, 'threshold');
      await writeState($, runtime);
    } catch (error) {
      $.ui.log(
        `auto-compact skipped (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    return next(event);
  });
};
