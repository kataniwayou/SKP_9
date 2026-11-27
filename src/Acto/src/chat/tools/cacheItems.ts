import { removeCacheItem, setCacheItem } from '../../design/edits';
import type { BoardState } from '../../design/board';
import { describeError } from '../../api/describeError';
import { pageSummary, readAt, readLimit, shownPage, windowOf, type PageRead, type PageRow, type PageWindow, type ShownPage } from '../../design/itemsPage';
import type { ToolDef } from '../toolTypes';
import { applyState, CACHE_ID, done, fail, onBoard, text } from './common';

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;
/** Most characters read_cache_items hands back: a page of large values is cut to this, so one call cannot flood the chat. */
export const READ_TEXT_CAP = 100_000;

type Anchor = { from: string } | { after: string } | { before: string };

/** One page as the answer shows it (the Inspector's page: see design/itemsPage.ts). */
export type ChatPage = {
  itemCount: number;
  index: number;
  rows: PageRow[];
  prev: Anchor | null;
  next: Anchor | null;
  /** the jump note of the Inspector ("no key ..."), when the read was a jump that did not match exactly */
  jumpNote: string | null;
};

const collator = new Intl.Collator('en-US');
const n = (x: number) => x.toLocaleString('en-US');

/** The ready-to-pass anchors of a page's edges. */
function anchors(upper: string | null, upperAfter: boolean, lower: string | null): { prev: Anchor | null; next: Anchor | null } {
  return {
    prev: lower === null ? null : { before: lower },
    next: upper === null ? null : upperAfter ? { after: upper } : { from: upper },
  };
}

function jumpNoteOf(text: string, match: string | null | undefined): string | null {
  if (match === 'later') return `no key "${text}" — showing from the next key`;
  if (match === 'none') return `no key at or after "${text}" — showing the last page`;
  return null;
}

/**
 * The answer's JSON, at most READ_TEXT_CAP characters. When the whole page does not fit, rows are cut from the end: `next`
 * becomes `{from: <first cut row's key>}` (so the following call resumes exactly there), the per-page `unsaved` counts the
 * rows actually returned, and the note says the page was cut. A first row that alone does not fit is still returned, its
 * value shortened (`value_truncated`).
 */
export function cappedPage(page: ChatPage): string {
  const { itemCount, index, prev, jumpNote } = page;
  const all = page.rows;
  const render = (rows: unknown[], shown: PageRow[], nx: Anchor | null, cut: boolean) => {
    const storedShown = shown.filter((r) => r.stored !== null).length;
    const note = `one page of ${n(itemCount)} items${cut ? ` (cut to ${READ_TEXT_CAP} characters)` : ''}${nx === null ? ' (the last page)' : ': more follow, pass next as given'}; unsaved edits applied${jumpNote ? `; ${jumpNote}` : ''}`;
    return JSON.stringify({
      item_count: itemCount, index,
      rows: storedShown === 0 ? 'no stored rows on this page' : `${n(index + 1)}–${n(index + storedShown)} of ${n(itemCount)}`,
      items: rows, prev, next: nx, unsaved: pageSummary(shown), note,
    });
  };
  const view = (r: PageRow) => (r.state ? { key: r.key, value: r.value, state: r.state } : { key: r.key, value: r.value });
  const whole = render(all.map(view), all, page.next, false);
  if (whole.length <= READ_TEXT_CAP) return whole;

  const nextAt = (i: number): Anchor => ({ from: all[i]!.key });
  const SLACK = 64; // the counts and row range grow a few digits as rows are added
  let k = 0;
  let used = 0;
  for (; k < all.length; k++) {
    const add = JSON.stringify(view(all[k]!)).length + (k > 0 ? 1 : 0);
    if (render([], [], nextAt(k), true).length + SLACK + used + add > READ_TEXT_CAP) break;
    used += add;
  }
  if (k === 0 && all.length > 0) {
    const first = all[0]!;
    const nx = all.length > 1 ? nextAt(1) : page.next;
    const one = (take: number) => render([{ key: first.key, value: first.value.slice(0, take), ...(first.state ? { state: first.state } : {}), value_truncated: true }], [first], nx, true);
    let take = Math.max(0, READ_TEXT_CAP - one(0).length);
    let out = one(take);
    // JSON escaping can lengthen the value: shorten until it fits
    while (out.length > READ_TEXT_CAP && take > 0) { take = Math.floor(take * 0.9); out = one(take); }
    return out;
  }
  for (;;) {
    const shown = all.slice(0, k);
    const out = render(shown.map(view), shown, k < all.length ? nextAt(k) : page.next, k < all.length);
    if (out.length <= READ_TEXT_CAP || k <= 1) return out;
    k--;
  }
}

const ANCHOR_NAMES = ['from', 'before', 'after'] as const;

const readCacheItems: ToolDef = {
  name: 'read_cache_items',
  description: `Read ONE PAGE of a cache's stored items, as the Inspector's Items list shows it, with this session's unsaved edits applied to it: an unsaved value replaces the stored one (state "modified"), a key marked removed stays with state "deleted", and an unsaved new key that falls in the page's key range is a row with state "added". Pages tile the key space in key order. Give at most one of \`from\` (jump: the page starting at that key, or at the next key when there is none; the note says so), \`before\` (the page before that key) or \`after\` (the page after that key); with none you get the first page. Never send an empty text. \`limit\` is the page size (default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}). The answer gives item_count, index (stored rows before this page), rows ("a–b of N"), items [{key, value, state?}], and ready-to-pass \`prev\` and \`next\` anchors (pass one as given in the next call; null at the ends), and \`unsaved\` {modified, added, deleted}: counts for this page only, not the whole cache (read_board lists the whole cache's unsaved items). A cache never saved has no stored items: its unsaved items are the rows, all "added". The answer is at most ${READ_TEXT_CAP} characters: a page of large values is cut from the end, \`next\` then starts at the first row left out, and the note says it was cut.`,
  parameters: {
    type: 'object',
    properties: {
      cache_id: CACHE_ID,
      from: { type: 'string', description: 'Jump to the page starting at this key (or the next key after it). Not empty.' },
      before: { type: 'string', description: "The previous page's `prev.before`: the page before this key. Not empty." },
      after: { type: 'string', description: "A page's `next.after`: the page after this key. Not empty." },
      limit: { type: 'number' },
    },
    required: ['cache_id'], additionalProperties: false,
  },
  async run(ctx, args) {
    const c = onBoard(ctx, 'cache', text(args, 'cache_id'), 'read cache items');
    if ('out' in c) return c.out;
    const given = ANCHOR_NAMES.filter((k) => args[k] !== undefined && args[k] !== null);
    if (given.length > 1) return fail('give at most one of from, before, after', 'read cache items refused');
    for (const k of given) {
      if (typeof args[k] !== 'string') return fail(`${k} must be a key text`, 'read cache items refused');
      if (args[k] === '') return fail(`${k} must not be empty`, 'read cache items refused');
    }
    const row = ctx.store.state().caches[c.id]!;
    const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(args.limit))) : DEFAULT_LIMIT;
    const label = `read items of ${row.name}`;
    const finish = (shown: ShownPage, jumpNote: string | null) =>
      done(true, cappedPage({ itemCount: row.itemCount, index: shown.index, rows: shown.rows, jumpNote, ...anchors(shown.upper, shown.upperAfter, shown.lower) }), label);
    const which = given[0];
    const key = which ? (args[which] as string) : null;
    if (row.updatedAt === null) {
      // nothing stored: the unsaved keys are the whole cache; page them in memory by the same [lower, upper) model
      const empty: PageWindow = { stored: [], lower: null, lowerAfter: false, upper: null, upperAfter: false, index: 0, limit: Number.MAX_SAFE_INTEGER, cut: 'tail' };
      const all = shownPage(empty, row.itemEdits, Number.MAX_SAFE_INTEGER).rows;
      const firstAt = (strict: boolean) => { const i = all.findIndex((r) => collator.compare(r.key, key!) >= (strict ? 1 : 0)); return i < 0 ? all.length : i; };
      let start = 0;
      let jumpNote: string | null = null;
      if (which === 'from') {
        start = firstAt(false);
        if (start === all.length && all.length > 0) start = Math.max(0, all.length - limit);
        jumpNote = jumpNoteOf(key!, start === all.length ? (all.length === 0 ? 'exact' : 'none') : all[start]!.key === key ? 'exact' : 'later');
      } else if (which === 'after') start = firstAt(true);
      else if (which === 'before') start = Math.max(0, firstAt(false) - limit);
      const end = which === 'before' ? firstAt(false) : Math.min(all.length, start + limit);
      const rows = all.slice(start, end);
      const note = [jumpNote, 'not saved yet: it has no stored items, only the unsaved ones'].filter(Boolean).join('; ');
      return done(true, cappedPage({
        itemCount: row.itemCount, index: 0, rows, jumpNote: note,
        prev: start > 0 ? { before: all[start]!.key } : null,
        next: end < all.length ? { from: all[end]!.key } : null,
      }), label);
    }
    const read: PageRead = which === 'before' ? { dir: 'back', before: key! }
      : which === 'after' ? { dir: 'forward', from: key, after: true }
        : { dir: 'forward', from: key, ...(which === 'from' ? { jump: true } : {}) };
    const r = await ctx.api.cacheItemsPage(c.id, readAt(read), readLimit(limit));
    if (!r.ok) return fail(`could not read the items of cache ${c.id}. ${describeError(r.error)}`, 'read cache items failed');
    // the board may have changed while the page was read: apply the overlay as it is now
    const edits = ctx.store.state().caches[c.id]?.itemEdits ?? row.itemEdits;
    const shown = shownPage(windowOf(read, limit, r.value), edits, limit);
    return finish(shown, which === 'from' ? jumpNoteOf(key!, r.value.fromMatch) : null);
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
