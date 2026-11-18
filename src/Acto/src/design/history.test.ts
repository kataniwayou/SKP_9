import { describe, expect, it } from 'vitest';
import { canRedo, canUndo, commit, historyOf, redo, undo } from './history';

interface S { n: string }
const s0: S = { n: 'zero' };
const s1: S = { n: 'one' };
const s2: S = { n: 'two' };

describe('history', () => {
  it('merges typing into one step and caps depth', () => {
    let h = historyOf(s0);
    h = commit(h, s1, 'name:a'); h = commit(h, s2, 'name:a');
    expect(h.past).toEqual([s0]); expect(undo(h).present).toBe(s0);
    for (let i = 0; i < 120; i++) h = commit(h, { n: String(i) });
    expect(h.past.length).toBe(100);
  });
  it('undoes, redoes and drops the future on a new commit', () => {
    let h = commit(commit(historyOf(s0), s1), s2);
    h = undo(h);
    expect(h.present).toBe(s1); expect(canRedo(h)).toBe(true);
    expect(redo(h).present).toBe(s2);
    h = commit(h, { n: 'x' });
    expect(canRedo(h)).toBe(false); expect(canUndo(historyOf(s0))).toBe(false);
  });
  it('does not merge across a different key', () => {
    let h = commit(historyOf(s0), s1, 'k');
    h = commit(h, s2, 'other');
    expect(h.past).toEqual([s0, s1]);
  });
});
