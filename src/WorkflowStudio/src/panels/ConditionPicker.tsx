import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ConditionMark } from '../canvas/ConditionMark';
import { CONDITIONS, conditionInfo } from '../model/entryConditions';
import { asNode } from '../dock/nodes';

/**
 * The entry-condition dropdown: each condition drawn as the legend draws it. A select-only
 * combobox (WAI-ARIA APG): focus stays on the button, the list follows aria-activedescendant.
 * Closed, Up/Down/Enter/Space open it and a condition's letter picks it; open, Up/Down/Home/End
 * move, Enter/Space pick, a letter moves to it, and Escape, Tab or a press outside close it.
 * A stored value outside the five (0 is rejected by BaseApi) shows as Invalid and cannot be picked.
 */
export function ConditionPicker({ id, value, invalid, onChange }: {
  id: string;
  value: string;
  invalid?: boolean;
  onChange: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = CONDITIONS.findIndex((c) => String(c.value) === value);
  const [at, setAt] = useState(Math.max(0, current));
  const listId = useId().replace(/[^\w-]/g, '');
  const optionId = (i: number) => `${listId}-o${i}`;
  const ref = useRef<HTMLDivElement>(null);
  const info = conditionInfo(Number(value));

  useEffect(() => {
    if (!open) return;
    const doc = ref.current?.ownerDocument ?? document;
    const away = (e: PointerEvent) => {
      const target = asNode(e.target);
      if (ref.current && target && !ref.current.contains(target)) setOpen(false);
    };
    doc.addEventListener('pointerdown', away, true);
    return () => doc.removeEventListener('pointerdown', away, true);
  }, [open]);

  const show = () => { setAt(Math.max(0, current)); setOpen(true); };
  const pick = (i: number) => {
    setOpen(false);
    const v = String(CONDITIONS[i]!.value);
    if (v !== value) onChange(v);
  };
  const byLetter = (key: string) => CONDITIONS.findIndex((c) => c.letter.toLowerCase() === key.toLowerCase());

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const letter = e.key.length === 1 ? byLetter(e.key) : -1;
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); show(); }
      else if (letter >= 0) { e.preventDefault(); pick(letter); }
      return;
    }
    const last = CONDITIONS.length - 1;
    if (e.key === 'ArrowDown') { e.preventDefault(); setAt(Math.min(at + 1, last)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt(Math.max(at - 1, 0)); }
    else if (e.key === 'Home') { e.preventDefault(); setAt(0); }
    else if (e.key === 'End') { e.preventDefault(); setAt(last); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(at); }
    // the dock's Escape must not also run
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); }
    else if (e.key === 'Tab') setOpen(false);
    else if (letter >= 0) { e.preventDefault(); setAt(letter); }
  };

  return (
    <div ref={ref} className="cpick">
      <button
        id={id}
        type="button"
        role="combobox"
        className="input cp-btn"
        data-value={value}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? optionId(at) : undefined}
        aria-invalid={invalid ? true : undefined}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
      >
        <ConditionMark info={info} />
        <span className="cp-name">{current >= 0 ? info.name : `Invalid (${value})`}</span>
        <span className="cp-chev" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div role="listbox" id={listId} className="cp-list" aria-label="Entry conditions">
          {CONDITIONS.map((c, i) => (
            <div
              key={c.value}
              id={optionId(i)}
              role="option"
              aria-selected={i === current}
              className={i === at ? 'cp-opt hi' : 'cp-opt'}
              // keep focus on the button, so its blur does not close the list before the click
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setAt(i)}
              onClick={() => pick(i)}
            >
              <ConditionMark info={c} />
              <span className="cp-name">{c.name}</span>
              {i === current && <span className="cp-tick" aria-hidden="true">✓</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
