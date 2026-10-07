import { describe, expect, it } from 'vitest';
import { EMPTY_DRAFT, type Draft } from './draft';
import { canRedo, canUndo, commit, HISTORY_DEPTH, historyOf, redo, undo } from './history';

const d = (n: number): Draft => ({ ...EMPTY_DRAFT, steps: { s: { x: n, y: 0 } } });

describe('design history', () => {
  it('undoes and redoes, and a new step clears redo', () => {
    let h = commit(commit(historyOf(), d(1)), d(2));
    h = undo(h);
    expect(h.draft).toEqual(d(1));
    expect(canRedo(h)).toBe(true);
    h = redo(h);
    expect(h.draft).toEqual(d(2));
    h = commit(undo(h), d(3));
    expect(canRedo(h)).toBe(false);
  });

  it('keeps 100 steps', () => {
    let h = historyOf();
    for (let i = 1; i <= HISTORY_DEPTH + 20; i++) h = commit(h, d(i));
    expect(h.past).toHaveLength(HISTORY_DEPTH);
  });

  it('merges a run of nudges into one step; anything else breaks the run', () => {
    let h = commit(commit(commit(historyOf(), d(1)), d(2), 'nudge'), d(3), 'nudge');
    expect(undo(h).draft).toEqual(d(1));
    h = commit(commit(h, d(4)), d(5), 'nudge');
    expect(undo(h).draft).toEqual(d(4));
  });

  it('a restored draft has nothing to undo (review focus 3)', () => {
    const h = historyOf(d(7));
    expect(canUndo(h)).toBe(false);
    expect(undo(h)).toBe(h);
  });
});
