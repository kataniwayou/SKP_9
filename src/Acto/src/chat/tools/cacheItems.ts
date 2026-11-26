import { removeCacheItem, setCacheItem } from '../../design/edits';
import type { BoardState } from '../../design/board';
import { describeError } from '../../api/describeError';
import type { ToolDef } from '../toolTypes';
import { applyState, CACHE_ID, done, fail, onBoard, text } from './common';

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;

const readCacheItems: ToolDef = {
  name: 'read_cache_items',
  description: `Read ONE PAGE of a cache's stored items (BaseApi pages them: \`after\` is the \`next\` of the previous page, \`limit\` default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}), with this session's unsaved edits applied to it: an unsaved value replaces the stored one, a key marked removed is left out. The answer always says it is one page of item_count; \`unsaved\` lists every unsaved set and removed key of the whole cache (a set key may be on a later page, or new). A cache never saved has no stored items: only \`unsaved\` is given.`,
  parameters: {
    type: 'object',
    properties: { cache_id: CACHE_ID, after: { type: 'string', description: "The previous page's `next`; leave out for the first page." }, limit: { type: 'number' } },
    required: ['cache_id'], additionalProperties: false,
  },
  async run(ctx, args) {
    const c = onBoard(ctx, 'cache', text(args, 'cache_id'), 'read cache items');
    if ('out' in c) return c.out;
    const row = ctx.store.state().caches[c.id]!;
    const unsaved = { set: row.itemEdits.set, removed: row.itemEdits.removed };
    if (row.updatedAt === null) {
      return done(true, JSON.stringify({ item_count: 0, items: [], next: null, unsaved, note: 'not saved yet: it has no stored items, only the unsaved ones' }), `read items of ${row.name}`);
    }
    const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(args.limit))) : DEFAULT_LIMIT;
    const after = text(args, 'after') || undefined;
    const r = await ctx.api.cacheItemsPage(c.id, after, limit);
    if (!r.ok) return fail(`could not read the items of cache ${c.id}. ${describeError(r.error)}`, 'read cache items failed');
    // the board may have changed while the page was read: apply the overlay as it is now
    const edits = ctx.store.state().caches[c.id]?.itemEdits ?? row.itemEdits;
    const items = (r.value.items ?? [])
      .filter((i): i is { key: string; value?: string | null } => typeof i.key === 'string' && !edits.removed.includes(i.key))
      .map((i) => ({ key: i.key, value: Object.hasOwn(edits.set, i.key) ? edits.set[i.key]! : i.value ?? '' }));
    const note = `one page of ${row.itemCount} items${r.value.next === null ? ' (the last page)' : `: more follow, pass after=${JSON.stringify(r.value.next)}`}; unsaved edits applied`;
    return done(true, JSON.stringify({ item_count: row.itemCount, items, next: r.value.next, unsaved: { set: edits.set, removed: edits.removed }, note }), `read items of ${row.name}`);
  },
};

const setCacheItems: ToolDef = {
  name: 'set_cache_items',
  description: "Set (add or overwrite) items of a cache, unsaved and as one undoable edit: Save sends them to BaseApi. All or none: a bad key or value (empty key, ':' in a key, key over 256 characters, a value over its limit) refuses the whole call naming the key.",
  parameters: {
    type: 'object',
    properties: {
      cache_id: CACHE_ID,
      items: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'], additionalProperties: false } },
    },
    required: ['cache_id', 'items'], additionalProperties: false,
  },
  async run(ctx, args) {
    const c = onBoard(ctx, 'cache', text(args, 'cache_id'), 'set cache items');
    if ('out' in c) return c.out;
    const list = args.items;
    if (!Array.isArray(list) || list.length === 0) return fail('items must be a non-empty list of {key, value}', 'set cache items');
    let b: BoardState = ctx.store.state();
    for (const it of list) {
      const key = (it as { key?: unknown } | null)?.key;
      const value = (it as { value?: unknown } | null)?.value;
      if (typeof key !== 'string' || typeof value !== 'string') return fail('every item needs a text key and a text value', 'set cache items');
      const res = setCacheItem(b, c.id, key, value);
      if ('refused' in res) return fail(`item "${key}": ${res.refused}; nothing was changed`, 'set cache items refused');
      b = res.state;
    }
    const name = ctx.store.state().caches[c.id]!.name;
    const final = b;
    return applyState(ctx, () => final, `set ${list.length} items of ${name}`, `set ${list.length} item(s) of cache ${name}; not saved yet`);
  },
};

const removeCacheItems: ToolDef = {
  name: 'remove_cache_items',
  description: "Remove items of a cache by key, unsaved and as one undoable edit. A key set on the board and never saved is just forgotten. On a cache already saved every key is treated as stored and marked for removal at Save (BaseApi reports a key it does not hold as not found, which is harmless); on a cache never saved nothing is marked.",
  parameters: {
    type: 'object',
    properties: { cache_id: CACHE_ID, keys: { type: 'array', items: { type: 'string' } } },
    required: ['cache_id', 'keys'], additionalProperties: false,
  },
  async run(ctx, args) {
    const c = onBoard(ctx, 'cache', text(args, 'cache_id'), 'remove cache items');
    if ('out' in c) return c.out;
    const keys = args.keys;
    if (!Array.isArray(keys) || keys.length === 0 || keys.some((k) => typeof k !== 'string' || k === '')) return fail('keys must be a non-empty list of key texts', 'remove cache items');
    const name = ctx.store.state().caches[c.id]!.name;
    return applyState(ctx, (cur) => {
      const stored = cur.caches[c.id]!.updatedAt !== null;
      return (keys as string[]).reduce((acc, k) => removeCacheItem(acc, c.id, k, stored), cur);
    }, `remove ${keys.length} items of ${name}`, `removed ${keys.length} item(s) of cache ${name}; not saved yet`);
  },
};

export const CACHE_ITEM_TOOLS: ToolDef[] = [readCacheItems, setCacheItems, removeCacheItems];
