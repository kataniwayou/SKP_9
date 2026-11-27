import { describe, it, expect } from 'vitest';
import { pageView, pageSummary, summaryText, readAt, readLimit, shownPage, windowOf, type PageRead } from './itemsPage';

const st = (...ks: string[]) => ks.map((k, i) => ({ key: k, value: String(i + 1) }));
const keys = (rows: { key: string }[]) => rows.map((r) => r.key);
// a middle page: from '0' (before 'a') to the end-exclusive 'zz'
const mid = { lower: '0', upper: 'zz' };
const open = { lower: null, upper: null };

describe('pageView', () => {
  it('marksModifiedAddedDeleted', () => {
    const { rows, cut } = pageView(st('a', 'b', 'c'), { set: { b: '9', bb: 'x' }, removed: ['c'] }, mid, 10);
    expect(rows.map((r) => [r.key, r.state])).toEqual([['a', undefined], ['b', 'modified'], ['bb', 'added'], ['c', 'deleted']]);
    expect(rows[1].stored).toBe('2');
    expect(rows[1].value).toBe('9');
    expect(rows[2].stored).toBeNull();
    expect(cut).toBe(false);
  });
  it('sameValueIsUnchanged and deleted wins', () => {
    const { rows } = pageView(st('a', 'b'), { set: { a: '1', b: '7' }, removed: ['b'] }, mid, 10);
    expect(rows[0].state).toBeUndefined();
    expect(rows[1].state).toBe('deleted');
    expect(rows[1].value).toBe('2');
  });
  it('addedOutsideTheRangeIsNotShown: lower inclusive, upper exclusive', () => {
    const e = { set: { a: '1', l: '2', m: '3', p: '4', z: '5' }, removed: [] };
    expect(keys(pageView(st('n', 'o'), e, { lower: 'l', upper: 'p' }, 10).rows)).toEqual(['l', 'm', 'n', 'o']);
  });
  it('anUnboundedEndShowsEverythingPastTheOtherBound', () => {
    const e = { set: { a: '1', z: '2' }, removed: [] };
    expect(keys(pageView(st('m', 'n'), e, { lower: null, upper: 'p' }, 10).rows)).toEqual(['a', 'm', 'n']);
    expect(keys(pageView(st('m', 'n'), e, { lower: 'm', upper: null }, 10).rows)).toEqual(['m', 'n', 'z']);
    expect(keys(pageView([], e, open, 10).rows)).toEqual(['a', 'z']);
  });
  it('cutsTheTail: cutAt is the first cut row', () => {
    const { rows, cut, cutAt } = pageView(st('a', 'c', 'e'), { set: { b: '1', d: '2' }, removed: [] }, mid, 4);
    expect(keys(rows)).toEqual(['a', 'b', 'c', 'd']);
    expect(cut).toBe(true);
    expect(cutAt).toBe('e');
  });
  it('cutsTheHead: cutAt is the first remaining row', () => {
    const { rows, cut, cutAt } = pageView(st('a', 'c', 'e'), { set: { b: '1', d: '2' }, removed: [] }, mid, 3, 'head');
    expect(keys(rows)).toEqual(['c', 'd', 'e']);
    expect(cut).toBe(true);
    expect(cutAt).toBe('c');
  });
});

describe('server order', () => {
  it('storedOrderIsKeptAsReceived', () => {
    const { rows } = pageView(st('ab', 'a-b'), { set: {}, removed: [] }, open, 10);
    expect(keys(rows)).toEqual(['ab', 'a-b']);
  });
  it('aKeyEqualToAStoredKeyIsModifiedNotAdded', () => {
    const { rows } = pageView(st('a', 'b'), { set: { b: 'new' }, removed: [] }, mid, 10);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ key: 'b', state: 'modified', stored: '2', value: 'new' });
  });
});

/** BaseApi over sorted `all`: from / after / before with a limit, index, next, fromMatch. */
function serve(all: string[], at: ReturnType<typeof readAt>, limit: number) {
  let start = 0;
  let end: number;
  let fromMatch: string | null = null;
  if (at && 'before' in at) {
    const i = all.findIndex((k) => k >= at.before);
    end = i < 0 ? all.length : i;
    start = Math.max(0, end - limit);
  } else {
    if (at && 'after' in at) { const i = all.findIndex((k) => k > at.after); start = i < 0 ? all.length : i; }
    if (at && 'from' in at) {
      const i = all.findIndex((k) => k >= at.from);
      if (i < 0) { fromMatch = 'none'; start = Math.max(0, all.length - limit); } else { start = i; fromMatch = all[i] === at.from ? 'exact' : 'later'; }
    }
    end = Math.min(all.length, start + limit);
  }
  const items = all.slice(start, end).map((k) => ({ key: k, value: k }));
  return { items, index: start, next: end < all.length && items.length ? items[items.length - 1].key : null, fromMatch };
}

describe('windows and tiling', () => {
  it('aForwardReadKeepsTheExtraRowAsUpper', () => {
    expect(readLimit(3)).toBe(4);
    const w = windowOf({ dir: 'forward', from: null }, 3, serve(['a', 'b', 'c', 'd', 'e'], null, 4));
    expect(w).toMatchObject({ lower: null, upper: 'd', upperAfter: false, index: 0, cut: 'tail' });
    expect(keys(w.stored)).toEqual(['a', 'b', 'c']);
  });
  it('aBudgetCutForwardReadEndsAfterItsLastRow', () => {
    // fewer than limit+1 rows but next set: the character budget cut the page
    const w = windowOf({ dir: 'forward', from: 'b' }, 3, { items: [{ key: 'b', value: '' }], index: 1, next: 'b' });
    expect(w).toMatchObject({ lower: 'b', upper: 'b', upperAfter: true });
    expect(readAt({ dir: 'forward', from: w.upper, after: w.upperAfter })).toEqual({ after: 'b' });
  });
  it('aBudgetEdgeKeyWithAPendingEditShowsOnce', () => {
    // page 1 ends at 'b' (budget cut, upperAfter); 'b' has a pending modify and is shown there as modified
    const edits = { set: { b: 'B2' }, removed: [] };
    const w1 = windowOf({ dir: 'forward', from: null }, 3, { items: [{ key: 'a', value: '1' }, { key: 'b', value: '2' }], index: 0, next: 'b' });
    const p1 = shownPage(w1, edits, 3);
    expect(p1.rows.map((r) => [r.key, r.state])).toEqual([['a', undefined], ['b', 'modified']]);
    expect(p1).toMatchObject({ upper: 'b', upperAfter: true });
    // the next page reads after 'b': its lower is 'b' exclusive, so 'b' is not shown again as added
    const w2 = windowOf({ dir: 'forward', from: p1.upper, after: p1.upperAfter }, 3, { items: [{ key: 'c', value: '3' }], index: 2, next: null });
    const p2 = shownPage(w2, edits, 3);
    expect(keys(p2.rows)).toEqual(['c']);
  });
  it('aBackReadDropsTheExtraEarliestRow', () => {
    const w = windowOf({ dir: 'back', before: 'f' }, 3, serve(['a', 'b', 'c', 'd', 'e', 'f'], { before: 'f' }, 4));
    expect(w).toMatchObject({ lower: 'c', upper: 'f', index: 2, cut: 'head' });
    expect(keys(w.stored)).toEqual(['c', 'd', 'e']);
    const start = windowOf({ dir: 'back', before: 'c' }, 3, serve(['a', 'b', 'c'], { before: 'c' }, 4));
    expect(start).toMatchObject({ lower: null, upper: 'c', index: 0, cut: 'head' });
  });
  it('aBudgetCutBackReadUsesTheIndexNotTheRowCount', () => {
    // the budget dropped the far-end (earliest) rows: fewer than limit+1, but index > 0, so this is not the start
    const w = windowOf({ dir: 'back', before: 'f' }, 3, { items: [{ key: 'e', value: '' }], index: 4, next: null });
    expect(w).toMatchObject({ lower: 'e', upper: 'f', index: 4 });
  });
  it('aJumpPastEveryKeyShowsTheLastPage', () => {
    const w = windowOf({ dir: 'forward', from: 'z', jump: true }, 3, serve(['a', 'b', 'c', 'd', 'e'], { from: 'z' }, 4));
    expect(w).toMatchObject({ lower: 'c', upper: null, index: 2 });
    expect(keys(w.stored)).toEqual(['c', 'd', 'e']);
  });
  it('aBackPageWithTooManyAddedRowsCutsItsHead', () => {
    const w = windowOf({ dir: 'back', before: 'g' }, 3, serve(['a', 'b', 'c', 'd', 'e', 'f', 'g'], { before: 'g' }, 4));
    const p = shownPage(w, { set: { ee: '1' }, removed: [] }, 3);
    expect(keys(p.rows)).toEqual(['e', 'ee', 'f']);
    expect(p).toMatchObject({ lower: 'e', upper: 'g', index: 4 });
  });
  it('aSmallerSizeCutsTheTailLocally', () => {
    const w = windowOf({ dir: 'forward', from: null }, 4, serve(['a', 'b', 'c', 'd', 'e'], null, 5));
    const p = shownPage(w, { set: {}, removed: [] }, 2);
    expect(keys(p.rows)).toEqual(['a', 'b']);
    expect(p.upper).toBe('c');
  });

  // walk Next to the end and Prev back to the start: every added key exactly once each way, same pages both ways
  it.each([1, 2, 3, 4, 5, 20])('pagesTileTheKeySpaceBothWays at size %i', (size) => {
    const all = 'bdfhjlnprt'.split('');
    const edits = { set: { a: '1', c: '2', cc: '3', g: '4', k: '5', s: '6', u: '7', v: '8', d: 'changed' }, removed: ['l'] };
    const visit = (read: PageRead) => shownPage(windowOf(read, size, serve(all, readAt(read), readLimit(size))), edits, size);
    const forward: string[][] = [];
    let p = visit({ dir: 'forward', from: null });
    forward.push(keys(p.rows));
    while (p.upper !== null && forward.length < 50) { p = visit({ dir: 'forward', from: p.upper, after: p.upperAfter }); forward.push(keys(p.rows)); }
    const backward: string[][] = [keys(p.rows)];
    while (p.lower !== null && backward.length < 50) { p = visit({ dir: 'back', before: p.lower }); backward.unshift(keys(p.rows)); }
    const expected = [...new Set([...all, ...Object.keys(edits.set)])].sort();
    expect(forward.flat()).toEqual(expected);
    expect(backward.flat()).toEqual(expected);
    expect(backward).toEqual(forward);
  });

  it('aBudgetCutWalkStillShowsEveryKeyOnceForward', () => {
    const all = 'bdfhjlnprt'.split('');
    const edits = { set: { a: '1', e: '2', ee: '3', u: '4' }, removed: [] };
    const size = 4;
    // the character budget lets only 2 rows through a read; next stays set while more follow
    const capped = (at: ReturnType<typeof readAt>) => {
      const a = serve(all, at, readLimit(size));
      if (at && 'before' in at) return a;
      const items = a.items.slice(0, 2);
      return { ...a, items, next: a.next ?? (items.length < a.items.length ? items[items.length - 1].key : null) };
    };
    const visit = (read: PageRead) => shownPage(windowOf(read, size, capped(readAt(read))), edits, size);
    let p = visit({ dir: 'forward', from: null });
    const shown = [...keys(p.rows)];
    while (p.upper !== null && shown.length < 100) { p = visit({ dir: 'forward', from: p.upper, after: p.upperAfter }); shown.push(...keys(p.rows)); }
    expect(shown).toEqual([...all, ...Object.keys(edits.set)].sort());
  });
});

describe('summary', () => {
  it('summaryTextWording', () => {
    expect(summaryText({ modified: 0, added: 0, deleted: 0 })).toBe('no unsaved changes on this page');
    expect(summaryText({ modified: 1, added: 2, deleted: 0 })).toBe('on this page: 1 modified · 2 added');
    expect(summaryText({ modified: 1, added: 1, deleted: 3 })).toBe('on this page: 1 modified · 1 added · 3 deleted');
  });
  it('pageSummary counts', () => {
    const { rows } = pageView(st('a', 'b', 'c'), { set: { b: '9', bb: 'x' }, removed: ['c'] }, mid, 10);
    expect(pageSummary(rows)).toEqual({ modified: 1, added: 1, deleted: 1 });
  });
});
