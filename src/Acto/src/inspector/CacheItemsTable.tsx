import { useEffect, useState, type KeyboardEvent } from 'react';
import type { StudioApi } from '../api/client';
import { describeError } from '../api/describeError';
import type { CacheItemsPage } from '../api/types';
import type { CacheRow } from '../design/board';
import { removeCacheItem, revertCacheItem, setCacheItem } from '../design/edits';
import type { Edit } from './tabs/shared';

/** How many stored items one request reads. */
export const ITEMS_PAGE_LIMIT = 500;

type Page = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ok'; page: CacheItemsPage };

const STRUCK = { textDecoration: 'line-through', opacity: 0.6 } as const;

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

/**
 * A cache's items, one page at a time: the stored page (read from the server, `ITEMS_PAGE_LIMIT` a request) with this
 * session's unsaved edits laid over it, an "Unsaved" section listing every change with its revert, and an add-key row. Each
 * commit is its own undo step. A new cache (not saved yet) has nothing stored to read: only the Unsaved section. Without an
 * `api` there is nothing to read either.
 */
export function CacheItemsTable({ cache, isNew, api, edit }: { cache: CacheRow; isNew: boolean; api?: StudioApi | undefined; edit: Edit }) {
  const { id, updatedAt, itemCount, itemEdits } = cache;
  // cursors of the pages visited: the last is this page's `after` (null: the first page)
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [stamp, setStamp] = useState(updatedAt);
  const [tries, setTries] = useState(0);
  const [page, setPage] = useState<Page>({ state: 'loading' });
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [refused, setRefused] = useState<string | null>(null);
  // a Save that read the board again: the stored items may have changed under the cursors, so start from the first page
  if (stamp !== updatedAt) { setStamp(updatedAt); setCursors([null]); }
  const after = cursors[cursors.length - 1] ?? null;

  const reads = !isNew && api !== undefined;
  useEffect(() => {
    if (!reads) return;
    let live = true;
    setPage({ state: 'loading' });
    api.cacheItemsPage(id, after, ITEMS_PAGE_LIMIT).then((r) => {
      if (live) setPage(r.ok ? { state: 'ok', page: r.value } : { state: 'error', message: describeError(r.error) });
    }, (e: unknown) => {
      if (live) setPage({ state: 'error', message: e instanceof Error ? e.message : String(e) });
    });
    return () => { live = false; };
  }, [reads, api, id, after, updatedAt, tries]);

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

  const setKeys = Object.keys(itemEdits.set);
  const unsaved = setKeys.length + itemEdits.removed.length;
  const removed = new Set(itemEdits.removed);
  const head = isNew ? `${unsaved} unsaved` : `${itemCount} stored${unsaved ? ` · ${unsaved} unsaved` : ''}`;

  return (
    <div className="fld tall dict-row">
      <span>Items</span>
      <div className="dict">
        <div className="dict-head"><span className="dict-count">{head}</span></div>
        <div className="dict-val">
          {unsaved > 0 && (
            <table className="dict-table" aria-label="Unsaved items">
              <thead><tr><th>Unsaved</th><th>Value</th><th aria-label="Revert" /></tr></thead>
              <tbody>
                {setKeys.map((k) => (
                  <tr key={`set:${k}`}>
                    <td><input className="dict-cell" readOnly aria-label={`Unsaved key ${k}`} value={k} /></td>
                    <td><Cell label={`Unsaved value ${k}`} value={itemEdits.set[k]!} onCommit={(v) => setItem(k, v)} /></td>
                    <td className="dict-x"><button type="button" className="dict-del" aria-label={`Revert ${k}`} onClick={() => revert(k)}>↺</button></td>
                  </tr>
                ))}
                {itemEdits.removed.map((k) => (
                  <tr key={`rm:${k}`}>
                    <td><input className="dict-cell" readOnly aria-label={`Removed key ${k}`} value={k} style={STRUCK} /></td>
                    <td className="dict-count">removed at Save</td>
                    <td className="dict-x"><button type="button" className="dict-del" aria-label={`Restore ${k}`} onClick={() => revert(k)}>↺</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {reads && page.state === 'loading' && <div className="dict-count">Loading items…</div>}
          {reads && page.state === 'error' && (
            <div className="dict-err" role="alert">{`Items could not be read: ${page.message} `}
              <button type="button" className="dict-add" onClick={() => setTries((n) => n + 1)}>Retry</button></div>
          )}
          {reads && page.state === 'ok' && (
            <>
              <table className="dict-table" aria-label="Stored items">
                <thead><tr><th>Key</th><th>Value</th><th aria-label="Delete" /></tr></thead>
                <tbody>
                  {page.page.items?.map((it) => {
                    const key = it.key ?? '';
                    const gone = removed.has(key);
                    const edited = Object.hasOwn(itemEdits.set, key);
                    return (
                      <tr key={key}>
                        <td><input className="dict-cell" readOnly aria-label={`Key ${key}`} value={key} style={gone ? STRUCK : undefined} /></td>
                        <td><Cell label={`Value ${key}`} value={edited ? itemEdits.set[key]! : it.value ?? ''} struck={gone}
                          onCommit={(v) => setItem(key, v)} /></td>
                        <td className="dict-x">
                          {gone || edited
                            ? <button type="button" className="dict-del" aria-label={`${gone ? 'Restore' : 'Revert'} ${key}`} onClick={() => revert(key)}>↺</button>
                            : <button type="button" className="dict-del" aria-label={`Remove ${key}`} onClick={() => remove(key)}>×</button>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="dict-head">
                <button type="button" className="dict-add" disabled={cursors.length === 1} onClick={() => setCursors((c) => c.slice(0, -1))}>Previous</button>
                <button type="button" className="dict-add" disabled={page.page.next == null} onClick={() => setCursors((c) => [...c, page.page.next ?? null])}>Next</button>
              </div>
            </>
          )}
          <div className="dict-head">
            <input className="dict-cell" aria-label="New key" spellCheck={false} placeholder="key" value={newKey}
              onChange={(e) => setNewKey(e.target.value)} onKeyDown={addKeys} />
            <input className="dict-cell" aria-label="New value" spellCheck={false} placeholder="value" value={newValue}
              onChange={(e) => setNewValue(e.target.value)} onKeyDown={addKeys} />
            <button type="button" className="dict-add" onClick={add}>Add item</button>
          </div>
          {refused !== null && <div className="dict-err" role="alert">{refused}</div>}
        </div>
      </div>
    </div>
  );
}
