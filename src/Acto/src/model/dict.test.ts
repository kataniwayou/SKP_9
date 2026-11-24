import { describe, expect, it } from 'vitest';
import { keyProblem, MAX_KEY_CHARS, MAX_VALUE_CHARS, parseDict, valueProblem } from './dict';

// BaseApi's rules since items became rows (2026-11-24, CacheRules): a bound on each key and each value, none on
// the dictionary as a whole.
describe('the per-entry bounds', () => {
  it('a key at the bound is kept and one over is refused', () => {
    expect(MAX_KEY_CHARS).toBe(256);
    expect(keyProblem('k'.repeat(MAX_KEY_CHARS), [])).toBeNull();
    expect(keyProblem('k'.repeat(MAX_KEY_CHARS + 1), [])).toBe(`Key must be at most ${MAX_KEY_CHARS} characters`);
  });

  it('a value at the bound is kept and one over is refused', () => {
    expect(MAX_VALUE_CHARS).toBe(1_048_576);
    expect(valueProblem('v'.repeat(MAX_VALUE_CHARS))).toBeNull();
    expect(valueProblem('v'.repeat(MAX_VALUE_CHARS + 1))).toBe(`Value must be at most ${MAX_VALUE_CHARS} characters`);
  });

  it('a dictionary larger than the old 1 MB whole-text cap parses', () => {
    const entries = Array.from({ length: 1_500 }, (_, i) => `"k${i}":"${'v'.repeat(1_000)}"`);
    const parsed = parseDict(`{${entries.join(',')}}`);
    expect(parsed.ok && parsed.entries.length).toBe(1_500);
  });
});
