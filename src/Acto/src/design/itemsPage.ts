import type { ItemEdits } from './board';

export type RowState = 'modified' | 'added' | 'deleted';
export type PageRow = { key: string; value: string; stored: string | null; state?: RowState };

const collator = new Intl.Collator('en-US');

/** Stored rows of one page merged with the unsaved edits that fall on it, sorted and cut to size. */
export function pageView(
  stored: { key: string; value: string }[],
  edits: ItemEdits,
  edges: { atStart: boolean; atEnd: boolean },
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
  const sortedStored = stored.map((s) => s.key).sort(collator.compare);
  const first = sortedStored[0];
  const last = sortedStored[sortedStored.length - 1];
  for (const key of Object.keys(edits.set)) {
    if (storedKeys.has(key) || removed.has(key)) continue;
    const lowOk = first === undefined ? edges.atStart : edges.atStart || collator.compare(key, first) > 0;
    const highOk = last === undefined ? edges.atEnd : edges.atEnd || collator.compare(key, last) < 0;
    if (lowOk && highOk) rows.push({ key, value: edits.set[key], stored: null, state: 'added' });
  }
  rows.sort((a, b) => collator.compare(a.key, b.key));
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

export function cursors(rows: PageRow[]): { after: string | null; before: string | null } {
  return rows.length
    ? { after: rows[rows.length - 1].key, before: rows[0].key }
    : { after: null, before: null };
}
