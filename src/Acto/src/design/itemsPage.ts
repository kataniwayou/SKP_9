import type { ItemEdits } from './board';

export type RowState = 'modified' | 'added' | 'deleted';
export type PageRow = { key: string; value: string; stored: string | null; state?: RowState };

export const collator = new Intl.Collator('en-US');

/*
 * Paging model (ruling R5, shared by the Inspector's Items list and the chat's read_cache_items).
 *
 * Pages tile the key space as half-open ranges [lower, upper): `lower` is the page's first key (inclusive; null = the
 * cache's start), `upper` the key the next page starts at (exclusive; null = the cache's end). Next reads `from: upper`,
 * Prev reads `before: lower`, so a page always begins exactly where the one before it ended. Stored rows come from
 * BaseApi; an unsaved added key is shown on the one page whose range holds it (collator compare), so it is never lost
 * and never shown twice.
 *
 * Every read asks for one row more than the page shows (`readLimit`):
 * - forward (first page, `from K`): the extra last row is not shown and becomes `upper`. No extra and `next` null: upper
 *   null. No extra but `next` set (BaseApi's 8,000,000-character budget cut the page): upper is the last returned key
 *   with `upperAfter`, so Next reads `after` it and that page's lower is that key with `lowerAfter`. The one known edge:
 *   Prev back across that boundary (`before` the key) misses that single row. Only reachable with >8M characters a page.
 * - a `from` past every stored key (`fromMatch: 'none'`): BaseApi answers the last page instead. For a jump the page is
 *   the last `limit` rows, lower = its first row, upper null; for Next (from an added key past the last stored key) it
 *   has no stored rows, only the added keys >= from.
 * - back (`before L`, Prev): the extra earliest row is not shown (index + 1). lower = the first shown row, or null when
 *   BaseApi's index says it is the cache's first key; upper = L.
 *
 * Merged rows past the page size: a forward page cuts the tail and upper becomes the first cut row's key (stored or
 * added); a back page cuts the head and lower becomes the first remaining row's key (index + the stored rows cut). The
 * start page too: cutting its tail instead would make a Prev walk skip the rows between its cut and the page it came from;
 * with the head cut it owns [first remaining row, upper) and a further Prev reaches the rest. A smaller fitted size cuts
 * the tail locally the same way.
 */

/**
 * Stored rows of one page (kept in the server's order) merged with the unsaved edits: modified and deleted marks on stored
 * rows, and the added keys with lower <= key < upper (null = unbounded) placed with the collator. Over `size` rows, `cut`
 * 'tail' keeps the first `size` and `cutAt` is the first cut row's key; 'head' keeps the last `size` and `cutAt` is the
 * first remaining row's key.
 */
export function pageView(
  stored: { key: string; value: string }[],
  edits: ItemEdits,
  bounds: { lower: string | null; upper: string | null; lowerAfter?: boolean },
  size: number,
  cut: 'tail' | 'head' = 'tail',
): { rows: PageRow[]; cut: boolean; cutAt: string | null } {
  const removed = new Set(edits.removed);
  const storedKeys = new Set(stored.map((s) => s.key));
  const rows: PageRow[] = stored.map((s) => {
    if (removed.has(s.key)) return { key: s.key, value: s.value, stored: s.value, state: 'deleted' as const };
    const next = Object.prototype.hasOwnProperty.call(edits.set, s.key) ? edits.set[s.key] : undefined;
    if (next !== undefined && next !== s.value) return { key: s.key, value: next, stored: s.value, state: 'modified' as const };
    return { key: s.key, value: s.value, stored: s.value };
  });
  const { lower, upper, lowerAfter } = bounds;
  const added: PageRow[] = [];
  for (const key of Object.keys(edits.set)) {
    if (storedKeys.has(key) || removed.has(key)) continue;
    if (lower !== null && collator.compare(key, lower) < (lowerAfter ? 1 : 0)) continue;
    if (upper !== null && collator.compare(key, upper) >= 0) continue;
    added.push({ key, value: edits.set[key], stored: null, state: 'added' });
  }
  added.sort((x, y) => collator.compare(x.key, y.key));
  for (const add of added) {
    let i = rows.findIndex((r) => collator.compare(add.key, r.key) < 0);
    if (i < 0) i = rows.length;
    rows.splice(i, 0, add);
  }
  if (rows.length <= size) return { rows, cut: false, cutAt: null };
  if (cut === 'tail') return { rows: rows.slice(0, size), cut: true, cutAt: rows[size].key };
  const kept = rows.slice(rows.length - size);
  return { rows: kept, cut: true, cutAt: kept[0].key };
}

/** A read of one page: forward from a key (null: the cache's start; `after`: exclusive, the budget edge), or back before one. */
export type PageRead =
  | { dir: 'forward'; from: string | null; after?: boolean; jump?: boolean }
  | { dir: 'back'; before: string };

/** The anchor BaseApi takes for a read. */
export function readAt(r: PageRead): { after: string } | { from: string } | { before: string } | null {
  if (r.dir === 'back') return { before: r.before };
  if (r.from === null) return null;
  return r.after ? { after: r.from } : { from: r.from };
}

/** How many rows to ask for: one more than the page shows (the forward page's upper, or the back page's start check). */
export const readLimit = (size: number) => size + 1;

/** What a read answered, before the unsaved edits: the stored rows to show and the range they own (see the model above). */
export type PageWindow = {
  stored: { key: string; value: string }[];
  lower: string | null;
  lowerAfter: boolean;
  upper: string | null;
  upperAfter: boolean;
  /** keys before the first stored row shown */
  index: number;
  /** the page size the read was for */
  limit: number;
  cut: 'tail' | 'head';
};

/** The window a read answered; `limit` is the page size (the read asked for `readLimit(limit)` rows). */
export function windowOf(
  r: PageRead,
  limit: number,
  answer: { items?: { key?: string | null; value?: string | null }[] | null; next?: string | null; index?: number; fromMatch?: string | null },
): PageWindow {
  let items = (answer.items ?? []).map((it) => ({ key: it.key ?? '', value: it.value ?? '' }));
  let index = answer.index ?? 0;
  if (r.dir === 'back') {
    if (items.length > limit) { items = items.slice(1); index += 1; }
    const lower = index === 0 || items.length === 0 ? null : items[0].key;
    return { stored: items, lower, lowerAfter: false, upper: r.before, upperAfter: false, index, limit, cut: 'head' };
  }
  if (!r.jump && answer.fromMatch === 'none') {
    // Next past the last stored key (from an added key): BaseApi answers the last page, but no stored row is >= from
    return { stored: [], lower: r.from, lowerAfter: r.after === true, upper: null, upperAfter: false, index: index + items.length, limit, cut: 'tail' };
  }
  if (answer.fromMatch === 'none') {
    // past every key: BaseApi answered the last rows; show the last `limit` of them, which own from their first row on
    if (items.length > limit) { index += items.length - limit; items = items.slice(items.length - limit); }
    return { stored: items, lower: items.length ? items[0].key : null, lowerAfter: false, upper: null, upperAfter: false, index, limit, cut: 'tail' };
  }
  let upper: string | null = null;
  let upperAfter = false;
  if (items.length > limit) { upper = items[limit].key; items = items.slice(0, limit); }
  else if (answer.next != null && items.length) { upper = items[items.length - 1].key; upperAfter = true; }
  return { stored: items, lower: r.from, lowerAfter: r.after === true, upper, upperAfter, index, limit, cut: 'tail' };
}

/** A page as shown: its rows at the fitted size and the range they own (Next reads from `upper`, Prev before `lower`). */
export type ShownPage = { rows: PageRow[]; lower: string | null; lowerAfter: boolean; upper: string | null; upperAfter: boolean; index: number };

/** The window merged with the unsaved edits at its read size, then cut from the tail to `size` when the panel is smaller. */
export function shownPage(w: PageWindow, edits: ItemEdits, size: number): ShownPage {
  const v = pageView(w.stored, edits, { lower: w.lower, upper: w.upper, lowerAfter: w.lowerAfter }, w.limit, w.cut);
  let { lower, lowerAfter, upper, upperAfter, index } = w;
  let rows = v.rows;
  if (v.cut && w.cut === 'tail') { upper = v.cutAt; upperAfter = false; }
  if (v.cut && w.cut === 'head') {
    lower = v.cutAt;
    lowerAfter = false;
    index += w.stored.length - rows.filter((r) => r.stored !== null).length;
  }
  if (rows.length > size) { upper = rows[size].key; upperAfter = false; rows = rows.slice(0, size); }
  return { rows, lower, lowerAfter, upper, upperAfter, index };
}

export function pageSummary(rows: PageRow[]): { modified: number; added: number; deleted: number } {
  const s = { modified: 0, added: 0, deleted: 0 };
  for (const r of rows) if (r.state) s[r.state]++;
  return s;
}

export function summaryText(s: { modified: number; added: number; deleted: number }): string {
  const parts = (['modified', 'added', 'deleted'] as const).filter((k) => s[k] > 0).map((k) => `${s[k]} ${k}`);
  return parts.length ? `on this page: ${parts.join(' · ')}` : 'no unsaved changes on this page';
}
