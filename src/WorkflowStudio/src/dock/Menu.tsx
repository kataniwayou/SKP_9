import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

/** Where an overlay opens: viewport coordinates in one window's document (a pop-out has its own). */
export interface Anchor { x: number; y: number; doc: Document }

/** Below an element, in that element's own document (spec §6.3: never the global document). */
export function anchorBelow(el: Element): Anchor {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.bottom + 2, doc: el.ownerDocument };
}

/** At the pointer, in the document the event happened in. */
export function anchorAt(e: { clientX: number; clientY: number; target: EventTarget | null }): Anchor {
  const doc = e.target instanceof Node ? e.target.ownerDocument ?? document : document;
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
      if (e.target instanceof Element && e.target.closest('[role="menubar"]')) return;
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) onClose();
    };
    anchor.doc.addEventListener('pointerdown', away, true);
    return () => anchor.doc.removeEventListener('pointerdown', away, true);
  }, [anchor.doc, onClose]);

  const view = anchor.doc.defaultView;
  const left = Math.max(8, Math.min(anchor.x, (view?.innerWidth ?? 1280) - 270));
  const top = Math.max(8, anchor.y);

  return createPortal(
    <div ref={ref} className="dropdown" role="menu" aria-label={label} style={{ left, top }}>
      {entries.map((entry, i) =>
        entry === 'separator' ? (
          <div key={`sep${i}`} className="msep" role="separator" />
        ) : (
          <div
            key={entry.id}
            role="menuitem"
            aria-disabled={entry.disabled ? true : undefined}
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
