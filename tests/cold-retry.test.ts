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
