import { describe, expect, it, vi } from 'vitest';
import { call, done, setup } from './testContext';

const page = (items: { key: string; value: string }[], next: string | null = null) => ({ ok: true, value: { items, next } });

describe('cache item tools', () => {
  it('read_cache_items returns one page and says so', async () => {
    const { ctx, api, store } = setup();
    store.load({ ...store.state(), caches: { c1: { ...store.state().caches.c1!, itemCount: 3 } } });
    api.cacheItemsPage = vi.fn().mockResolvedValue(page([{ key: 'a', value: '1' }, { key: 'b', value: '2' }], 'b'));
    await call(ctx, 'set_cache_items', { cache_id: 'c1', items: [{ key: 'a', value: 'X' }, { key: 'z', value: '9' }] });
    await call(ctx, 'remove_cache_items', { cache_id: 'c1', keys: ['b'] });
    const o = done(await call(ctx, 'read_cache_items', { cache_id: 'c1', limit: 2 }));
    expect(o.ok).toBe(true);
    expect(api.cacheItemsPage).toHaveBeenCalledWith('c1', undefined, 2);
    const d = JSON.parse(o.result);
    expect(d.items).toEqual([{ key: 'a', value: 'X' }]);
    expect(d.next).toBe('b');
    expect(d.item_count).toBe(3);
    expect(d.unsaved).toEqual({ set: { a: 'X', z: '9' }, removed: ['b'] });
    expect(d.note).toMatch(/one page of 3/);
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
