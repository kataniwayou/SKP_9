import { useEffect, useRef, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { asElement, asNode } from './nodes';

/** Where an overlay opens: viewport coordinates in one window's document (a pop-out has its own). */
export interface Anchor { x: number; y: number; doc: Document }

/** Below an element, in that element's own document (spec §6.3: never the global document). */
export function anchorBelow(el: Element): Anchor {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.bottom + 2, doc: el.ownerDocument };
}

/** At the pointer, in the document the event happened in. */
export function anchorAt(e: { clientX: number; clientY: number; target: EventTarget | null }): Anchor {
  const doc = asNode(e.target)?.ownerDocument ?? document;
  return { x: e.clientX, y: e.clientY, doc };
}

export interface MenuItem {
  id: string;
  label: string;
  icon?: string;
  kbd?: string;
  disabled?: boolean;
  /** Shown as a tooltip; a disabled item says why. */
  tip?: string;
  onSelect: () => void;
}
export type MenuEntry = MenuItem | 'separator';

/**
 * A dropdown (mockup v49 .dropdown): the menu strip's menus and the window-position menu. It is
 * rendered into the anchor's document at --z-menu, so it opens above a floating group and inside a
 * pop-out window. A pointer press anywhere outside closes it, except on the menu strip, whose
 * buttons toggle and switch menus themselves.
 */
export function Menu({ entries, anchor, onClose, label }: { entries: readonly MenuEntry[]; anchor: Anchor; onClose: () => void; label: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (asElement(e.target)?.closest('[role="menubar"]')) return;
      const target = asNode(e.target);
      if (ref.current && target && !ref.current.contains(target)) onClose();
    };
    anchor.doc.addEventListener('pointerdown', away, true);
    return () => anchor.doc.removeEventListener('pointerdown', away, true);
  }, [anchor.doc, onClose]);

  // keyboard: focus the first enabled item on open, then arrows / Home / End / Enter / Space
  const items = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []);
  useEffect(() => { items()[0]?.focus(); }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    const list = items();
    if (list.length === 0) return;
    const at = list.indexOf(anchor.doc.activeElement as HTMLElement);
    let to: number | null = null;
    if (e.key === 'ArrowDown') to = at < 0 ? 0 : (at + 1) % list.length;
    else if (e.key === 'ArrowUp') to = at < 0 ? list.length - 1 : (at - 1 + list.length) % list.length;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = list.length - 1;
    else if ((e.key === 'Enter' || e.key === ' ') && at >= 0) { e.preventDefault(); list[at]!.click(); return; }
    if (to === null) return;
    e.preventDefault();
    list[to]!.focus();
  };

  const view = anchor.doc.defaultView;
  const left = Math.max(8, Math.min(anchor.x, (view?.innerWidth ?? 1280) - 270));
  const top = Math.max(8, anchor.y);

  return createPortal(
    <div ref={ref} className="dropdown" role="menu" aria-label={label} style={{ left, top }} onKeyDown={onKeyDown}>
      {entries.map((entry, i) =>
        entry === 'separator' ? (
          <div key={`sep${i}`} className="msep" role="separator" />
        ) : (
          <div
            key={entry.id}
            role="menuitem"
            aria-disabled={entry.disabled ? true : undefined}
            tabIndex={entry.disabled ? undefined : -1}
            className={entry.disabled ? 'mi dis' : 'mi'}
            data-tip={entry.tip}
            onClick={() => {
              if (entry.disabled) return;
              onClose();
              entry.onSelect();
            }}
          >
            <span className="ml"><span className="mic">{entry.icon ?? ''}</span>{entry.label}</span>
            <kbd>{entry.kbd ?? ''}</kbd>
          </div>
        ))}
    </div>,
    anchor.doc.body,
  );
}
