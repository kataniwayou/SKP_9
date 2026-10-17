import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Anchor } from './Menu';
import { asElement, asNode } from './nodes';

/** A group of shortcuts: its title, the sheet's column it sits in, and each key stroke or gesture with what it does. */
export interface ShortcutGroup { group: string; column: 0 | 1; items: readonly { keys: string; does: string }[] }

/** Which groups this viewer left open: a convenience kept in the browser, so it may come back empty. */
const OPEN_KEY = 'skp.valence.shortcuts.open';
function readOpen(storage: Storage | undefined): Set<string> {
  try { const v = JSON.parse(storage?.getItem(OPEN_KEY) ?? '[]'); return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []); } catch { return new Set(); }
}
function writeOpen(storage: Storage | undefined, open: ReadonlySet<string>) {
  try { storage?.setItem(OPEN_KEY, JSON.stringify([...open])); } catch { /* the sheet works without it */ }
}

/**
 * The Shortcuts sheet (the user, 2026-10-17, preview approved): every key stroke and gesture, in two columns of groups,
 * too many for one dropdown column. To read, not to run: a press outside (but on the menu strip, whose buttons toggle it)
 * or Escape (the dock's own key) closes it. One column on a narrow window. Each group opens and closes from its title
 * (the user, 2026-10-17: "it's overloaded"), all closed at first, with Expand all and Collapse all.
 */
export function ShortcutSheet({ groups, anchor, onClose }: { groups: readonly ShortcutGroup[]; anchor: Anchor; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const storage = (() => { try { return anchor.doc.defaultView?.localStorage; } catch { return undefined; } })();
  const [open, setOpen] = useState<ReadonlySet<string>>(() => readOpen(storage));
  const change = (next: Set<string>) => { setOpen(next); writeOpen(storage, next); };
  const toggle = (g: string) => { const next = new Set(open); if (!next.delete(g)) next.add(g); change(next); };
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (asElement(e.target)?.closest('[role="menubar"]')) return;
      const target = asNode(e.target);
      if (ref.current && target && !ref.current.contains(target)) onClose();
    };
    anchor.doc.addEventListener('pointerdown', away, true);
    return () => anchor.doc.removeEventListener('pointerdown', away, true);
  }, [anchor.doc, onClose]);

  const view = anchor.doc.defaultView;
  const width = view?.innerWidth ?? 1600;
  const left = Math.max(16, Math.min(anchor.x, width - 16 - Math.min(880, width - 32)));
  const column = (c: 0 | 1) => (
    <div className="sc-col">
      {groups.filter((g) => g.column === c).map((g) => (
        <section key={g.group} aria-label={g.group}>
          <h3 className="sc-h">
            <button type="button" className="sc-t" aria-expanded={open.has(g.group)} onClick={() => toggle(g.group)}>
              <span className="sc-car" aria-hidden="true">{open.has(g.group) ? '▾' : '▸'}</span>{g.group}<span className="sc-n">{g.items.length}</span>
            </button>
          </h3>
          {open.has(g.group) && g.items.map((s) => (
            <div key={`${s.keys}|${s.does}`} className="sc-row"><span>{s.does}</span><kbd>{s.keys}</kbd></div>
          ))}
        </section>
      ))}
    </div>
  );
  return createPortal(
    <div ref={ref} className="sc-sheet" role="dialog" aria-label="Shortcuts" style={{ left, top: Math.max(8, anchor.y) }}>
      <div className="sc-bar">
        <button type="button" className="sc-all" onClick={() => change(new Set(groups.map((g) => g.group)))}>Expand all</button>
        <button type="button" className="sc-all" onClick={() => change(new Set())}>Collapse all</button>
      </div>
      <div className="sc-cols">{column(0)}{column(1)}</div>
      <div className="sc-foot">To read, not to run: a click anywhere, or Escape, closes it.</div>
    </div>,
    anchor.doc.body,
  );
}
