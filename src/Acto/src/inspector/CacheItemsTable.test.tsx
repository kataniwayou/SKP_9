import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioApi } from '../api/client';
import type { CacheItemsPage, ItemsAt } from '../api/types';
import type { BoardState, CacheRow } from '../design/board';
import { board } from '../design/boardFixtures';
import { createBoardStore } from '../design/boardStore';
import { createOutputStore } from '../output/outputStore';
import { CacheItemsTable } from './CacheItemsTable';

// the fitted page size is the test's to set (the real hook measures the list's height)
const fit = vi.hoisted(() => ({ rows: 4 }));
vi.mock('./useFitRows', () => ({ useFitRows: () => fit.rows, fitRows: () => fit.rows }));

type Item = { key: string; value: string };
const TEN: Item[] = 'abcdefghij'.split('').map((k, i) => ({ key: k, value: String(i + 1) }));

/**
 * BaseApi's paging over `all` (sorted): after / from / before, index, prev, next, fromMatch. `cap` plays the character
 * budget: only that many rows go through, dropping the far end (a forward read's tail, a before read's head).
 */
function serve(all: Item[], at: ItemsAt | undefined, limit: number, cap = Infinity): CacheItemsPage {
  let start = 0;
  let end: number;
  let fromMatch: string | null = null;
  if (at && 'after' in at) {
    const i = all.findIndex((x) => x.key > at.after);
    start = i < 0 ? all.length : i;
    end = Math.min(all.length, start + limit);
  } else if (at && 'from' in at) {
    const i = all.findIndex((x) => x.key >= at.from);
    if (i < 0) { fromMatch = 'none'; start = Math.max(0, all.length - limit); } else { start = i; fromMatch = all[i]!.key === at.from ? 'exact' : 'later'; }
    end = Math.min(all.length, start + limit);
  } else if (at && 'before' in at) {
    const i = all.findIndex((x) => x.key >= at.before);
    end = i < 0 ? all.length : i;
    start = Math.max(0, end - limit, end - cap);
  } else {
    end = Math.min(all.length, limit);
  }
  if (!(at && 'before' in at)) end = Math.min(end, start + cap);
  const items = all.slice(start, end);
  return {
    items,
    index: start,
    prev: start > 0 && items.length ? items[0]!.key : null,
    next: end < all.length && items.length ? items[items.length - 1]!.key : null,
    fromMatch,
  };
}

function apiOf(fn: (at: ItemsAt | undefined, limit: number) => Promise<unknown>) {
  const cacheItemsPage = vi.fn((_id: string, at?: ItemsAt, limit?: number) => fn(at, limit ?? 500));
  return { api: { cacheItemsPage } as unknown as StudioApi, cacheItemsPage };
}
const over = (all: Item[], cap = Infinity) => apiOf((at, limit) => Promise.resolve({ ok: true, value: serve(all, at, limit, cap) }));

function setup(api: StudioApi, opts: { isNew?: boolean; cache?: Partial<CacheRow> } = {}) {
  const store = createBoardStore(createOutputStore(null, () => '00:00:00'), null);
  const b0 = board();
  const b: BoardState = { ...b0, caches: { c1: { ...b0.caches.c1!, itemCount: 10, ...opts.cache } } };
  store.load(b);
  function Host() {
    const s = useSyncExternalStore(store.subscribe, store.state);
    return <CacheItemsTable cache={s.caches.c1!} isNew={opts.isNew ?? false} api={api} edit={(fn, m) => store.edit(fn, m)} />;
  }
  const view = render(<Host />);
  return { store, rerender: () => view.rerender(<Host />) };
}
const overlay = (s: ReturnType<typeof setup>['store']) => s.state().caches.c1!.itemEdits;
const keysShown = () => screen.queryAllByLabelText(/^Key /).map((e) => (e as HTMLInputElement).value);
const status = () => screen.getByRole('status');
const button = (name: 'Prev' | 'Next') => screen.getByRole('button', { name }) as HTMLButtonElement;
/** Clicks Prev or Next and lets the (immediately resolving) read land. */
async function press(name: 'Prev' | 'Next') {
  await act(async () => { fireEvent.click(button(name)); });
  await act(async () => {});
}
/** The pages from here: Next until it is disabled, then Prev back until it is disabled (each list in reading order). */
async function walk(): Promise<{ forward: string[][]; backward: string[][] }> {
  const forward = [keysShown()];
  while (!button('Next').disabled && forward.length < 40) { await press('Next'); forward.push(keysShown()); }
  const backward = [keysShown()];
  while (!button('Prev').disabled && backward.length < 40) { await press('Prev'); backward.unshift(keysShown()); }
  return { forward, backward };
}

beforeEach(() => { fit.rows = 4; });

describe('CacheItemsTable', () => {
  it('readsAPageOfTheFittedSize', async () => {
    const { api, cacheItemsPage } = over(TEN);
    setup(api);
    expect(await screen.findByLabelText('Value a')).toHaveValue('1');
    expect(cacheItemsPage).toHaveBeenNthCalledWith(1, 'c1', null, 5); // one row more: the next page's first key
    expect(keysShown()).toEqual(['a', 'b', 'c', 'd']);
    expect(screen.getByText('rows 1–4 · page 1 of 3')).toBeInTheDocument();
    expect(screen.getByText('10 stored')).toBeInTheDocument();
    expect(button('Prev')).toBeDisabled();
    expect(button('Next')).toBeEnabled();
  });

  it('shows the count with thousands separators', async () => {
    const { api } = over(TEN);
    setup(api, { cache: { itemCount: 1000001 } });
    await screen.findByLabelText('Value a');
    expect(screen.getByText('1,000,001 stored')).toBeInTheDocument();
    expect(screen.getByText('rows 1–4 · page 1 of 250,001')).toBeInTheDocument();
  });

  it('nextReadsFromTheUpperKey', async () => {
    const { api, cacheItemsPage } = over(TEN);
    setup(api);
    await screen.findByLabelText('Value a');
    await press('Next');
    expect(cacheItemsPage).toHaveBeenLastCalledWith('c1', { from: 'e' }, 5);
    expect(keysShown()).toEqual(['e', 'f', 'g', 'h']);
    expect(screen.getByText('rows 5–8 · page 2 of 3')).toBeInTheDocument();
    await press('Next');
    expect(keysShown()).toEqual(['i', 'j']);
    expect(screen.getByText('rows 9–10 · page 3 of 3')).toBeInTheDocument();
    expect(button('Next')).toBeDisabled();
  });

  it('prevReadsBeforeTheLowerKey', async () => {
    const { api, cacheItemsPage } = over(TEN);
    setup(api);
    await screen.findByLabelText('Value a');
    await press('Next');
    await press('Prev');
    expect(cacheItemsPage).toHaveBeenLastCalledWith('c1', { before: 'e' }, 5);
    expect(keysShown()).toEqual(['a', 'b', 'c', 'd']);
    expect(button('Prev')).toBeDisabled();
  });

  it('beforeReadsUseTheExtraRowAsLowerBound', async () => {
    const { api, cacheItemsPage } = over(TEN);
    setup(api);
    await screen.findByLabelText('Value a');
    await press('Next');
    await press('Next');
    await press('Prev');
    expect(cacheItemsPage).toHaveBeenLastCalledWith('c1', { before: 'i' }, 5);
    expect(keysShown()).toEqual(['e', 'f', 'g', 'h']); // d came back as the extra row and is not shown
    expect(screen.getByText('rows 5–8 · page 2 of 3')).toBeInTheDocument();
    expect(button('Prev')).toBeEnabled();
  });

  it('summaryFollowsTheVisibleRows', async () => {
    const { api } = over(TEN);
    setup(api, { cache: { itemEdits: { set: {}, removed: ['b'] } } });
    await screen.findByLabelText('Value a');
    expect(status()).toHaveTextContent('on this page: 1 deleted');
    expect(screen.getByLabelText('Key b')).toHaveStyle({ textDecoration: 'line-through' });
    await press('Next');
    expect(status()).toHaveTextContent('no unsaved changes on this page');
    await press('Prev');
    expect(status()).toHaveTextContent('on this page: 1 deleted');
  });

  it('unsaved changes show in place: modified and added rows on their page', async () => {
    const { api } = over(TEN);
    setup(api, { cache: { itemEdits: { set: { a: '9', bb: 'n' }, removed: [] } } });
    await screen.findByLabelText('Value a');
    expect(screen.getByLabelText('Value a')).toHaveValue('9');
    expect(keysShown()).toEqual(['a', 'b', 'bb', 'c']);
    expect(status()).toHaveTextContent('on this page: 1 modified 1 added');
    expect(screen.getByRole('button', { name: 'Revert a' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revert bb' })).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Unsaved items' })).toBeNull();
    expect(screen.getByText('rows 1–3 · page 1 of 3')).toBeInTheDocument();
  });

  it('everyAddedKeyShowsExactlyOnceWalkingBothWays', async () => {
    const { api } = over(TEN);
    // added at the start, between every page boundary, at a cut and past the end
    const added = { '0': 's', cc: 'z', dd: 'x', hh: 'y', zz: 'e' };
    setup(api, { cache: { itemEdits: { set: added, removed: [] } } });
    await screen.findByLabelText('Value 0');
    const { forward, backward } = await walk();
    const every = [...TEN.map((x) => x.key), ...Object.keys(added)].sort();
    expect(forward.flat()).toEqual(every);
    expect(backward.flat()).toEqual(every);
    expect(backward).toEqual(forward);
  });

  it('anAddedKeyPastTheLastStoredKeyIsReachedByNext', async () => {
    const { api, cacheItemsPage } = over(TEN.slice(0, 8));
    setup(api, { cache: { itemCount: 8, itemEdits: { set: { zzz: 'z' }, removed: [] } } });
    await screen.findByLabelText('Value a');
    await press('Next');
    expect(keysShown()).toEqual(['e', 'f', 'g', 'h']); // zzz is cut: Next stays enabled
    await press('Next');
    expect(cacheItemsPage).toHaveBeenLastCalledWith('c1', { from: 'zzz' }, 5);
    expect(keysShown()).toEqual(['zzz']);
    expect(screen.getByLabelText('Value zzz')).toHaveValue('z');
    expect(status()).toHaveTextContent('on this page: 1 added');
    expect(screen.getByText('no stored rows on this page')).toBeInTheDocument();
    expect(button('Prev')).toBeEnabled();
    expect(button('Next')).toBeDisabled();
  });

  it('prevFromAnEmptyPageReturnsToThePreviousPage', async () => {
    const { api, cacheItemsPage } = over(TEN.slice(0, 8));
    setup(api, { cache: { itemCount: 8, itemEdits: { set: { zzz: 'z' }, removed: [] } } });
    await screen.findByLabelText('Value a');
    await press('Next');
    await press('Next');
    expect(keysShown()).toEqual(['zzz']);
    await press('Prev');
    expect(cacheItemsPage).toHaveBeenLastCalledWith('c1', { before: 'zzz' }, 5);
    expect(keysShown()).toEqual(['e', 'f', 'g', 'h']); // h, the last stored key, is back
    expect(screen.getByText('rows 5–8 · page 2 of 2')).toBeInTheDocument();
  });

  it('anAddedKeyBetweenPagesShowsOnExactlyOnePage', async () => {
    const { api } = over(TEN);
    setup(api, { cache: { itemEdits: { set: { dd: 'n' }, removed: [] } } });
    await screen.findByLabelText('Value a');
    const page1 = keysShown();
    await press('Next');
    const page2 = keysShown();
    // page 1 is full, so dd is cut from it and opens page 2
    expect([page1.includes('dd'), page2.includes('dd')].filter(Boolean)).toHaveLength(1);
    expect(page2).toEqual(['dd', 'e', 'f', 'g']);
    expect(status()).toHaveTextContent('on this page: 1 added');
  });

  it('aCutAddedRowCarriesToTheNextPage', async () => {
    const { api, cacheItemsPage } = over(TEN);
    setup(api, { cache: { itemEdits: { set: { cc: 'n' }, removed: [] } } });
    await screen.findByLabelText('Value a');
    expect(keysShown()).toEqual(['a', 'b', 'c', 'cc']); // d is cut
    await press('Next');
    expect(cacheItemsPage).toHaveBeenLastCalledWith('c1', { from: 'd' }, 5);
    expect(keysShown()).toEqual(['d', 'e', 'f', 'g']);
  });

  it('prevAfterNextShowsTheSameRows', async () => {
    const { api } = over(TEN);
    setup(api, { cache: { itemEdits: { set: { cc: 'n' }, removed: [] } } });
    await screen.findByLabelText('Value a');
    await press('Next');
    await press('Prev');
    expect(keysShown()).toEqual(['a', 'b', 'c', 'cc']);
    expect(button('Prev')).toBeDisabled();
  });

  it('aCacheOfOnlyAddedKeysPagesBothWays', async () => {
    const { api } = over([]);
    setup(api, { cache: { itemCount: 0, itemEdits: { set: { a: '1', b: '2', c: '3', d: '4', e: '5', f: '6' }, removed: [] } } });
    await screen.findByLabelText('Value a');
    expect(keysShown()).toEqual(['a', 'b', 'c', 'd']);
    expect(button('Prev')).toBeDisabled();
    await press('Next');
    expect(keysShown()).toEqual(['e', 'f']);
    expect(button('Prev')).toBeEnabled();
    expect(button('Next')).toBeDisabled();
    await press('Prev');
    expect(keysShown()).toEqual(['a', 'b', 'c', 'd']);
    expect(button('Prev')).toBeDisabled();
  });

  it('budgetCutPageStillTiles', async () => {
    // the character budget lets only 3 rows through a read, with next set while more follow
    const { api, cacheItemsPage } = over(TEN, 3);
    setup(api, { cache: { itemEdits: { set: { cc: 'x', hh: 'y' }, removed: [] } } });
    await screen.findByLabelText('Value a');
    const first = keysShown();
    expect(first).toEqual(['a', 'b', 'c']);
    await press('Next');
    expect(cacheItemsPage).toHaveBeenLastCalledWith('c1', { after: 'c' }, 5);
    const { forward } = await walk();
    expect([first, ...forward].flat()).toEqual([...TEN.map((x) => x.key), 'cc', 'hh'].sort());
  });

  it('jumpReadsFromTheTypedText', async () => {
    const { api, cacheItemsPage } = over(TEN);
    setup(api);
    await screen.findByLabelText('Value a');
    const box = screen.getByRole('textbox', { name: 'Jump to key' });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(cacheItemsPage).toHaveBeenCalledTimes(1); // empty text: no read (BaseApi answers 400)
    fireEvent.change(box, { target: { value: 'f' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByLabelText('Value f')).toBeInTheDocument();
    expect(cacheItemsPage).toHaveBeenLastCalledWith('c1', { from: 'f' }, 5);
    expect(screen.getByText('rows 6–9 · page 2 of 3')).toBeInTheDocument();
  });

  it('jumpNoteComesFromFromMatch', async () => {
    const all = TEN.filter((x) => x.key !== 'f');
    const { api, cacheItemsPage } = over(all);
    setup(api, { cache: { itemCount: 9 } });
    await screen.findByLabelText('Value a');
    const box = screen.getByRole('textbox', { name: 'Jump to key' });
    const go = (t: string) => { fireEvent.change(box, { target: { value: t } }); fireEvent.click(screen.getByRole('button', { name: 'Go' })); };
    go('f');
    expect(await screen.findByText('no key "f" — showing from the next key')).toBeInTheDocument();
    expect(keysShown()[0]).toBe('g');
    go('z');
    expect(await screen.findByText('no key at or after "z" — showing the last page')).toBeInTheDocument();
    expect(keysShown()).toEqual(['g', 'h', 'i', 'j']);
    expect(button('Next')).toBeDisabled();
    go('c');
    await screen.findByLabelText('Value c');
    await waitFor(() => expect(screen.queryByText(/^no key/)).toBeNull());
    go('f');
    await screen.findByText('no key "f" — showing from the next key');
    fireEvent.click(screen.getByRole('button', { name: 'Clear jump' }));
    expect(screen.queryByText(/^no key/)).toBeNull();
    expect(box).toHaveValue('');
    expect(await screen.findByLabelText('Value a')).toBeInTheDocument();
    expect(cacheItemsPage).toHaveBeenLastCalledWith('c1', null, 5);
  });

  it('aJumpPastEveryKeyKeepsAddedKeysJustBelowItReachable', async () => {
    const { api } = over(TEN);
    setup(api, { cache: { itemEdits: { set: { jj: 'n' }, removed: [] } } });
    await screen.findByLabelText('Value a');
    const box = screen.getByRole('textbox', { name: 'Jump to key' });
    fireEvent.change(box, { target: { value: 'z' } });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    await screen.findByText('no key at or after "z" — showing the last page');
    // the page owns [g, end): jj sorts in it, is cut at this size, and Next reaches it
    expect(keysShown()).toEqual(['g', 'h', 'i', 'j']);
    await press('Next');
    expect(keysShown()).toEqual(['jj']);
  });

  it('growingReadsFromTheLowerKey', async () => {
    const { api, cacheItemsPage } = over(TEN);
    const { rerender } = setup(api);
    await screen.findByLabelText('Value a');
    await press('Next');
    fit.rows = 6;
    rerender();
    await waitFor(() => expect(cacheItemsPage).toHaveBeenLastCalledWith('c1', { from: 'e' }, 7));
    await screen.findByLabelText('Value j');
    expect(keysShown()).toEqual(['e', 'f', 'g', 'h', 'i', 'j']);
    const calls = cacheItemsPage.mock.calls.length;
    fit.rows = 3;
    rerender();
    expect(keysShown()).toEqual(['e', 'f', 'g']);
    expect(cacheItemsPage).toHaveBeenCalledTimes(calls);
    expect(screen.getByText('rows 5–7 · page 2 of 4')).toBeInTheDocument();
    expect(button('Next')).toBeEnabled();
    await press('Next');
    expect(cacheItemsPage).toHaveBeenLastCalledWith('c1', { from: 'h' }, 4);
  });

  it('aStaleReadIsIgnored', async () => {
    const waits: Record<number, (v: unknown) => void> = {};
    const { api, cacheItemsPage } = apiOf((at, limit) => new Promise((res) => { waits[limit] = () => res({ ok: true, value: serve(TEN, at, limit) }); }));
    const { rerender } = setup(api);
    await waitFor(() => expect(cacheItemsPage).toHaveBeenCalledWith('c1', null, 5));
    fit.rows = 6;
    rerender();
    await waitFor(() => expect(cacheItemsPage).toHaveBeenCalledWith('c1', null, 7));
    await act(async () => { waits[7]!(undefined); });
    await act(async () => { waits[5]!(undefined); });
    expect(keysShown()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('editsAreBoardStepsAndNoSaveHere', async () => {
    const { api } = over(TEN);
    const { store } = setup(api);
    const cell = await screen.findByLabelText('Value a');
    fireEvent.change(cell, { target: { value: '9' } });
    fireEvent.keyDown(cell, { key: 'Enter' });
    fireEvent.blur(cell);
    expect(overlay(store).set).toEqual({ a: '9' });
    expect(screen.getByLabelText('Value a')).toHaveValue('9');
    expect(status()).toHaveTextContent('on this page: 1 modified');
    fireEvent.click(screen.getByRole('button', { name: 'Remove b' }));
    expect(overlay(store).removed).toEqual(['b']);
    fireEvent.click(screen.getByRole('button', { name: 'Restore b' }));
    expect(overlay(store).removed).toEqual([]);
    act(() => store.undo()); // the restore
    expect(overlay(store).removed).toEqual(['b']);
    act(() => store.undo()); // the remove
    act(() => store.undo()); // the value
    expect(overlay(store).set).toEqual({});
    expect(screen.getByLabelText('Value a')).toHaveValue('1');
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
  });

  it('adding a key refused with a colon shows the reason', async () => {
    const { api } = over(TEN);
    const { store } = setup(api);
    await screen.findByLabelText('Value a');
    fireEvent.change(screen.getByLabelText('New key'), { target: { value: 'x:y' } });
    fireEvent.change(screen.getByLabelText('New value'), { target: { value: 'v' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    expect(screen.getByRole('alert')).toHaveTextContent(':');
    expect(overlay(store).set).toEqual({});
    fireEvent.change(screen.getByLabelText('New key'), { target: { value: 'bb' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    expect(overlay(store).set).toEqual({ bb: 'v' });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText('Value bb')).toHaveValue('v');
  });

  it('aNewCacheShowsOnlyAddedRows', () => {
    const { api, cacheItemsPage } = over(TEN);
    setup(api, { isNew: true, cache: { updatedAt: null, itemCount: 0, itemEdits: { set: { n: '1', m: '2' }, removed: [] } } });
    expect(cacheItemsPage).not.toHaveBeenCalled();
    expect(keysShown()).toEqual(['m', 'n']);
    expect(screen.getByLabelText('Value n')).toHaveValue('1');
    expect(status()).toHaveTextContent('on this page: 2 added');
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
  });

  it('aFailedReadShowsRetry', async () => {
    let fail = true;
    const { api, cacheItemsPage } = apiOf((at, limit) => Promise.resolve(fail
      ? { ok: false, error: { kind: 'http', status: 500, detail: 'boom' } } : { ok: true, value: serve(TEN, at, limit) }));
    setup(api);
    expect(await screen.findByRole('alert')).toHaveTextContent('500: boom');
    fail = false;
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Value a')).toBeInTheDocument();
    expect(cacheItemsPage).toHaveBeenCalledTimes(2);
  });

  it('a new stored stamp reads the page on screen again', async () => {
    const { api, cacheItemsPage } = over(TEN);
    const { store } = setup(api);
    await screen.findByLabelText('Value a');
    await press('Next');
    await press('Next');
    expect(keysShown()).toEqual(['i', 'j']);
    act(() => store.load({ ...store.state(), caches: { c1: { ...store.state().caches.c1!, updatedAt: '2026-12-01T00:00:00Z' } } }));
    await waitFor(() => expect(cacheItemsPage).toHaveBeenLastCalledWith('c1', { from: 'i' }, 5));
    await act(async () => {});
    expect(keysShown()).toEqual(['i', 'j']);
    expect(screen.getByText('rows 9–10 · page 3 of 3')).toBeInTheDocument();
  });

  it('a new stored stamp on the first page reads the first page', async () => {
    const { api, cacheItemsPage } = over(TEN);
    const { store } = setup(api);
    await screen.findByLabelText('Value a');
    act(() => store.load({ ...store.state(), caches: { c1: { ...store.state().caches.c1!, updatedAt: '2026-12-01T00:00:00Z' } } }));
    await waitFor(() => expect(cacheItemsPage).toHaveBeenCalledTimes(2));
    expect(cacheItemsPage).toHaveBeenLastCalledWith('c1', null, 5);
  });

  it('growing while Next is in flight grows the Next read, not the old page', async () => {
    const waits: ((v?: unknown) => void)[] = [];
    const { api, cacheItemsPage } = apiOf((at, limit) => new Promise((res) => { waits.push(() => res({ ok: true, value: serve(TEN, at, limit) })); }));
    const { rerender } = setup(api);
    await waitFor(() => expect(cacheItemsPage).toHaveBeenCalledTimes(1));
    await act(async () => { waits.shift()!(); });
    expect(keysShown()).toEqual(['a', 'b', 'c', 'd']);
    fireEvent.click(button('Next'));
    await waitFor(() => expect(cacheItemsPage).toHaveBeenLastCalledWith('c1', { from: 'e' }, 5));
    fit.rows = 6;
    rerender();
    await waitFor(() => expect(cacheItemsPage).toHaveBeenLastCalledWith('c1', { from: 'e' }, 7));
    expect(cacheItemsPage).not.toHaveBeenCalledWith('c1', null, 7);
    await act(async () => { while (waits.length) waits.shift()!(); });
    expect(keysShown()).toEqual(['e', 'f', 'g', 'h', 'i', 'j']);
  });

  it('growing while a jump is in flight keeps the jump and its note', async () => {
    const waits: ((v?: unknown) => void)[] = [];
    const all = TEN.filter((x) => x.key !== 'f');
    const { api, cacheItemsPage } = apiOf((at, limit) => new Promise((res) => { waits.push(() => res({ ok: true, value: serve(all, at, limit) })); }));
    const { rerender } = setup(api, { cache: { itemCount: 9 } });
    await waitFor(() => expect(cacheItemsPage).toHaveBeenCalledTimes(1));
    await act(async () => { waits.shift()!(); });
    fireEvent.change(screen.getByRole('textbox', { name: 'Jump to key' }), { target: { value: 'f' } });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    fit.rows = 5;
    rerender();
    await waitFor(() => expect(cacheItemsPage).toHaveBeenLastCalledWith('c1', { from: 'f' }, 6));
    await act(async () => { while (waits.length) waits.shift()!(); });
    expect(keysShown()).toEqual(['g', 'h', 'i', 'j']);
    expect(screen.getByText('no key "f" — showing from the next key')).toBeInTheDocument();
  });

  it('the jump note keeps its line when there is none', async () => {
    const { api } = over(TEN);
    setup(api);
    await screen.findByLabelText('Value a');
    expect(document.querySelector('.dict-note')).not.toBeNull();
  });

  it('adding a key that sorts off this page goes to it', async () => {
    const { api, cacheItemsPage } = over(TEN);
    const { store } = setup(api);
    await screen.findByLabelText('Value a');
    fireEvent.change(screen.getByLabelText('New key'), { target: { value: 'zzz' } });
    fireEvent.change(screen.getByLabelText('New value'), { target: { value: 'v' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    expect(overlay(store).set).toEqual({ zzz: 'v' });
    await waitFor(() => expect(cacheItemsPage).toHaveBeenLastCalledWith('c1', { from: 'zzz' }, 5));
    expect(await screen.findByLabelText('Value zzz')).toHaveValue('v');
    expect(screen.getByRole('row', { name: /zzz/ })).toHaveClass('add');
    expect(status()).toHaveTextContent('on this page: 1 added');
    expect(screen.queryByText(/^no key/)).toBeNull();
    expect(button('Prev')).toBeEnabled();
  });

  it('adding a key that shows on this page stays here', async () => {
    const { api, cacheItemsPage } = over(TEN);
    setup(api);
    await screen.findByLabelText('Value a');
    fireEvent.change(screen.getByLabelText('New key'), { target: { value: 'bb' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    expect(screen.getByLabelText('Value bb')).toBeInTheDocument();
    await act(async () => {});
    expect(cacheItemsPage).toHaveBeenCalledTimes(1);
  });

  it('modifying a stored key on another page goes to it', async () => {
    const { api, cacheItemsPage } = over(TEN);
    setup(api);
    await screen.findByLabelText('Value a');
    fireEvent.change(screen.getByLabelText('New key'), { target: { value: 'g' } });
    fireEvent.change(screen.getByLabelText('New value'), { target: { value: 'G' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    await waitFor(() => expect(cacheItemsPage).toHaveBeenLastCalledWith('c1', { from: 'g' }, 5));
    expect(await screen.findByLabelText('Value g')).toHaveValue('G');
    expect(status()).toHaveTextContent('on this page: 1 modified');
  });
});
