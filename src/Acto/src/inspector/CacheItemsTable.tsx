import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { StudioApi } from '../api/client';
import { describeError } from '../api/describeError';
import type { CacheItemsPage, ItemsAt } from '../api/types';
import type { CacheRow } from '../design/board';
import { removeCacheItem, revertCacheItem, setCacheItem } from '../design/edits';
import { cursors, pageSummary, pageView, summaryText, type PageRow } from '../design/itemsPage';
import type { Edit } from './tabs/shared';
import { useFitRows } from './useFitRows';

/** One read: where the page starts, how many rows, and the typed text when it is a jump (the note comes from its answer). */
type Req = { at: ItemsAt; limit: number; jump?: string };
type Status = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ok' };

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
  const [page, setPage] = useState<CacheItemsPage | null>(null);
  const [jumpText, setJumpText] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [refused, setRefused] = useState<string | null>(null);
  const seq = useRef(0);
  const reads = !isNew && api !== undefined;

  // what is on screen: the stored page with the unsaved edits that fall on it, cut to the fitted size
  const stored = (page?.items ?? []).map((it) => ({ key: it.key ?? '', value: it.value ?? '' }));
  const view = reads
    ? pageView(stored, itemEdits, { atStart: (page?.index ?? 0) === 0, atEnd: page ? page.next == null : true }, size)
    : pageView([], itemEdits, { atStart: true, atEnd: true }, Number.MAX_SAFE_INTEGER);
  const rows: PageRow[] = view.rows;
  const edges = cursors(rows);

  // a Save that read the board again: the stored items may have changed under the cursors, so start from the first page
  if (stamp !== updatedAt) { setStamp(updatedAt); setReq({ at: null, limit: size }); setNote(null); }
  // taller: one read from the first visible row with the new size (shorter: rows drop off the bottom, no read)
  else if (reads && size > req.limit) setReq({ at: edges.before !== null && page ? { from: edges.before } : req.at, limit: size });

  useEffect(() => {
    if (!reads) return;
    const mine = ++seq.current;
    setStatus({ state: 'loading' });
    const drop = () => mine !== seq.current;
    api.cacheItemsPage(id, req.at, req.limit).then((r) => {
      if (drop()) return;
      if (!r.ok) { setStatus({ state: 'error', message: describeError(r.error) }); return; }
      setPage(r.value);
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
  const next = () => { const after = edges.after ?? page?.next; if (after) go({ after }); };
  const prev = () => { const before = edges.before ?? page?.prev; if (before) go({ before }); };

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
  const position = storedShown === 0 ? 'no items'
    : `rows ${n(index + 1)}–${n(index + storedShown)} · page ${n(Math.floor(index / size) + 1)} of ${n(Math.max(1, Math.ceil(itemCount / size)))}`;
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
          <button type="button" className="pbtn" aria-label="Prev" disabled={!page || page.prev == null} onClick={prev}>‹ Prev</button>
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
