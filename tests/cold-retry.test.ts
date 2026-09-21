import { describe, expect, it } from 'vitest';
import { register } from '../hooks/fast-jev.ts';

type Handler = (dollar: unknown, event: unknown, next: (e: unknown) => unknown) => Promise<unknown>;

/** A fake host: an in-memory fs, a compact() that rejects the first N calls, a big history. */
function host(compactRejectsFirst: number) {
  const files = new Map<string, string>();
  let compactCalls = 0;
  const dollar = {
    env: { get: async (name: string) => ({ HOME: '/h', CLAUDE_CONFIG_DIR: '/h/.config/claude-a' })[name] },
    fs: {
      read: async (p: string) => {
        if (!files.has(p)) throw new Error('ENOENT');
        return files.get(p)!;
      },
      write: async (p: string, t: string) => void files.set(p, t),
    },
    session: {
      id: async () => 'sess-1',
      model: async () => 'claude-sonnet-5',
      messages: async () => [{ role: 'user', text: 'x'.repeat(200_000), toolUses: [] }],
      usage: async () => ({ context: { percent: 10 } }),
      compact: async () => {
        compactCalls += 1;
        if (compactCalls <= compactRejectsFirst) {
          throw new Error('$.session.compact: not available in a headless (-p / SDK) session yet');
        }
        return { ok: true };
      },
    },
    ui: { log: () => undefined, toast: () => undefined },
  };
  return { dollar, files, compactCalls: () => compactCalls };
}

function wire() {
  const handlers = new Map<string, Handler>();
  register(((name: string, h: Handler) => void handlers.set(name, h)) as never, {
    stateDir: '/state',
    minColdTokens: 0,
    cacheTtlMinutes: 5,
  } as never);
  const next = (e: unknown) => e;
  return { fire: (name: string, dollar: unknown) => handlers.get(name)!(dollar, {}, next) };
}

const STATE = '/state/sess-1.json';

describe('a cold compaction the engine rejects at session.start', () => {
  it('leaves the state unwritten, so prompt.submit still reads cold and compacts before the model call', async () => {
    const h = host(1);
    const { fire } = wire();
    await fire('session.start', h.dollar);
    expect(h.compactCalls()).toBe(1);
    expect(h.files.has(STATE)).toBe(false);
    expect(h.files.get('/state/journal.log')).toContain('session.compact() for cold rejected');

    await fire('prompt.submit', h.dollar);
    expect(h.compactCalls()).toBe(2);
    expect(h.files.has(STATE)).toBe(true);
    expect(h.files.get('/state/journal.log')).toContain('prompt.submit: cache cold (no-state)');
  });

  it('is not retried after a turn: the cache write has happened by then', async () => {
    const h = host(99);
    const { fire } = wire();
    await fire('session.start', h.dollar);
    await fire('turn.complete', h.dollar);
    await fire('turn.complete', h.dollar);
    expect(h.compactCalls()).toBe(1);
    expect(h.files.has(STATE)).toBe(true); // turn.complete records the now-warm cache
  });

  it('writes the state once the start-time compaction is accepted', async () => {
    const h = host(0);
    const { fire } = wire();
    await fire('session.start', h.dollar);
    expect(h.compactCalls()).toBe(1);
    expect(h.files.has(STATE)).toBe(true);
    await fire('prompt.submit', h.dollar);
    expect(h.compactCalls()).toBe(1);
  });
});

describe('/compact fast-jev-if-cold', () => {
  it('leaves a warm session untouched and prunes a cold one', async () => {
    const { jevIfCold, jevOnly } = await import('../hooks/fast-jev.ts');
    expect(jevIfCold('fast-jev-if-cold')).toBe(true);
    expect(jevOnly('fast-jev-if-cold')).toBe(true);
    expect(jevIfCold('fast-jev-only')).toBe(false);

    const h = host(0);
    const handlers = new Map<string, Handler>();
    register(((name: string, h2: Handler) => void handlers.set(name, h2)) as never, {
      stateDir: '/state', minColdTokens: 0, cacheTtlMinutes: 5,
    } as never);
    const compactEvent = { trigger: 'manual', instructions: 'fast-jev-if-cold', messages: [] };
    let fellThrough = 0;
    const next = (e: unknown) => { fellThrough += 1; return e; };
    // warm: the state was written a moment ago by this profile and model
    h.files.set(STATE, JSON.stringify({ at: Date.now(), configDir: '/h/.config/claude-a', model: 'claude-sonnet-5' }));
    const warm = (await handlers.get('session.compact')!(h.dollar, compactEvent, next)) as { skip?: string };
    expect(warm.skip).toContain('warm');
    expect(fellThrough).toBe(0);
    // cold: the state is older than the TTL
    h.files.set(STATE, JSON.stringify({ at: Date.now() - 10 * 60_000, configDir: '/h/.config/claude-a', model: 'claude-sonnet-5' }));
    const cold = (await handlers.get('session.compact')!(h.dollar, compactEvent, next)) as { skip?: string };
    // nothing to prune in an empty transcript, but the verdict went the pruning way (no fallback to a summary)
    expect(cold.skip).not.toContain('warm');
    expect(fellThrough).toBe(0);
    expect(h.files.get('/state/journal.log')).toContain('compact(if-cold): cache cold (ttl-expired)');
  });
});

describe('apiKeyFile', () => {
  it('reads the key from the configured file before the environment', async () => {
    const { resolveHookConfig, getApiKeyForTest } = await import('../hooks/fast-jev.ts');
    const config = resolveHookConfig({ apiKeyFile: '/run/secret/key' } as never);
    expect(config.apiKeyFile).toBe('/run/secret/key');
    const dollar = {
      env: { get: async () => 'from-env' },
      settings: { read: async () => ({}) },
      fs: { read: async (p: string) => (p === '/run/secret/key' ? 'from-file\n' : '') },
    };
    expect(await getApiKeyForTest(dollar as never, config)).toBe('from-file');
    expect(await getApiKeyForTest(dollar as never, resolveHookConfig({} as never))).toBe('from-env');
  });
});
