import { useSyncExternalStore } from 'react';
import { formatInstant } from './tabs';
import { Ro, Row } from './fields';

/** One show-all state for the whole Inspector, remembered for the browser session (Studio has one global toggle). */
const KEY = 'acto.details';
const subs = new Set<() => void>();
// the state when storage is blocked; storage wins when it answers
let memory = false;

function write(open: boolean) {
  try { if (open) sessionStorage.setItem(KEY, '1'); else sessionStorage.removeItem(KEY); } catch { /* storage blocked: the toggle still works until reload */ }
  memory = open;
  subs.forEach((f) => f());
}
const snapshot = (): boolean => { try { return sessionStorage.getItem(KEY) === '1'; } catch { return memory; } };
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

/** Whether the details are shown, and a toggle. */
export function useDetails(): [boolean, () => void] {
  const open = useSyncExternalStore(subscribe, snapshot);
  return [open, () => write(!open)];
}

/** The base-entity fields behind "show all": BaseAPI's own, read-only. null = absent (e.g. not saved yet). */
export interface Meta { id: string; createdAt: string | null; createdBy: string | null; updatedAt: string | null; updatedBy: string | null }

const text = (v: string | null) => (v === null || v === '' ? '—' : v);

/** "▸ show all" / "▾ hide details" and, when open, Id, Created at, Created by, Updated at, Updated by. */
export function MetaToggle({ meta }: { meta: Meta }) {
  const [open, toggle] = useDetails();
  return (
    <>
      <div className="metatog">
        <button type="button" className="link" aria-expanded={open} onClick={toggle}>{open ? '▾ hide details' : '▸ show all'}</button>
      </div>
      {open && (
        <div className="meta">
          <Ro>
            <Row k="Id">{text(meta.id)}</Row>
            <Row k="Created at">{formatInstant(meta.createdAt)}</Row>
            <Row k="Created by">{text(meta.createdBy)}</Row>
            <Row k="Updated at">{formatInstant(meta.updatedAt)}</Row>
            <Row k="Updated by">{text(meta.updatedBy)}</Row>
          </Ro>
        </div>
      )}
    </>
  );
}
