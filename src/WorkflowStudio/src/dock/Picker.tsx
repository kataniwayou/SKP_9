import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Anchor } from './Menu';
import { asNode } from './nodes';

export interface PickerItem {
  id: string;
  /** The unique entity name (spec §7: the name the logs use). */
  label: string;
  /** Already open as a document: picking it switches to that tab. */
  open: boolean;
  /** In BaseApi's live set (2026-10-10): a running dot, read as "running". */
  running?: boolean;
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
  const [chosen, setChosen] = useState(0);
  const at = Math.min(chosen, Math.max(0, shown.length - 1));
  const baseId = useId().replace(/[^\w-]/g, '');
  const optionId = (i: number) => `${baseId}-o${i}`;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const away = (e: PointerEvent) => {
      const target = asNode(e.target);
      if (ref.current && target && !ref.current.contains(target)) onClose();
    };
    anchor.doc.addEventListener('pointerdown', away, true);
    return () => anchor.doc.removeEventListener('pointerdown', away, true);
  }, [anchor.doc, onClose]);

  const pick = (id: string) => { onClose(); onPick(id); };
  const view = anchor.doc.defaultView;
  const top = Math.max(8, Math.min(anchor.y, (view?.innerHeight ?? 800) - 360));
  const left = Math.max(8, Math.min(anchor.x, (view?.innerWidth ?? 1280) - 452));

  return createPortal(
    <div ref={ref} className="picker" role="dialog" aria-label="Load workflow" style={{ left, top }}>
      <div className="pk-h">Load workflow</div>
      <input
        className="input"
        aria-label="Search workflows"
        placeholder="Search workflows…"
        autoFocus
        value={query}
        onChange={(e) => { setQuery(e.target.value); setChosen(0); }}
        aria-activedescendant={shown.length > 0 ? optionId(at) : undefined}
        aria-controls={`${baseId}-list`}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
          if (e.key === 'ArrowDown') { e.preventDefault(); setChosen(Math.min(at + 1, Math.max(0, shown.length - 1))); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setChosen(Math.max(at - 1, 0)); }
          if (e.key === 'Enter' && shown[at]) { e.preventDefault(); pick(shown[at].id); }
        }}
      />
      <div role="listbox" aria-label="Workflows" id={`${baseId}-list`}>
        {shown.map((item, i) => (
          <div key={item.id} id={optionId(i)} role="option" aria-selected={i === at} className={i === at ? 'pk hi' : 'pk'} onClick={() => pick(item.id)}>
            <span className="rslot">{item.running && <span className="rdot" role="img" aria-label="running" data-tip="running" />}</span>
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
