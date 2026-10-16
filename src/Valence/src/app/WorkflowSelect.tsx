import { useEffect, useRef, useState } from 'react';

export interface WorkflowItem { id: string; label: string }

/**
 * The workflow multi-select (spec §2.4): picks which workflows the whole-project molecule highlights. Nothing is loaded
 * by it; it only says which ones stand out. A pill on the main menu strip opens a checked list below it, aligned to its
 * right edge; a press outside or Esc closes it.
 */
export function WorkflowSelect({ items, selected, onChange, note }: {
  items: readonly WorkflowItem[];
  selected: readonly string[];
  onChange: (ids: readonly string[]) => void;
  /** Shown when there are no items, e.g. why the list could not be read. */
  note?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const doc = ref.current?.ownerDocument ?? document;
    const away = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    doc.addEventListener('pointerdown', away, true);
    return () => doc.removeEventListener('pointerdown', away, true);
  }, [open]);

  const chosen = new Set(selected);
  const count = items.filter((w) => chosen.has(w.id)).length;
  const shown = items.filter((w) => w.label.toLowerCase().includes(query.trim().toLowerCase()));
  const toggle = (id: string) => onChange(chosen.has(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  return (
    <div className="wfsel" ref={ref} onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); } }}>
      <button type="button" className="cap-b wfsel-b" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        data-tip="Highlight workflows in the molecule">
        Workflows <span className="wfsel-n">{count === 0 ? 'none highlighted' : `${count} highlighted`}</span> ▾
      </button>
      {open && (
        <div className="wfsel-list">
          <div className="pk-h">Highlight workflows</div>
          {items.length > 0 && (
            <input className="input" aria-label="Search workflows" placeholder="Search…" value={query} autoFocus
              onChange={(e) => setQuery(e.target.value)} />
          )}
          {items.length === 0 && <div className="note">{note ?? 'No workflows yet.'}</div>}
          {items.length > 0 && shown.length === 0 && <div className="note">No workflow matches.</div>}
          {shown.length > 0 && (
            <div role="listbox" aria-label="Workflows" aria-multiselectable="true">
              {shown.map((w) => (
                <div key={w.id} role="option" aria-selected={chosen.has(w.id)} tabIndex={0} className={chosen.has(w.id) ? 'wfsel-o on' : 'wfsel-o'}
                  onClick={() => toggle(w.id)} onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(w.id); } }}>
                  <span className="wfsel-c" aria-hidden="true">{chosen.has(w.id) ? '✓' : ''}</span><b>{w.label}</b>
                </div>
              ))}
            </div>
          )}
          {count > 0 && <button type="button" className="qb wfsel-clear" onClick={() => onChange([])}>Clear</button>}
        </div>
      )}
    </div>
  );
}
