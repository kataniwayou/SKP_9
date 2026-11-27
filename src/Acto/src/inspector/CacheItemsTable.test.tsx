import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { StudioApi } from '../api/client';
import type { CacheItemsPage } from '../api/types';
import type { BoardState, CacheRow } from '../design/board';
import { board } from '../design/boardFixtures';
import { createBoardStore } from '../design/boardStore';
import { createOutputStore } from '../output/outputStore';
import { CacheItemsTable } from './CacheItemsTable';

const P1: CacheItemsPage = { items: [{ key: 'a', value: '1' }, { key: 'b', value: '2' }], next: 'b' };
const P2: CacheItemsPage = { items: [{ key: 'c', value: '3' }], next: null };

function apiOf(fn: (after: string | null | undefined) => Promise<unknown>) {
  const cacheItemsPage = vi.fn((_id: string, at?: { after: string } | null) => fn(at?.after));
  return { api: { cacheItemsPage } as unknown as StudioApi, cacheItemsPage };
}
const pages = (after: string | null | undefined) => Promise.resolve({ ok: true, value: after ? P2 : P1 });

function setup(api: StudioApi, opts: { isNew?: boolean; cache?: Partial<CacheRow> } = {}) {
  const store = createBoardStore(createOutputStore(null, () => '00:00:00'), null);
  const b0 = board();
  const b: BoardState = { ...b0, caches: { c1: { ...b0.caches.c1!, itemCount: 3, ...opts.cache } } };
  store.load(b);
  function Host() {
    const s = useSyncExternalStore(store.subscribe, store.state);
    return <CacheItemsTable cache={s.caches.c1!} isNew={opts.isNew ?? false} api={api} edit={(fn, m) => store.edit(fn, m)} />;
  }
  render(<Host />);
  return store;
}
const overlay = (s: ReturnType<typeof setup>) => s.state().caches.c1!.itemEdits;

describe('CacheItemsTable', () => {
  it('shows the first page and Next', async () => {
    const { api, cacheItemsPage } = apiOf(pages);
    setup(api);
    expect(await screen.findByLabelText('Value a')).toHaveValue('1');
    expect(screen.getByText('3 stored')).toBeInTheDocument();
    expect(cacheItemsPage).toHaveBeenCalledWith('c1', null, 500);
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('Next then Previous returns to page one', async () => {
    const { api, cacheItemsPage } = apiOf(pages);
    setup(api);
    await screen.findByLabelText('Value a');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByLabelText('Value c')).toHaveValue('3');
    expect(cacheItemsPage).toHaveBeenLastCalledWith('c1', { after: 'b' }, 500);
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByLabelText('Value a')).toBeInTheDocument();
    expect(cacheItemsPage).toHaveBeenLastCalledWith('c1', null, 500);
  });

  it('editing a stored value adds it to the overlay', async () => {
    const { api } = apiOf(pages);
    const store = setup(api);
    const cell = await screen.findByLabelText('Value a');
    fireEvent.change(cell, { target: { value: '9' } });
    fireEvent.keyDown(cell, { key: 'Enter' });
    fireEvent.blur(cell);
    expect(overlay(store).set).toEqual({ a: '9' });
    expect(screen.getByLabelText('Value a')).toHaveValue('9');
    expect(screen.getByLabelText('Unsaved value a')).toHaveValue('9');
    act(() => store.undo());
    expect(overlay(store).set).toEqual({});
  });

  it('removing a stored key strikes it through and restore reverts', async () => {
    const { api } = apiOf(pages);
    const store = setup(api);
    await screen.findByLabelText('Value a');
    fireEvent.click(screen.getByRole('button', { name: 'Remove a' }));
    expect(overlay(store).removed).toEqual(['a']);
    expect(screen.getByLabelText('Key a')).toHaveStyle({ textDecoration: 'line-through' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Restore a' })[0]!);
    expect(overlay(store).removed).toEqual([]);
    expect(screen.getByLabelText('Key a')).not.toHaveStyle({ textDecoration: 'line-through' });
  });

  it('adding a key refused with a colon shows the reason', async () => {
    const { api } = apiOf(pages);
    const store = setup(api);
    await screen.findByLabelText('Value a');
    fireEvent.change(screen.getByLabelText('New key'), { target: { value: 'x:y' } });
    fireEvent.change(screen.getByLabelText('New value'), { target: { value: 'v' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    expect(screen.getByRole('alert')).toHaveTextContent(':');
    expect(overlay(store).set).toEqual({});
    fireEvent.change(screen.getByLabelText('New key'), { target: { value: 'xy' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    expect(overlay(store).set).toEqual({ xy: 'v' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a new cache shows only unsaved items', () => {
    const { api, cacheItemsPage } = apiOf(pages);
    setup(api, { isNew: true, cache: { updatedAt: null, itemCount: 0, itemEdits: { set: { n: '1' }, removed: [] } } });
    expect(cacheItemsPage).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Unsaved value n')).toHaveValue('1');
    expect(screen.queryByRole('table', { name: 'Stored items' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
  });

  it('page load failure shows Retry', async () => {
    let fail = true;
    const { api, cacheItemsPage } = apiOf(() => Promise.resolve(fail
      ? { ok: false, error: { kind: 'http', status: 500, detail: 'boom' } } : { ok: true, value: P1 }));
    setup(api);
    expect(await screen.findByRole('alert')).toHaveTextContent('500: boom');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Value a')).toBeInTheDocument();
    expect(cacheItemsPage).toHaveBeenCalledTimes(2);
  });

  it('a new stored stamp reads the first page again', async () => {
    const { api, cacheItemsPage } = apiOf(pages);
    const store = setup(api);
    await screen.findByLabelText('Value a');
    await waitFor(() => expect(cacheItemsPage).toHaveBeenCalledTimes(1));
    act(() => store.load({ ...store.state(), caches: { c1: { ...store.state().caches.c1!, updatedAt: '2026-12-01T00:00:00Z' } } }));
    await waitFor(() => expect(cacheItemsPage).toHaveBeenCalledTimes(2));
  });
});
