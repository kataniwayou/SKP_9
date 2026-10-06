import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Anchor } from './Menu';

export interface PickerItem {
  id: string;
  /** The unique entity name (spec §7: the name the logs use). */
  label: string;
  /** Already open as a document: picking it switches to that tab. */
  open: boolean;
}

/** Case-insensitive substring match on the label; the list keeps its order. */
export function filterItems(items: readonly PickerItem[], query: string): PickerItem[] {
  const q = query.trim().toLowerCase();
  return q === '' ? [...items] : items.filter((i) => i.label.toLowerCase().includes(q));
}

/**
 * The searchable open-workflow dropdown (spec §6.1, mockup v49 .picker). Type to filter, Enter
 * opens the first match, Escape or a press outside closes it.
 */
export function Picker({ items, anchor, onPick, onClose, note }: {
  items: readonly PickerItem[]; anchor: Anchor; onPick: (id: string) => void; onClose: () => void;
  /** Shown instead of the list when there is nothing to list (the list could not be read). */
  note?: string;
}) {
  const [query, setQuery] = useState('');
  const shown = useMemo(() => filterItems(items, query), [items, query]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) onClose();
    };
    anchor.doc.addEventListener('pointerdown', away, true);
    return () => anchor.doc.removeEventListener('pointerdown', away, true);
  }, [anchor.doc, onClose]);

  const pick = (id: string) => { onClose(); onPick(id); };
  const view = anchor.doc.defaultView;
  const left = Math.max(8, Math.min(anchor.x, (view?.innerWidth ?? 1280) - 452));

  return createPortal(
    <div ref={ref} className="picker" role="dialog" aria-label="Open workflow" style={{ left, top: anchor.y }}>
      <div className="pk-h">Open workflow</div>
      <input
        className="input"
        aria-label="Search workflows"
        placeholder="Search workflows…"
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
          if (e.key === 'Enter' && shown[0]) { e.preventDefault(); pick(shown[0].id); }
        }}
      />
      <div role="listbox" aria-label="Workflows">
        {shown.map((item, i) => (
          <div key={item.id} role="option" aria-selected={i === 0} className={i === 0 ? 'pk hi' : 'pk'} onClick={() => pick(item.id)}>
            <b data-tipcut={item.label}>{item.label}</b>
            <span className="o">{item.open ? 'open — switch' : ''}</span>
          </div>
        ))}
        {shown.length === 0 && <div className="note">{items.length === 0 && note ? note : 'No workflow matches.'}</div>}
      </div>
    </div>,
    anchor.doc.body,
  );
}
