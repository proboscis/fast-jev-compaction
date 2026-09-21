import { describe, expect, it } from 'vitest';
import { jevOnly } from '../hooks/fast-jev.ts';
import {
  coldReason,
  lowReductionOutcome,
  parseState,
  serializeState,
  statePath,
  thresholdDue,
  type ColdState,
} from '../hooks/cold.ts';

const TTL = 5 * 60_000;
const base: ColdState = { at: 1_000_000, configDir: '/home/u/.config/claude-a', model: 'claude-sonnet-5' };

describe('coldReason', () => {
  it('is cold with no prior state (new machine or first start)', () => {
    expect(coldReason(null, base, TTL)).toBe('no-state');
  });
  it('is cold when the profile (config dir) changed', () => {
    expect(coldReason(base, { ...base, at: base.at + 1000, configDir: '/home/u/.config/claude-b' }, TTL)).toBe(
      'config-dir-changed',
    );
  });
  it('is cold when the model changed', () => {
    expect(coldReason(base, { ...base, at: base.at + 1000, model: 'claude-opus-5' }, TTL)).toBe('model-changed');
  });
  it('is cold after the TTL elapsed, warm just inside it', () => {
    expect(coldReason(base, { ...base, at: base.at + TTL + 1 }, TTL)).toBe('ttl-expired');
    expect(coldReason(base, { ...base, at: base.at + TTL }, TTL)).toBeNull();
    expect(coldReason(base, { ...base, at: base.at + 1 }, TTL)).toBeNull();
  });
  it('does not treat a clock that went backwards as expired', () => {
    expect(coldReason(base, { ...base, at: base.at - 10_000 }, TTL)).toBeNull();
  });
});

describe('state file', () => {
  it('round-trips through serialize/parse', () => {
    expect(parseState(serializeState(base))).toEqual(base);
  });
  it('reads malformed or partial text as no state', () => {
    expect(parseState('')).toBeNull();
    expect(parseState(null)).toBeNull();
    expect(parseState('{')).toBeNull();
    expect(parseState(JSON.stringify({ at: 'x', configDir: '', model: '' }))).toBeNull();
    expect(parseState(JSON.stringify({ at: 1, configDir: '' }))).toBeNull();
  });
  it('keeps the session id file-safe', () => {
    expect(statePath('/tmp/s/', 'ab/../c d')).toBe('/tmp/s/ab_.._c_d.json');
  });
});

describe('lowReductionOutcome', () => {
  it('keeps the built-in summary for manual and auto compactions', () => {
    expect(lowReductionOutcome('manual', null, 10, 85)).toBe('fallback');
    expect(lowReductionOutcome('auto', null, 95, 85)).toBe('fallback');
  });
  it('never summarizes for a cache-cold compaction', () => {
    expect(lowReductionOutcome('plugin', 'cold', 99, 85)).toBe('skip');
  });
  it('summarizes for a threshold compaction only when the window is nearly full', () => {
    expect(lowReductionOutcome('plugin', 'threshold', 70, 85)).toBe('skip');
    expect(lowReductionOutcome('plugin', 'threshold', 85, 85)).toBe('fallback');
  });
});

describe('thresholdDue', () => {
  it('fires at the threshold when nothing was skipped', () => {
    expect(thresholdDue(59, 60, null)).toBe(false);
    expect(thresholdDue(60, 60, null)).toBe(true);
  });
  it('after a skip, waits for the context to grow by the step', () => {
    expect(thresholdDue(65, 60, 62)).toBe(false);
    expect(thresholdDue(71, 60, 62)).toBe(false);
    expect(thresholdDue(72, 60, 62)).toBe(true);
  });
});

describe('jevOnly', () => {
  it('recognises the marker word in /compact instructions', () => {
    expect(jevOnly('fast-jev-only')).toBe(true);
    expect(jevOnly('keep the plan; fast-jev-only please')).toBe(true);
    expect(jevOnly('keep the plan')).toBe(false);
    expect(jevOnly(undefined)).toBe(false);
  });
});
