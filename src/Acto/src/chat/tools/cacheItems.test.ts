import { describe, expect, it, vi } from 'vitest';
import { CACHE_ITEM_TOOLS } from './cacheItems';
import { call, done, setup } from './testContext';

const page = (items: { key: string; value: string }[], next: string | null = null) => ({ ok: true, value: { items, next } });

const read = async (ctx: ReturnType<typeof setup>['ctx'], args: Record<string, unknown>) => done(await call(ctx, 'read_cache_items', { cache_id: 'c1', ...args }));
const withCount = (store: ReturnType<typeof setup>['store'], itemCount: number) => store.load({ ...store.state(), caches: { c1: { ...store.state().caches.c1!, itemCount } } });

describe('cache item tools', () => {
  it('read_cache_items returns one page with states, per-page counts and ready-to-pass anchors', async () => {
    const { ctx, api, store } = setup();
    withCount(store, 3);
    // the page was asked for limit+1 rows: the extra 'c' is the next page's start
    api.cacheItemsPage = vi.fn().mockResolvedValue(page([{ key: 'a', value: '1' }, { key: 'b', value: '2' }, { key: 'c', value: '3' }]));
    await call(ctx, 'set_cache_items', { cache_id: 'c1', items: [{ key: 'a', value: 'X' }, { key: 'z', value: '9' }] });
    await call(ctx, 'remove_cache_items', { cache_id: 'c1', keys: ['b'] });
    const o = await read(ctx, { limit: 2 });
    expect(o.ok).toBe(true);
    expect(api.cacheItemsPage).toHaveBeenCalledWith('c1', null, 3);
    const d = JSON.parse(o.result);
    expect(d.items).toEqual([{ key: 'a', value: 'X', state: 'modified' }, { key: 'b', value: '2', state: 'deleted' }]);
    expect(d.next).toEqual({ from: 'c' });
    expect(d.prev).toBeNull();
    expect(d.index).toBe(0);
    expect(d.rows).toBe('1–2 of 3');
    expect(d.item_count).toBe(3);
    expect(d.unsaved).toEqual({ modified: 1, added: 0, deleted: 1 });
    expect(d.note).toMatch(/one page of 3/);
  });

  it('rowsCarryStateAndDeletedRowsStay: an added key in range is a row, one outside is not counted (this page only)', async () => {
    const { ctx, api, store } = setup();
    withCount(store, 3);
    api.cacheItemsPage = vi.fn().mockResolvedValue(page([{ key: 'a', value: '1' }, { key: 'c', value: '3' }, { key: 'e', value: '5' }]));
    await call(ctx, 'set_cache_items', { cache_id: 'c1', items: [{ key: 'b', value: 'new' }, { key: 'zz', value: 'far' }] });
    const d = JSON.parse((await read(ctx, { limit: 2 })).result);
    expect(d.items.map((i: { key: string; state?: string }) => [i.key, i.state])).toEqual([['a', undefined], ['b', 'added']]);
    expect(d.unsaved).toEqual({ modified: 0, added: 1, deleted: 0 });
    expect(d.next).toEqual({ from: 'c' });
  });

  it('fromJumpsAndNotes', async () => {
    const { ctx, api, store } = setup();
    withCount(store, 4);
    api.cacheItemsPage = vi.fn().mockResolvedValue({ ok: true, value: { items: [{ key: 'c', value: '3' }, { key: 'd', value: '4' }], next: null, index: 2, fromMatch: 'later' } });
    const d = JSON.parse((await read(ctx, { from: 'b' })).result);
    expect(api.cacheItemsPage).toHaveBeenCalledWith('c1', { from: 'b' }, 501);
    expect(d.note).toContain('no key "b" — showing from the next key');
    expect(d.index).toBe(2);
    expect(d.rows).toBe('3–4 of 4');
    expect(d.prev).toEqual({ before: 'b' });
    expect(d.next).toBeNull();
    api.cacheItemsPage = vi.fn().mockResolvedValue({ ok: true, value: { items: [{ key: 'c', value: '3' }, { key: 'd', value: '4' }], next: null, index: 2, fromMatch: 'none' } });
    expect(JSON.parse((await read(ctx, { from: 'q' })).result).note).toContain('no key at or after "q" — showing the last page');
  });

  it('beforeAndAfterAreCursors', async () => {
    const { ctx, api, store } = setup();
    withCount(store, 6);
    api.cacheItemsPage = vi.fn().mockResolvedValue({ ok: true, value: { items: [{ key: 'b', value: '2' }, { key: 'c', value: '3' }, { key: 'd', value: '4' }], next: null, index: 1 } });
    const back = JSON.parse((await read(ctx, { before: 'e', limit: 2 })).result);
    expect(api.cacheItemsPage).toHaveBeenCalledWith('c1', { before: 'e' }, 3);
    expect(back.items.map((i: { key: string }) => i.key)).toEqual(['c', 'd']);
    expect(back.prev).toEqual({ before: 'c' });
    expect(back.next).toEqual({ from: 'e' });
    api.cacheItemsPage = vi.fn().mockResolvedValue(page([{ key: 'f', value: '6' }]));
    const fwd = JSON.parse((await read(ctx, { after: 'e' })).result);
    expect(api.cacheItemsPage).toHaveBeenCalledWith('c1', { after: 'e' }, 501);
    expect(fwd.items).toEqual([{ key: 'f', value: '6' }]);
  });

  it('moreThanOneAnchorIsRefused, and an empty anchor is never sent', async () => {
    const { ctx, api } = setup();
    api.cacheItemsPage = vi.fn();
    const o = await read(ctx, { from: 'a', after: 'b' });
    expect(o.ok).toBe(false);
    expect(o.result).toContain('give at most one of from, before, after');
    for (const k of ['from', 'before', 'after']) {
      const e = await read(ctx, { [k]: '' });
      expect(e.ok).toBe(false);
      expect(e.result).toContain(`${k} must not be empty`);
    }
    expect(api.cacheItemsPage).not.toHaveBeenCalled();
  });

  it('aNeverSavedCacheAnswersItsAddedItems', async () => {
    const { ctx, api, store } = setup();
    api.cacheItemsPage = vi.fn();
    await call(ctx, 'set_cache_items', { cache_id: 'c1', items: [{ key: 'b', value: '2' }, { key: 'a', value: '1' }] });
    store.edit((b) => ({ ...b, caches: { c1: { ...b.caches.c1!, updatedAt: null } } }));
    const d = JSON.parse((await read(ctx, {})).result);
    expect(api.cacheItemsPage).not.toHaveBeenCalled();
    expect(d.items).toEqual([{ key: 'a', value: '1', state: 'added' }, { key: 'b', value: '2', state: 'added' }]);
    expect(d).toMatchObject({ index: 0, prev: null, next: null, unsaved: { modified: 0, added: 2, deleted: 0 }, rows: 'no stored rows on this page' });
  });

  it('aNeverSavedCacheOverTheCapIsWalkedByNext', async () => {
    const { ctx, api, store } = setup();
    api.cacheItemsPage = vi.fn();
    const keys = Array.from({ length: 10 }, (_, i) => `k${i}`);
    await call(ctx, 'set_cache_items', { cache_id: 'c1', items: keys.map((k) => ({ key: k, value: 'x'.repeat(30_000) })) });
    store.edit((b) => ({ ...b, caches: { c1: { ...b.caches.c1!, updatedAt: null } } }));
    const seen: string[] = [];
    let args: Record<string, unknown> = {};
    for (let guard = 0; guard < 20; guard++) {
      const d = JSON.parse((await read(ctx, args)).result);
      expect(d.note).toContain('not saved yet: it has no stored items, only the unsaved ones');
      seen.push(...d.items.map((i: { key: string }) => i.key));
      if (d.next === null) break;
      args = d.next;
    }
    expect(seen).toEqual(keys);
    expect(api.cacheItemsPage).not.toHaveBeenCalled();
  });

  it('aNeverSavedCacheHonoursBefore', async () => {
    const { ctx, api, store } = setup();
    api.cacheItemsPage = vi.fn();
    await call(ctx, 'set_cache_items', { cache_id: 'c1', items: ['a', 'b', 'c', 'd', 'e'].map((k) => ({ key: k, value: k })) });
    store.edit((b) => ({ ...b, caches: { c1: { ...b.caches.c1!, updatedAt: null } } }));
    const back = JSON.parse((await read(ctx, { before: 'e', limit: 2 })).result);
    expect(back.items.map((i: { key: string }) => i.key)).toEqual(['c', 'd']);
    expect(back.prev).toEqual({ before: 'c' });
    expect(back.next).toEqual({ from: 'e' });
    const first = JSON.parse((await read(ctx, { before: 'c', limit: 5 })).result);
    expect(first.items.map((i: { key: string }) => i.key)).toEqual(['a', 'b']);
    expect(first.prev).toBeNull();
    const after = JSON.parse((await read(ctx, { after: 'b', limit: 2 })).result);
    expect(after.items.map((i: { key: string }) => i.key)).toEqual(['c', 'd']);
  });

  it('aNeverSavedCacheAfterTheLastKeyIsEmpty, and a from past the end says none', async () => {
    const { ctx, api, store } = setup();
    api.cacheItemsPage = vi.fn();
    await call(ctx, 'set_cache_items', { cache_id: 'c1', items: ['a', 'b', 'c'].map((k) => ({ key: k, value: k })) });
    store.edit((b) => ({ ...b, caches: { c1: { ...b.caches.c1!, updatedAt: null } } }));
    for (const k of ['c', 'zz']) {
      const d = JSON.parse((await read(ctx, { after: k })).result);
      expect(d.items).toEqual([]);
      expect(d.prev).toEqual({ before: k });
      expect(d.next).toBeNull();
    }
    const j = JSON.parse((await read(ctx, { from: 'zz', limit: 2 })).result);
    expect(j.note).toContain('no key at or after "zz" — showing the last page');
    expect(j.items.map((i: { key: string }) => i.key)).toEqual(['b', 'c']);
  });

  it('the description names from, before, after and this page only', () => {
    const def = CACHE_ITEM_TOOLS.find((t) => t.name === 'read_cache_items')!;
    expect(def.description).toMatch(/from/);
    expect(def.description).toMatch(/before/);
    expect(def.description).toMatch(/after/);
    expect(def.description).toMatch(/this page only/);
  });

  it('read_cache_items cuts a page of large values to 100,000 characters, with next at the first row left out', async () => {
    const { ctx, api, store } = setup();
    withCount(store, 40);
    const rows = Array.from({ length: 10 }, (_, i) => ({ key: `k${i}`, value: 'x'.repeat(30_000) }));
    api.cacheItemsPage = vi.fn().mockResolvedValue(page(rows, 'k9'));
    await call(ctx, 'set_cache_items', { cache_id: 'c1', items: [{ key: 'k2', value: 'y' }, { key: 'k5', value: 'y' }] });
    const o = await read(ctx, {});
    expect(o.ok).toBe(true);
    expect(o.result.length).toBeLessThanOrEqual(100_000);
    const d = JSON.parse(o.result);
    expect(d.items.map((i: { key: string }) => i.key)).toEqual(['k0', 'k1', 'k2', 'k3']);
    expect(d.next).toEqual({ from: 'k4' });
    expect(d.unsaved).toEqual({ modified: 1, added: 0, deleted: 0 });
    expect(d.rows).toBe('1–4 of 40');
    expect(d.note).toMatch(/cut to 100000 characters/);
  });

  it('read_cache_items returns a single over-large row alone with its value shortened', async () => {
    const { ctx, api } = setup();
    api.cacheItemsPage = vi.fn().mockResolvedValue(page([{ key: 'big', value: 'y'.repeat(1_048_576) }, { key: 'small', value: '1' }], null));
    const o = await read(ctx, {});
    expect(o.result.length).toBeLessThanOrEqual(100_000);
    const d = JSON.parse(o.result);
    expect(d.items).toHaveLength(1);
    expect(d.items[0].key).toBe('big');
    expect(d.items[0].value_truncated).toBe(true);
    expect(d.items[0].value.length).toBeGreaterThan(90_000);
    expect(d.next).toEqual({ from: 'small' });
  });

  it('read_cache_items leaves a page that fits untouched', async () => {
    const { ctx, api } = setup();
    api.cacheItemsPage = vi.fn().mockResolvedValue(page([{ key: 'a', value: '1' }], null));
    const d = JSON.parse((await read(ctx, {})).result);
    expect(d.next).toBeNull();
    expect(d.note).not.toMatch(/cut/);
  });

  it('read_cache_items fails with the reason on a page error, and makes no call for a new cache', async () => {
    const { ctx, api, store } = setup();
    api.cacheItemsPage = vi.fn().mockResolvedValue({ ok: false, error: { kind: 'network', message: 'down' } });
    const o = done(await call(ctx, 'read_cache_items', { cache_id: 'c1' }));
    expect(o.ok).toBe(false);
    expect(o.result).toContain('could not read');
    store.edit((b) => ({ ...b, caches: { c1: { ...b.caches.c1!, updatedAt: null } } }));
    api.cacheItemsPage.mockClear();
    const n = done(await call(ctx, 'read_cache_items', { cache_id: 'c1' }));
    expect(n.ok).toBe(true);
    expect(api.cacheItemsPage).not.toHaveBeenCalled();
  });

  it('set_cache_items is one undo step and marks the cache unsaved', async () => {
    const { ctx, store } = setup();
    const before = store.state();
    const o = done(await call(ctx, 'set_cache_items', { cache_id: 'c1', items: [{ key: 'a', value: '1' }, { key: 'b', value: '2' }] }));
    expect(o.ok).toBe(true);
    expect(store.state().caches.c1!.itemEdits.set).toEqual({ a: '1', b: '2' });
    store.undo();
    expect(store.state()).toBe(before);
  });

  it('set_cache_items refuses a bad key naming it, and changes nothing', async () => {
    const { ctx, store } = setup();
    const before = store.state();
    const o = done(await call(ctx, 'set_cache_items', { cache_id: 'c1', items: [{ key: 'ok', value: '1' }, { key: 'a:b', value: '2' }] }));
    expect(o.ok).toBe(false);
    expect(o.result).toContain('a:b');
    expect(store.state()).toBe(before);
  });

  it('remove_cache_items marks stored keys removed, as one edit', async () => {
    const { ctx, store } = setup();
    const o = done(await call(ctx, 'remove_cache_items', { cache_id: 'c1', keys: ['a', 'b'] }));
    expect(o.ok).toBe(true);
    expect(store.state().caches.c1!.itemEdits.removed).toEqual(['a', 'b']);
  });
});

describe('items in read_board and set_field', () => {
  it('read_board has item_count and unsaved_items, not items', async () => {
    const { ctx } = setup();
    await call(ctx, 'set_cache_items', { cache_id: 'c1', items: [{ key: 'usd', value: '3.7' }] });
    const c = JSON.parse(done(await call(ctx, 'read_board')).result).caches[0];
    expect(c).toMatchObject({ id: 'c1', item_count: 0, unsaved_items: { set: { usd: '3.7' }, removed: [] } });
    expect(c).not.toHaveProperty('items');
  });

  it('set_field refuses items for a cache', async () => {
    const { ctx } = setup();
    const o = done(await call(ctx, 'set_field', { kind: 'cache', id: 'c1', field: 'items', value: '{}' }));
    expect(o.ok).toBe(false);
    expect(o.result).toContain('set_cache_items');
  });
});
