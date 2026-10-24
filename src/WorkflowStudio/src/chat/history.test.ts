import { describe, expect, it } from 'vitest';
import { HISTORY_KEY, HISTORY_MAX, readHistory, stepHistory, withSent, writeHistory } from './history';

const memory = (): Storage => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(), key: () => null, get length() { return m.size; } };
};

describe('chat history', () => {
  it('↑ walks back from the draft to the oldest and stops there; ↓ walks forward to the draft and stops there', () => {
    expect(stepHistory(3, null, -1)).toEqual({ at: 2 });
    expect(stepHistory(3, 2, -1)).toEqual({ at: 1 });
    expect(stepHistory(3, 0, -1)).toBeNull();
    expect(stepHistory(3, 1, 1)).toEqual({ at: 2 });
    expect(stepHistory(3, 2, 1)).toEqual({ at: null });
    expect(stepHistory(3, null, 1)).toBeNull();
    expect(stepHistory(0, null, -1)).toBeNull();
  });

  it('keeps a message sent twice in a row once, and the newest HISTORY_MAX', () => {
    expect(withSent(['a', 'b'], 'b')).toEqual(['a', 'b']);
    expect(withSent(['a', 'b'], 'a')).toEqual(['a', 'b', 'a']);
    const full = Array.from({ length: HISTORY_MAX }, (_, i) => String(i));
    expect(withSent(full, 'new')).toEqual([...full.slice(1), 'new']);
  });

  it('is kept in the storage; junk there reads as none, and a storage that throws keeps nothing without failing', () => {
    const s = memory();
    writeHistory(['a', 'b'], s);
    expect(readHistory(s)).toEqual(['a', 'b']);
    s.setItem(HISTORY_KEY, '{not json');
    expect(readHistory(s)).toEqual([]);
    s.setItem(HISTORY_KEY, JSON.stringify(['a', 3, null, 'b']));
    expect(readHistory(s)).toEqual(['a', 'b']);
    const broken = { ...memory(), getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } } as Storage;
    expect(readHistory(broken)).toEqual([]);
    expect(() => writeHistory(['a'], broken)).not.toThrow();
  });
});
