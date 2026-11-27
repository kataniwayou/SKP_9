import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { StudioApi } from '../api/client';
import { describeError } from '../api/describeError';
import type { CacheRow, ItemEdits } from '../design/board';
import { removeCacheItem, revertCacheItem, setCacheItem } from '../design/edits';
import { pageSummary, pageView, readAt, readLimit, shownPage, summaryText, windowOf, type PageRead, type PageRow, type PageWindow } from '../design/itemsPage';
import type { Edit } from './tabs/shared';
import { useFitRows } from './useFitRows';

/** One read at the page size `limit`, and the typed text when it is a jump (the note comes from its answer). */
type Req = { read: PageRead; limit: number; jump?: string };
type Status = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ok' };
const START: PageRead = { dir: 'forward', from: null };

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
 * the list and an add-key row in one frame, then Prev / Next with the position and a summary of the unsaved changes on screen only. Each commit is its own
 * board undo step; Save is the board's. A new cache (not saved yet), or no `api`, has nothing stored to read: only its added rows.
 */
export function CacheItemsTable({ cache, isNew, api, edit }: { cache: CacheRow; isNew: boolean; api?: StudioApi | undefined; edit: Edit }) {
  const { id, updatedAt, itemCount, itemEdits } = cache;
  const fitRef = useRef<HTMLDivElement>(null);
  const size = useFitRows(fitRef);
  const [req, setReq] = useState<Req>({ read: START, limit: size });
  const [stamp, setStamp] = useState(updatedAt);
  const [tries, setTries] = useState(0);
  const [status, setStatus] = useState<Status>({ state: 'loading' });
  const [win, setWin] = useState<PageWindow | null>(null);
  // the request whose answer (or error) came last: while it is not `req`, a read is in flight
  const [landed, setLanded] = useState<Req | null>(null);
  const [jumpText, setJumpText] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [refused, setRefused] = useState<string | null>(null);
  const seq = useRef(0);
  const reads = !isNew && api !== undefined;

  // what is on screen: the read's stored rows with the unsaved edits that fall in its key range, cut to the fitted size
  // (pages tile the key space as [lower, upper): Next reads from upper, Prev before lower; see design/itemsPage.ts)
  const page = reads && win ? shownPage(win, itemEdits, size) : null;
  const rows: PageRow[] = reads
    ? page?.rows ?? []
    : pageView([], itemEdits, { lower: null, upper: null }, Number.MAX_SAFE_INTEGER).rows;

  const pending = landed !== req;
  // a Save that read the board again: the stored items may have changed under the page, so read it again from its lower key
  if (stamp !== updatedAt) {
    setStamp(updatedAt);
    setReq({ read: page ? { dir: 'forward', from: page.lower, after: page.lowerAfter } : START, limit: size });
    setNote(null);
  }
  // taller: a read in flight (Next, Prev, a jump) grows in place, same anchor; else one read forward from the page's lower
  // key with the new size (shorter: the tail is cut, no read)
  else if (reads && size > req.limit) {
    setReq(pending || !page ? { ...req, limit: size } : { read: { dir: 'forward', from: page.lower, after: page.lowerAfter }, limit: size });
  }

  useEffect(() => {
    if (!reads) return;
    const mine = ++seq.current;
    setStatus({ state: 'loading' });
    const drop = () => mine !== seq.current;
    const { read, limit, jump } = req;
    api.cacheItemsPage(id, readAt(read), readLimit(limit)).then((r) => {
      if (drop()) return;
      setLanded(req);
      if (!r.ok) { setStatus({ state: 'error', message: describeError(r.error) }); return; }
      setWin(windowOf(read, limit, r.value));
      setStatus({ state: 'ok' });
      if (jump !== undefined) setNote(noteOf(jump, r.value.fromMatch));
    }, (e: unknown) => {
      if (drop()) return;
      setLanded(req);
      setStatus({ state: 'error', message: e instanceof Error ? e.message : String(e) });
    });
  }, [reads, api, id, req, tries]);

  const go = (read: PageRead, jump?: string) => {
    setNote(null);
    setReq(jump === undefined ? { read, limit: size } : { read, limit: size, jump });
  };
  const jump = () => { if (jumpText !== '') go({ dir: 'forward', from: jumpText, jump: true }, jumpText); };
  const jumpKeys = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') { e.preventDefault(); jump(); } };
  const clearJump = () => { setJumpText(''); go(START); };
  const next = () => { if (page?.upper != null) go({ dir: 'forward', from: page.upper, after: page.upperAfter }); };
  const prev = () => { if (page?.lower != null) go({ dir: 'back', before: page.lower }); };

  /** Sets one item; the board's edits after it, or null when refused (the reason is shown). */
  const setItem = (key: string, value: string): ItemEdits | null => {
    let why: string | null = null;
    let after: ItemEdits | null = null;
    edit((b) => {
      const r = setCacheItem(b, id, key, value);
      if ('refused' in r) { why = r.refused; return b; }
      after = r.state.caches[id]?.itemEdits ?? null;
      return r.state;
    });
    setRefused(why);
    return why === null ? after ?? itemEdits : null;
  };
  const remove = (key: string) => edit((b) => removeCacheItem(b, id, key, true));
  const revert = (key: string) => edit((b) => revertCacheItem(b, id, key));
  // an added key that sorts off this page: go to the page starting at it (a continuation read, not a jump: past the last
  // stored key it shows the added keys from it on), so the new row and its summary are on screen
  const add = () => {
    const key = newKey;
    const after = setItem(key, newValue);
    if (after === null) return;
    setNewKey('');
    setNewValue('');
    if (reads && win && !shownPage(win, after, size).rows.some((r) => r.key === key)) go({ dir: 'forward', from: key });
  };
  const addKeys = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };

  const summary = pageSummary(rows);
  const anyChange = summary.modified + summary.added + summary.deleted > 0;
  const index = page?.index ?? 0;
  const storedShown = rows.filter((r) => r.stored !== null).length;
  const position = rows.length === 0 ? 'no items'
    : storedShown === 0 ? 'no stored rows on this page'
      : `rows ${n(index + 1)}–${n(index + storedShown)} · page ${n(Math.floor(index / size) + 1)} of ${n(Math.max(1, Math.ceil(itemCount / size)))}`;
  const showTable = !reads || status.state === 'ok' || (status.state === 'loading' && win !== null);

  return (
    <div className="fld dict-row dict-fill">
      <div className="dict-head"><b>Items</b><span>{`${n(itemCount)} stored`}</span></div>
      {reads && (
        <>
          <div className="dict-jump">
            <input className="dict-cell" aria-label="Jump to key" spellCheck={false} placeholder="jump to key…" value={jumpText}
              onChange={(e) => setJumpText(e.target.value)} onKeyDown={jumpKeys} />
            <button type="button" className="pbtn" onClick={jump}>Go</button>
            <button type="button" className="pbtn" aria-label="Clear jump" onClick={clearJump}>×</button>
          </div>
          {/* the note's line is kept when there is none, so showing or clearing it does not move the list */}
          <div className="dict-note" role={note !== null ? 'note' : undefined}>{note}</div>
        </>
      )}
      <div className="dict-box">
        <div className={reads ? 'dict-fit' : 'dict-fit loose'} ref={fitRef}>
          {reads && status.state === 'loading' && win === null && <div className="dict-count">Loading items…</div>}
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
        <div className="dict-addrow">
          <input className="dict-cell" aria-label="New key" spellCheck={false} placeholder="key" value={newKey}
            onChange={(e) => setNewKey(e.target.value)} onKeyDown={addKeys} />
          <input className="dict-cell" aria-label="New value" spellCheck={false} placeholder="value" value={newValue}
            onChange={(e) => setNewValue(e.target.value)} onKeyDown={addKeys} />
          <button type="button" className="pbtn" onClick={add}>Add item</button>
        </div>
      </div>
      {refused !== null && <div className="dict-err" role="alert">{refused}</div>}
      {reads && (
        <div className="dict-nav">
          <button type="button" className="pbtn" aria-label="Prev" disabled={page?.lower == null} onClick={prev}>‹ Prev</button>
          <button type="button" className="pbtn" aria-label="Next" disabled={page?.upper == null} onClick={next}>Next ›</button>
          <span className="dict-pos">{page ? position : ''}</span>
        </div>
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
    </div>
  );
}
