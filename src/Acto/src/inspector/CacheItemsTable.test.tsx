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

/** BaseApi's paging over `all` (sorted): after / from / before, index, prev, next, fromMatch. */
function serve(all: Item[], at: ItemsAt | undefined, limit: number): CacheItemsPage {
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
    start = Math.max(0, end - limit);
  } else {
    end = Math.min(all.length, limit);
  }
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
const over = (all: Item[]) => apiOf((at, limit) => Promise.resolve({ ok: true, value: serve(all, at, limit) }));

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

beforeEach(() => { fit.rows = 4; });

describe('CacheItemsTable', () => {
  it('readsAPageOfTheFittedSize', async () => {
    const { api, cacheItemsPage } = over(TEN);
    setup(api);
    expect(await screen.findByLabelText('Value a')).toHaveValue('1');
    expect(cacheItemsPage).toHaveBeenNthCalledWith(1, 'c1', null, 4);
    expect(keysShown()).toEqual(['a', 'b', 'c', 'd']);
    expect(screen.getByText('rows 1–4 · page 1 of 3')).toBeInTheDocument();
    expect(screen.getByText('Items · 10 stored')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prev' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('shows the count with thousands separators', async () => {
    const { api } = over(TEN);
    setup(api, { cache: { itemCount: 1000001 } });
    await screen.findByLabelText('Value a');
    expect(screen.getByText('Items · 1,000,001 stored')).toBeInTheDocument();
    expect(screen.getByText('rows 1–4 · page 1 of 250,001')).toBeInTheDocument();
  });

  it('nextReadsAfterTheLastVisibleKey', async () => {
    const { api, cacheItemsPage } = over(TEN);
    setup(api);
    await screen.findByLabelText('Value a');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByLabelText('Value e')).toBeInTheDocument();
    expect(cacheItemsPage).toHaveBeenLastCalledWith('c1', { after: 'd' }, 4);
    expect(keysShown()).toEqual(['e', 'f', 'g', 'h']);
    expect(screen.getByText('rows 5–8 · page 2 of 3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByLabelText('Value i')).toBeInTheDocument();
    expect(screen.getByText('rows 9–10 · page 3 of 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('prevReadsBeforeTheFirstVisibleKey', async () => {
    const { api, cacheItemsPage } = over(TEN);
    setup(api);
    await screen.findByLabelText('Value a');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByLabelText('Value e');
    fireEvent.click(screen.getByRole('button', { name: 'Prev' }));
    expect(await screen.findByLabelText('Value a')).toBeInTheDocument();
    expect(cacheItemsPage).toHaveBeenLastCalledWith('c1', { before: 'e' }, 5); // one more than shown: the lower bound
    expect(screen.getByRole('button', { name: 'Prev' })).toBeDisabled();
  });

  it('summaryFollowsTheVisibleRows', async () => {
    const { api } = over(TEN);
    setup(api, { cache: { itemEdits: { set: {}, removed: ['b'] } } });
    await screen.findByLabelText('Value a');
    expect(status()).toHaveTextContent('on this page: 1 deleted');
    expect(screen.getByLabelText('Key b')).toHaveStyle({ textDecoration: 'line-through' });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByLabelText('Value e');
    expect(status()).toHaveTextContent('no unsaved changes on this page');
    fireEvent.click(screen.getByRole('button', { name: 'Prev' }));
    await screen.findByLabelText('Value a');
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
    // the cut row (d) is still reachable: Next reads after the last visible stored key
    expect(screen.getByText('rows 1–3 · page 1 of 3')).toBeInTheDocument();
  });

  it('anAddedKeyPastTheLastStoredKeyIsReachedByNext', async () => {
    const { api, cacheItemsPage } = over(TEN.slice(0, 8));
    setup(api, { cache: { itemCount: 8, itemEdits: { set: { zzz: 'z' }, removed: [] } } });
    await screen.findByLabelText('Value a');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByLabelText('Value e');
    expect(keysShown()).toEqual(['e', 'f', 'g', 'h']); // zzz is cut: Next stays enabled
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByLabelText('Value zzz')).toHaveValue('z');
    expect(cacheItemsPage).toHaveBeenLastCalledWith('c1', { after: 'h' }, 4);
    expect(keysShown()).toEqual(['zzz']);
    expect(status()).toHaveTextContent('on this page: 1 added');
    expect(screen.getByText('page 3 of 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prev' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('prevFromAnEmptyPageReadsBeforeTheAnchor', async () => {
    const { api, cacheItemsPage } = over(TEN.slice(0, 8));
    setup(api, { cache: { itemCount: 8, itemEdits: { set: { zzz: 'z' }, removed: [] } } });
    await screen.findByLabelText('Value a');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByLabelText('Value e');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByLabelText('Value zzz');
    fireEvent.click(screen.getByRole('button', { name: 'Prev' }));
    expect(await screen.findByLabelText('Value d')).toBeInTheDocument();
    expect(cacheItemsPage).toHaveBeenLastCalledWith('c1', { before: 'h' }, 5);
    expect(keysShown()).toEqual(['d', 'e', 'f', 'g']);
    expect(screen.getByText('rows 4–7 · page 1 of 2')).toBeInTheDocument();
  });

  it('anAddedKeyBetweenPagesShowsOnTheEarlierPage', async () => {
    const { api } = over(TEN);
    setup(api, { cache: { itemEdits: { set: { dd: 'n' }, removed: [] } } });
    await screen.findByLabelText('Value a');
    const page1 = keysShown();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByLabelText('Value e');
    const page2 = keysShown();
    // on exactly one of the two pages: page 1 is full, so it is the first row of page 2
    expect([page1.includes('dd'), page2.includes('dd')].filter(Boolean)).toHaveLength(1);
    expect(page2).toEqual(['dd', 'e', 'f', 'g']);
    expect(status()).toHaveTextContent('on this page: 1 added');
  });

  it('aCutAddedRowCarriesToTheNextPage', async () => {
    const { api, cacheItemsPage } = over(TEN);
    setup(api, { cache: { itemEdits: { set: { cc: 'n' }, removed: [] } } });
    await screen.findByLabelText('Value a');
    expect(keysShown()).toEqual(['a', 'b', 'c', 'cc']); // d is cut
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByLabelText('Value d')).toBeInTheDocument();
    expect(cacheItemsPage).toHaveBeenLastCalledWith('c1', { after: 'cc' }, 4);
    expect(keysShown()).toEqual(['d', 'e', 'f', 'g']);
  });

  it('beforeReadsUseTheExtraRowAsLowerBound', async () => {
    const { api, cacheItemsPage } = over(TEN);
    setup(api);
    await screen.findByLabelText('Value a');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByLabelText('Value e');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByLabelText('Value i');
    fireEvent.click(screen.getByRole('button', { name: 'Prev' }));
    expect(await screen.findByLabelText('Value e')).toBeInTheDocument();
    expect(cacheItemsPage).toHaveBeenLastCalledWith('c1', { before: 'i' }, 5);
    expect(keysShown()).toEqual(['e', 'f', 'g', 'h']); // d came back as the bound and is not shown
    expect(screen.getByText('rows 5–8 · page 2 of 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prev' })).toBeEnabled();
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
    expect(cacheItemsPage).toHaveBeenLastCalledWith('c1', { from: 'f' }, 4);
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
    go('c');
    await screen.findByLabelText('Value c');
    await waitFor(() => expect(screen.queryByText(/^no key/)).toBeNull());
    go('f');
    await screen.findByText('no key "f" — showing from the next key');
    fireEvent.click(screen.getByRole('button', { name: 'Clear jump' }));
    expect(screen.queryByText(/^no key/)).toBeNull();
    expect(box).toHaveValue('');
    expect(await screen.findByLabelText('Value a')).toBeInTheDocument();
    expect(cacheItemsPage).toHaveBeenLastCalledWith('c1', null, 4);
  });

  it('growingReadsFromTheFirstVisibleKey', async () => {
    const { api, cacheItemsPage } = over(TEN);
    const { rerender } = setup(api);
    await screen.findByLabelText('Value a');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByLabelText('Value e');
    fit.rows = 6;
    rerender();
    await waitFor(() => expect(cacheItemsPage).toHaveBeenLastCalledWith('c1', { from: 'e' }, 6));
    await screen.findByLabelText('Value j');
    expect(keysShown()).toEqual(['e', 'f', 'g', 'h', 'i', 'j']);
    const calls = cacheItemsPage.mock.calls.length;
    fit.rows = 3;
    rerender();
    expect(keysShown()).toEqual(['e', 'f', 'g']);
    expect(cacheItemsPage).toHaveBeenCalledTimes(calls);
    expect(screen.getByText('rows 5–7 · page 2 of 4')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(cacheItemsPage).toHaveBeenLastCalledWith('c1', { after: 'g' }, 3));
  });

  it('aStaleReadIsIgnored', async () => {
    const waits: Record<number, (v: unknown) => void> = {};
    const { api, cacheItemsPage } = apiOf((at, limit) => new Promise((res) => { waits[limit] = () => res({ ok: true, value: serve(TEN, at, limit) }); }));
    const { rerender } = setup(api);
    await waitFor(() => expect(cacheItemsPage).toHaveBeenCalledWith('c1', null, 4));
    fit.rows = 6;
    rerender();
    await waitFor(() => expect(cacheItemsPage).toHaveBeenCalledWith('c1', null, 6));
    await act(async () => { waits[6]!(undefined); });
    await act(async () => { waits[4]!(undefined); });
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

  it('a new stored stamp reads the first page again', async () => {
    const { api, cacheItemsPage } = over(TEN);
    const { store } = setup(api);
    await screen.findByLabelText('Value a');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByLabelText('Value e');
    act(() => store.load({ ...store.state(), caches: { c1: { ...store.state().caches.c1!, updatedAt: '2026-12-01T00:00:00Z' } } }));
    await waitFor(() => expect(cacheItemsPage).toHaveBeenLastCalledWith('c1', null, 4));
    expect(await screen.findByLabelText('Value a')).toBeInTheDocument();
  });
});
