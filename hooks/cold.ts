/**
 * Cache-cold compaction: the pure decisions.
 *
 * The prompt cache is keyed by account and model and expires after a TTL of
 * disuse. When the next model call will miss the cache anyway (new machine,
 * another profile, another model, or a gap longer than the TTL), rewriting the
 * history costs nothing extra, so that is the cheapest moment to compact.
 * Everything here is pure; `fast-jev.ts` owns the reads and writes.
 */

export type ColdState = {
  /** Wall-clock ms of the last model call this plugin saw. */
  at: number;
  /** `CLAUDE_CONFIG_DIR` of the process that made it (the account/profile). */
  configDir: string;
  /** The session's model at that time. */
  model: string;
};

export type ColdReason = 'no-state' | 'config-dir-changed' | 'model-changed' | 'ttl-expired';

/** Why the next call will miss the cache, or null when it should still hit. */
export function coldReason(prev: ColdState | null, now: ColdState, ttlMs: number): ColdReason | null {
  if (!prev) return 'no-state';
  if (prev.configDir !== now.configDir) return 'config-dir-changed';
  if (prev.model !== now.model) return 'model-changed';
  if (now.at - prev.at > ttlMs) return 'ttl-expired';
  return null;
}

/** Parses a state file; anything malformed reads as "no state". */
export function parseState(text: string | null | undefined): ColdState | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Partial<ColdState>;
    if (
      typeof value.at !== 'number' ||
      !Number.isFinite(value.at) ||
      typeof value.configDir !== 'string' ||
      typeof value.model !== 'string'
    ) {
      return null;
    }
    return { at: value.at, configDir: value.configDir, model: value.model };
  } catch {
    return null;
  }
}

export function serializeState(state: ColdState): string {
  return JSON.stringify(state);
}

/** Where a session's state lives: one small file per session id. */
export function statePath(stateDir: string, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${stateDir.replace(/\/+$/, '')}/${safe}.json`;
}

export type CompactionOrigin = 'cold' | 'threshold' | null;

/**
 * What to do when Jev could not remove enough. The built-in summary is lossy,
 * so it is only worth it when a person or the engine asked (`manual` / `auto`)
 * or the window is nearly full; a plugin-initiated compaction otherwise skips.
 */
export function lowReductionOutcome(
  trigger: string,
  origin: CompactionOrigin,
  percent: number,
  fallbackAtPercent: number,
): 'skip' | 'fallback' {
  if (trigger !== 'plugin') return 'fallback';
  if (origin === 'cold') return 'skip';
  return percent >= fallbackAtPercent ? 'fallback' : 'skip';
}

/**
 * After a threshold compaction was skipped at `skippedAtPercent`, retry only
 * once the context grew by `step` points, so an unprunable history does not
 * pay a Jev request every turn.
 */
export function thresholdDue(
  percent: number,
  compactAtPercent: number,
  skippedAtPercent: number | null,
  step: number = 10,
): boolean {
  if (percent < compactAtPercent) return false;
  if (skippedAtPercent === null) return true;
  return percent >= skippedAtPercent + step;
}
