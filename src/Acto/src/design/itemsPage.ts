import type { ItemEdits } from './board';

export type RowState = 'modified' | 'added' | 'deleted';
export type PageRow = { key: string; value: string; stored: string | null; state?: RowState };

const collator = new Intl.Collator('en-US');

/**
 * The key range a page owns: (lower, upper]. `lower` is the key just before the page's first stored row, `null` when the page
 * starts at the cache's start; `inclusive` when that key may itself be on the page (a `from` read). The upper end is the last
 * stored row of the page, or open when the read reached the cache's end (`atEnd`, the answer's `next` was null).
 * Where `lower` comes from, per read: first page → null; `after: k` → { k, exclusive }; `from: t` → { t, inclusive };
 * `before: k` read with limit+1 → the extra earliest row, exclusive (not shown), or null when fewer than limit+1 came back.
 */
export type PageBounds = { lower: { key: string; inclusive: boolean } | null; atEnd: boolean };

/**
 * Stored rows of one page merged with the unsaved added keys that fall in its range (see `PageBounds`), cut to `size`.
 * Every added key falls in exactly one page's range, so it is never lost; when a cut hides rows, the next page should be
 * read after the last visible row (stored or added) so the rest of the range carries over.
 */
export function pageView(
  stored: { key: string; value: string }[],
  edits: ItemEdits,
  bounds: PageBounds,
  size: number,
): { rows: PageRow[]; cut: boolean } {
  const removed = new Set(edits.removed);
  const storedKeys = new Set(stored.map((s) => s.key));
  const rows: PageRow[] = stored.map((s) => {
    if (removed.has(s.key)) return { key: s.key, value: s.value, stored: s.value, state: 'deleted' as const };
    const next = Object.prototype.hasOwnProperty.call(edits.set, s.key) ? edits.set[s.key] : undefined;
    if (next !== undefined && next !== s.value) return { key: s.key, value: next, stored: s.value, state: 'modified' as const };
    return { key: s.key, value: s.value, stored: s.value };
  });
  // Stored rows keep the server's order; only unsaved added keys are placed with the collator.
  const last = stored.length ? stored[stored.length - 1].key : undefined;
  const { lower, atEnd } = bounds;
  const added: PageRow[] = [];
  for (const key of Object.keys(edits.set)) {
    if (storedKeys.has(key) || removed.has(key)) continue;
    const lowOk = lower === null || (lower.inclusive ? collator.compare(key, lower.key) >= 0 : collator.compare(key, lower.key) > 0);
    const highOk = atEnd || (last !== undefined && collator.compare(key, last) <= 0);
    if (lowOk && highOk) added.push({ key, value: edits.set[key], stored: null, state: 'added' });
  }
  added.sort((x, y) => collator.compare(x.key, y.key));
  for (const add of added) {
    let i = rows.findIndex((r) => collator.compare(add.key, r.key) < 0);
    if (i < 0) i = rows.length;
    rows.splice(i, 0, add);
  }
  const cut = rows.length > size;
  return { rows: cut ? rows.slice(0, size) : rows, cut };
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

/** Cursors prefer the visible stored keys (they came from the server); added keys only when no stored row is visible. */
export function cursors(rows: PageRow[]): { after: string | null; before: string | null } {
  const stored = rows.filter((r) => r.stored !== null);
  const src = stored.length ? stored : rows;
  return src.length
    ? { after: src[src.length - 1].key, before: src[0].key }
    : { after: null, before: null };
}
