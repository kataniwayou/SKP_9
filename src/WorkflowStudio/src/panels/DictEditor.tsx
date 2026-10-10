import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { dictPretty, dictText, keyProblem, MAX_DICT_CHARS, parseDict, type DictEntry } from '../store/dict';
import type { FieldSpec } from '../store/entityForms';

/** One row as edited: what it shows now, and the entry it stood for when last committed (null: added, never committed). */
interface Row { id: number; key: string; value: string; committed: DictEntry | null; touched: boolean }

let rowIds = 0;
const rowsOf = (entries: readonly DictEntry[]): Row[] => entries.map(([key, value]) => ({ id: ++rowIds, key, value, committed: [key, value], touched: false }));

/** A row whose key is as it was last committed: a duplicate is never its fault. */
const settled = (r: Row) => r.committed !== null && r.committed[0] === r.key;

/**
 * Each row's problem, or null. Two rows with one key: the one whose key was changed is the duplicate, never the one that
 * kept its key; when both (or neither) changed, the later one.
 */
function problemsOf(rows: readonly Row[]): (string | null)[] {
  return rows.map((r, i) => {
    const rivals = rows.filter((o, j) => j !== i && o.key === r.key && (j < i ? !settled(r) || settled(o) : settled(o) && !settled(r)));
    return keyProblem(r.key, rivals.map((o) => o.key));
  });
}

/**
 * The entries a commit writes: a valid row as it shows; a row with a problem as it was last committed (an added one not
 * at all), so fixing one row never holds the others back. Null when even that cannot be stored (a key twice, too big).
 */
function committable(rows: readonly Row[]): DictEntry[] | null {
  const problems = problemsOf(rows);
  const out: DictEntry[] = [];
  for (const [i, r] of rows.entries()) {
    if (problems[i] === null) out.push([r.key, r.value]);
    else if (r.committed) out.push(r.committed);
  }
  if (new Set(out.map(([k]) => k)).size !== out.length) return null;
  return dictText(out).length > MAX_DICT_CHARS ? null : out;
}

/**
 * A string-to-string dictionary field (2026-10-10: a cache's items) as a key/value table: a click edits a cell, Enter or
 * leaving it commits, Escape puts the cell back; "+ Add item" adds a row ready for its key; × deletes a row. A key that is
 * empty, written twice or holds ':' marks its row red with the reason and is not committed until fixed. The JSON toggle
 * shows the same dictionary as text, committed when it leaves the box valid. Stored text that is no string dictionary is
 * shown as text with the reason, never as a broken table. Each commit is the field's text as BaseApi keeps it.
 */
export function DictEditor({ spec, value, errors, onChange, readOnly = false }: {
  spec: FieldSpec;
  value: string;
  errors: readonly string[];
  onChange: (text: string) => void;
  readOnly?: boolean;
}) {
  const id = useId();
  const stored = parseDict(value);
  const [rows, setRows] = useState<Row[]>(() => rowsOf(stored.ok ? stored.entries : []));
  const [json, setJson] = useState(false);
  const [text, setText] = useState(() => (stored.ok ? dictPretty(stored.entries) : value));
  // the text this editor last committed: the field coming back as it is no news; anything else (undo, another entity) is
  const mine = useRef(value);
  const focusKey = useRef<number | null>(null);
  const keyInputs = useRef(new Map<number, HTMLInputElement>());
  const before = useRef('');

  useEffect(() => {
    if (value === mine.current) return;
    mine.current = value;
    const next = parseDict(value);
    setRows(rowsOf(next.ok ? next.entries : []));
    setText(next.ok ? dictPretty(next.entries) : value);
  }, [value]);

  useEffect(() => {
    if (focusKey.current === null) return;
    keyInputs.current.get(focusKey.current)?.focus();
    focusKey.current = null;
  });

  const commit = (next: Row[]) => {
    const out = committable(next);
    if (out === null) { setRows(next); return; }
    const t = dictText(out);
    // what each row now stands for: a valid row as committed, a red one keeps its last
    const problems = problemsOf(next);
    const done = next.map((r, i) => (problems[i] === null ? { ...r, committed: [r.key, r.value] as DictEntry } : r));
    setRows(done);
    setText(dictPretty(out));
    if (t !== mine.current) {
      mine.current = t;
      onChange(t);
    }
  };
  const set = (rowId: number, part: 'key' | 'value', v: string) =>
    setRows((rs) => rs.map((r) => (r.id === rowId ? { ...r, [part]: v } : r)));
  const cellKeys = (rowId: number, part: 'key' | 'value') => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
    else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      const was = before.current;
      const input = e.currentTarget;
      setRows((rs) => rs.map((r) => (r.id === rowId ? { ...r, [part]: was } : r)));
      // left after the render that put the cell back: the blur commits it as it was
      setTimeout(() => input.blur(), 0);
    }
  };
  // a blur is its own event, after the typing's render: `rows` is current here
  const leave = (rowId: number) => commit(rows.map((r) => (r.id === rowId ? { ...r, touched: true } : r)));
  const add = () => {
    const row: Row = { id: ++rowIds, key: '', value: '', committed: null, touched: false };
    focusKey.current = row.id;
    setRows((rs) => [...rs, row]);
  };
  const remove = (rowId: number) => commit(rows.filter((r) => r.id !== rowId));

  const problems = problemsOf(rows);
  const jsonCheck = parseDict(text);
  const leaveJson = () => {
    if (!jsonCheck.ok) return;
    const t = dictText(jsonCheck.entries);
    setRows(rowsOf(jsonCheck.entries));
    setText(dictPretty(jsonCheck.entries));
    if (t !== mine.current) {
      mine.current = t;
      onChange(t);
    }
  };
  const showJson = json || !stored.ok;
  const count = stored.ok ? stored.entries.length : null;

  return (
    <div className="field dict">
      <div className="dict-head">
        <label htmlFor={showJson ? id : undefined}>{spec.label}</label>
        {count !== null && <span className="dict-count">{count} item{count === 1 ? '' : 's'}</span>}
        <button type="button" className={showJson ? 'dict-tog on' : 'dict-tog'} aria-pressed={showJson}
          disabled={!stored.ok} data-tip={stored.ok ? (json ? 'Show as a table' : 'Show as JSON text') : 'Not a string dictionary: shown as text'}
          onClick={() => setJson((j) => !j)}>JSON</button>
      </div>
      {showJson ? (
        <div className="fval">
          <textarea id={id} className="input json" rows={Math.min(14, Math.max(4, text.split('\n').length + 1))} spellCheck={false}
            readOnly={readOnly} aria-invalid={!jsonCheck.ok || errors.length > 0 ? true : undefined} aria-label={`${spec.label} as JSON`}
            value={text} onChange={(e) => setText(e.target.value)} onBlur={leaveJson} />
          {!stored.ok && <div className="ferr">{`Stored items are not a string dictionary: ${stored.reason}`}</div>}
          {stored.ok && !jsonCheck.ok && <div className="ferr">{`Not committed: ${jsonCheck.reason}`}</div>}
          {errors.map((message, i) => <div key={i} className="ferr">{message}</div>)}
        </div>
      ) : (
        <div className="fval">
          <table className="dict-table" aria-label={spec.label}>
            <thead><tr><th>Key</th><th>Value</th>{!readOnly && <th aria-label="Delete" />}</tr></thead>
            <tbody>
              {rows.map((r, i) => {
                const problem = problems[i] !== null && (r.touched || r.committed !== null) ? problems[i] : null;
                return [
                  <tr key={r.id} className={problem ? 'bad' : undefined}>
                    <td>
                      <input ref={(el) => { if (el) keyInputs.current.set(r.id, el); else keyInputs.current.delete(r.id); }}
                        className="dict-cell" aria-label={`Key ${i + 1}`} spellCheck={false} readOnly={readOnly}
                        aria-invalid={problem ? true : undefined} value={r.key}
                        onFocus={(e) => { before.current = e.currentTarget.value; }}
                        onChange={(e) => set(r.id, 'key', e.target.value)} onKeyDown={cellKeys(r.id, 'key')} onBlur={() => leave(r.id)} />
                    </td>
                    <td>
                      <input className="dict-cell" aria-label={`Value ${i + 1}`} spellCheck={false} readOnly={readOnly} value={r.value}
                        onFocus={(e) => { before.current = e.currentTarget.value; }}
                        onChange={(e) => set(r.id, 'value', e.target.value)} onKeyDown={cellKeys(r.id, 'value')} onBlur={() => leave(r.id)} />
                    </td>
                    {!readOnly && (
                      <td className="dict-x">
                        <button type="button" className="link danger" tabIndex={-1} aria-label={`Delete item ${i + 1}`} onClick={() => remove(r.id)}>×</button>
                      </td>
                    )}
                  </tr>,
                  problem && <tr key={`${r.id}-why`} className="dict-why"><td colSpan={readOnly ? 2 : 3}>{problem}: not committed</td></tr>,
                ];
              })}
            </tbody>
          </table>
          {!readOnly && <button type="button" className="link dict-add" onClick={add}>+ Add item</button>}
          {errors.map((message, i) => <div key={i} className="ferr">{message}</div>)}
        </div>
      )}
    </div>
  );
}
