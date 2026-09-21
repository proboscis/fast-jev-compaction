import { describe, expect, it } from 'vitest';
import { register } from '../hooks/fast-jev.ts';

type Handler = (dollar: unknown, event: unknown, next: (e: unknown) => unknown) => Promise<unknown>;

/** A fake host: an in-memory fs, a compact() that rejects until told otherwise, a big history. */
function host(compactRejectsFirst: number) {
  const files = new Map<string, string>();
  const logs: string[] = [];
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
    ui: { log: (t: string) => void logs.push(t), toast: () => undefined },
  };
  return { dollar, files, logs, compactCalls: () => compactCalls };
}

function wire() {
  const handlers = new Map<string, Handler>();
  register(((name: string, h: Handler) => void handlers.set(name, h)) as never, {
    stateDir: '/state',
    minColdTokens: 0,
    cacheTtlMinutes: 5,
  } as never);
  const next = (e: unknown) => e;
  const fire = (name: string, dollar: unknown) => handlers.get(name)!(dollar, {}, next);
  return { fire };
}

describe('cold compaction rejected before the first turn', () => {
  it('is retried once after the first turn, then not again', async () => {
    const h = host(1);
    const { fire } = wire();
    await fire('session.start', h.dollar);
    expect(h.compactCalls()).toBe(1);
    const journal1 = h.files.get('/state/journal.log') ?? '';
    expect(journal1).toContain('cache cold (no-state)');
    expect(journal1).toContain('rejected');

    await fire('turn.complete', h.dollar);
    expect(h.compactCalls()).toBe(2);
    const journal2 = h.files.get('/state/journal.log') ?? '';
    expect(journal2).toContain('retrying the cold compaction rejected before the first turn');
    expect(journal2).toContain('session.compact() for cold resolved');

    await fire('turn.complete', h.dollar);
    expect(h.compactCalls()).toBe(2);
  });

  it('does not retry when the start-time compaction was accepted', async () => {
    const h = host(0);
    const { fire } = wire();
    await fire('session.start', h.dollar);
    expect(h.compactCalls()).toBe(1);
    await fire('turn.complete', h.dollar);
    expect(h.compactCalls()).toBe(1);
  });

  it('gives up after one retry when the session stays headless (claude -p)', async () => {
    const h = host(99);
    const { fire } = wire();
    await fire('session.start', h.dollar);
    await fire('turn.complete', h.dollar);
    await fire('turn.complete', h.dollar);
    expect(h.compactCalls()).toBe(2);
  });
});
