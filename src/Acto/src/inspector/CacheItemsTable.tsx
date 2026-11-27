import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { StudioApi } from '../api/client';
import { describeError } from '../api/describeError';
import type { CacheItemsPage, ItemsAt } from '../api/types';
import type { CacheRow } from '../design/board';
import { removeCacheItem, revertCacheItem, setCacheItem } from '../design/edits';
import { cursors, pageSummary, pageView, summaryText, type PageBounds, type PageRow } from '../design/itemsPage';
import type { Edit } from './tabs/shared';
import { useFitRows } from './useFitRows';

/** One read: where the page starts, how many rows, and the typed text when it is a jump (the note comes from its answer). */
type Req = { at: ItemsAt; limit: number; jump?: string };
type Status = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ok' };
/** A page as shown: its stored rows, how many keys sort before them, whether more follow, and the key range it owns. */
type Loaded = { stored: { key: string; value: string }[]; index: number; next: string | null; lower: PageBounds['lower'] };

/**
 * The answer to `at` as a page that owns (lower, last stored row]. A `before` read asks for one row more than it shows: that
 * earliest row is the exclusive lower bound (fewer came back: the page starts at the cache's start).
 */
function loadedOf(at: ItemsAt, limit: number, p: CacheItemsPage): Loaded {
  let stored = (p.items ?? []).map((it) => ({ key: it.key ?? '', value: it.value ?? '' }));
  let index = p.index ?? 0;
  let lower: PageBounds['lower'] = null;
  if (at && 'after' in at) lower = { key: at.after, inclusive: false };
  else if (at && 'from' in at) {
    // nothing at or after the text: the answer is the last page, which owns from its first row on
    if (p.fromMatch === 'none') lower = stored.length ? { key: stored[0]!.key, inclusive: true } : null;
    else lower = { key: at.from, inclusive: true };
  } else if (at && 'before' in at && stored.length > limit) {
    lower = { key: stored[0]!.key, inclusive: false };
    stored = stored.slice(1);
    index += 1;
  }
  return { stored, index, next: p.next ?? null, lower };
}

const STRUCK = { textDecoration: 'line-through', opacity: 0.6 } as const;
const n = (x: number) => x.toLocaleString('en-US');
const ROW_CLASS = { modified: 'mod', added: 'add', deleted: 'del' } as const;

/** A value cell: a click edits it, Enter or leaving commits (only a change), Escape puts it back. */
function Cell({ label, value, onCommit, struck }: { label: string; value: string; onCommit: (v: string) => void; struck?: boolean }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDraft(value); }
  };
  return (
    <input className="dict-cell" aria-label={label} spellCheck={false} readOnly={struck === true} value={draft}
      style={struck ? STRUCK : undefined}
      onChange={(e) => setDraft(e.target.value)} onKeyDown={keys}
      onBlur={() => { if (draft !== value) onCommit(draft); }} />
  );
}

function noteOf(text: string, match: string | null | undefined): string | null {
  if (match === 'later') return `no key "${text}" — showing from the next key`;
  if (match === 'none') return `no key at or after "${text}" — showing the last page`;
  return null;
}

/**
 * A cache's items as one page that fits the Inspector's height (no scrolling inside the list): the stored page read from the
 * server with this session's unsaved edits shown in place (amber modified, green added, struck deleted), a jump-to-key box,
 * a summary of the unsaved changes on screen only, Prev / Next and the position, and an add-key row. Each commit is its own
 * board undo step; Save is the board's. A new cache (not saved yet), or no `api`, has nothing stored to read: only its added rows.
 */
export function CacheItemsTable({ cache, isNew, api, edit }: { cache: CacheRow; isNew: boolean; api?: StudioApi | undefined; edit: Edit }) {
  const { id, updatedAt, itemCount, itemEdits } = cache;
  const fitRef = useRef<HTMLDivElement>(null);
  const size = useFitRows(fitRef);
  const [req, setReq] = useState<Req>({ at: null, limit: size });
  const [stamp, setStamp] = useState(updatedAt);
  const [tries, setTries] = useState(0);
  const [status, setStatus] = useState<Status>({ state: 'loading' });
  const [page, setPage] = useState<Loaded | null>(null);
  // where the last page with stored rows was read from: Prev from a page with none (past the last stored key) goes back there
  const [back, setBack] = useState<ItemsAt>(null);
  const [jumpText, setJumpText] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [refused, setRefused] = useState<string | null>(null);
  const seq = useRef(0);
  const reads = !isNew && api !== undefined;

  // what is on screen: the stored page with the unsaved edits that fall on it, cut to the fitted size
  const view = reads
    ? pageView(page?.stored ?? [], itemEdits, { lower: page?.lower ?? null, atEnd: page ? page.next === null : true }, size)
    : pageView([], itemEdits, { lower: null, atEnd: true }, Number.MAX_SAFE_INTEGER);
  const rows: PageRow[] = view.rows;

  // a Save that read the board again: the stored items may have changed under the cursors, so start from the first page
  if (stamp !== updatedAt) { setStamp(updatedAt); setReq({ at: null, limit: size }); setNote(null); }
  // taller: one read from the first visible row with the new size (shorter: rows drop off the bottom, no read)
  else if (reads && size > req.limit) setReq({ at: page && rows.length ? { from: rows[0]!.key } : req.at, limit: size });

  useEffect(() => {
    if (!reads) return;
    const mine = ++seq.current;
    setStatus({ state: 'loading' });
    const drop = () => mine !== seq.current;
    const { at, limit } = req;
    // a before read takes one row more: the earliest is the page's lower bound, not shown
    api.cacheItemsPage(id, at, at && 'before' in at ? limit + 1 : limit).then((r) => {
      if (drop()) return;
      if (!r.ok) { setStatus({ state: 'error', message: describeError(r.error) }); return; }
      const loaded = loadedOf(at, limit, r.value);
      setPage(loaded);
      if (loaded.stored.length) setBack(at);
      setStatus({ state: 'ok' });
      if (req.jump !== undefined) setNote(noteOf(req.jump, r.value.fromMatch));
    }, (e: unknown) => {
      if (!drop()) setStatus({ state: 'error', message: e instanceof Error ? e.message : String(e) });
    });
  }, [reads, api, id, req, tries]);

  const go = (at: ItemsAt, jump?: string) => {
    setNote(null);
    setReq(jump === undefined ? { at, limit: size } : { at, limit: size, jump });
  };
  const jump = () => { if (jumpText !== '') go({ from: jumpText }, jumpText); };
  const jumpKeys = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') { e.preventDefault(); jump(); } };
  const clearJump = () => { setJumpText(''); go(null); };
  // after a cut, the next page starts after the last visible row (stored or added), so the rest of this range carries over
  const next = () => {
    const after = view.cut ? rows[rows.length - 1]?.key : cursors(rows).after ?? page?.next;
    if (after) go({ after });
  };
  // one page back: before the first visible stored key; a page without stored rows (Next past the last stored key) re-reads
  // the page shown before it at the current size, so that page's last stored key is not lost
  const prev = () => {
    const first = rows.find((r) => r.stored !== null)?.key;
    go(first !== undefined ? { before: first } : back);
  };

  const setItem = (key: string, value: string): boolean => {
    let why: string | null = null;
    edit((b) => {
      const r = setCacheItem(b, id, key, value);
      if ('refused' in r) { why = r.refused; return b; }
      return r.state;
    });
    setRefused(why);
    return why === null;
  };
  const remove = (key: string) => edit((b) => removeCacheItem(b, id, key, true));
  const revert = (key: string) => edit((b) => revertCacheItem(b, id, key));
  const add = () => {
    if (setItem(newKey, newValue)) { setNewKey(''); setNewValue(''); }
  };
  const addKeys = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };

  const summary = pageSummary(rows);
  const anyChange = summary.modified + summary.added + summary.deleted > 0;
  const index = page?.index ?? 0;
  const storedShown = rows.filter((r) => r.stored !== null).length;
  const pageNo = Math.floor(index / size) + 1;
  const pages = `page ${n(pageNo)} of ${n(Math.max(1, Math.ceil(itemCount / size), pageNo))}`;
  const position = rows.length === 0 ? 'no items'
    : storedShown === 0 ? pages
      : `rows ${n(index + 1)}–${n(index + storedShown)} · ${pages}`;
  const showTable = !reads || status.state === 'ok' || (status.state === 'loading' && page !== null);

  return (
    <div className="fld dict-row dict-fill">
      <span>{`Items · ${n(itemCount)} stored`}</span>
      {reads && (
        <>
          <div className="dict-jump">
            <input className="dict-cell" aria-label="Jump to key" spellCheck={false} placeholder="jump to key…" value={jumpText}
              onChange={(e) => setJumpText(e.target.value)} onKeyDown={jumpKeys} />
            <button type="button" className="pbtn" onClick={jump}>Go</button>
            <button type="button" className="pbtn" aria-label="Clear jump" onClick={clearJump}>×</button>
          </div>
          {note !== null && <div className="dict-note" role="note">{note}</div>}
        </>
      )}
      <div className="dict-sum" role="status">
        {anyChange ? (
          <>
            <span>on this page:</span>
            {(['modified', 'added', 'deleted'] as const).filter((k) => summary[k] > 0).map((k) => (
              <span key={k}>{' '}<span className={`dict-chip ${ROW_CLASS[k]}`}>{`${summary[k]} ${k}`}</span></span>
            ))}
          </>
        ) : summaryText(summary)}
      </div>
      <div className={reads ? 'dict-fit' : 'dict-fit loose'} ref={fitRef}>
        {reads && status.state === 'loading' && page === null && <div className="dict-count">Loading items…</div>}
        {reads && status.state === 'error' && (
          <div className="dict-err" role="alert">{`Items could not be read: ${status.message} `}
            <button type="button" className="dict-add" onClick={() => setTries((t) => t + 1)}>Retry</button></div>
        )}
        {showTable && (
          <table className="dict-table" aria-label="Items">
            <thead><tr><th>Key</th><th>Value</th><th aria-label="Delete" /></tr></thead>
            <tbody>
              {rows.map((r) => {
                const gone = r.state === 'deleted';
                return (
                  <tr key={r.key} className={r.state ? ROW_CLASS[r.state] : undefined}>
                    <td><input className="dict-cell" readOnly aria-label={`Key ${r.key}`} value={r.key} style={gone ? STRUCK : undefined} /></td>
                    <td><Cell label={`Value ${r.key}`} value={r.value} struck={gone} onCommit={(v) => setItem(r.key, v)} /></td>
                    <td className="dict-x">
                      {r.state
                        ? <button type="button" className="dict-del" aria-label={`${gone ? 'Restore' : 'Revert'} ${r.key}`} onClick={() => revert(r.key)}>↺</button>
                        : <button type="button" className="dict-del" aria-label={`Remove ${r.key}`} onClick={() => remove(r.key)}>×</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {reads && (
        <div className="dict-nav">
          <button type="button" className="pbtn" aria-label="Prev" disabled={!page || page.index === 0} onClick={prev}>‹ Prev</button>
          <button type="button" className="pbtn" aria-label="Next" disabled={!page || (page.next == null && !view.cut)} onClick={next}>Next ›</button>
          <span className="dict-pos">{page ? position : ''}</span>
        </div>
      )}
      <div className="dict-addrow">
        <input className="dict-cell" aria-label="New key" spellCheck={false} placeholder="key" value={newKey}
          onChange={(e) => setNewKey(e.target.value)} onKeyDown={addKeys} />
        <input className="dict-cell" aria-label="New value" spellCheck={false} placeholder="value" value={newValue}
          onChange={(e) => setNewValue(e.target.value)} onKeyDown={addKeys} />
        <button type="button" className="pbtn" onClick={add}>Add item</button>
      </div>
      {refused !== null && <div className="dict-err" role="alert">{refused}</div>}
    </div>
  );
}
