import { useEffect, useRef, type ReactNode } from 'react';
import type { Side } from './home';
import { TOOL_TITLES, type ToolId } from './ids';
import { asElement } from './nodes';

export type Rail = 'l' | 'r' | 'b';
/** A pane on the top edge hides to the bottom rail, as in the mockup (there is no top rail). */
export const railOf = (side: Side): Rail => (side === 'left' ? 'l' : side === 'right' ? 'r' : 'b');

const OPEN_AFTER_MS = 280; // resting on a side tab slides its pane out
const CLOSE_AFTER_MS = 550; // leaving both tab and pane slides it back

interface Props {
  hidden: readonly ToolId[];
  sideOf: (id: ToolId) => Side;
  flyId: ToolId | null;
  fresh: ReadonlySet<ToolId>;
  onOpen: (id: ToolId) => void;
  onClose: () => void;
  onPin: (id: ToolId) => void;
  renderTool: (id: ToolId) => ReactNode;
}

/**
 * Auto-hide, built in-house (spec §6.2.5; dockview's own is an enterprise module), ported from the
 * mockup: hidden panes become side tabs on the left, right or bottom rail. A click, or resting on
 * a tab, slides the pane out over the dock; leaving both, a press elsewhere or Esc slides it back;
 * Dock pins it back into the layout. A tab marked fresh glows (the Inspector's content changed).
 * Rendered inside `.dockwrap`, whose grid places the rails.
 */
export function AutoHide({ hidden, sideOf, flyId, fresh, onOpen, onClose, onPin, renderTool }: Props) {
  const openTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const flyRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => { clearTimeout(openTimer.current); clearTimeout(closeTimer.current); }, []);

  // a pending close belongs to the pane that was open; once it changes, the timer is stale
  useEffect(() => { clearTimeout(closeTimer.current); }, [flyId]);

  useEffect(() => {
    // the pane's own document (it may be rendered in a pop-out window), never the global one
    const doc = flyRef.current?.ownerDocument;
    if (flyId === null || !doc) return;
    const away = (e: PointerEvent) => {
      const t = asElement(e.target);
      if (t && (t.closest('.fly') || t.closest('[data-rt]') || t.closest('.dropdown') || t.closest('.picker'))) return;
      onClose();
    };
    doc.addEventListener('pointerdown', away, true);
    return () => doc.removeEventListener('pointerdown', away, true);
  }, [flyId, onClose]);

  const closeLater = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      const fly = flyRef.current;
      if (!fly) return;
      const doc = fly.ownerDocument;
      if (fly.matches(':hover') || fly.contains(doc.activeElement)) return;
      if (doc.querySelector('[data-rt]:hover')) return;
      onClose();
    }, CLOSE_AFTER_MS);
  };

  const rail = (edge: Rail) => {
    const ids = hidden.filter((id) => railOf(sideOf(id)) === edge);
    return (
      <div className={ids.length > 0 ? `rail-${edge} on` : `rail-${edge}`} role="tablist" aria-label={`Auto-hidden panes (${edge === 'l' ? 'left' : edge === 'r' ? 'right' : 'bottom'})`}>
        {ids.map((id) => (
          <div
            key={id}
            role="tab"
            aria-selected={flyId === id}
            data-rt={id}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              if (flyId === id) onClose(); else onOpen(id);
            }}
            className={['rt', flyId === id ? 'open' : '', fresh.has(id) ? 'fresh' : ''].filter(Boolean).join(' ')}
            onClick={(e) => { e.stopPropagation(); if (flyId === id) onClose(); else onOpen(id); }}
            onPointerEnter={() => {
              clearTimeout(openTimer.current);
              openTimer.current = setTimeout(() => { if (flyId !== id) onOpen(id); }, OPEN_AFTER_MS);
            }}
            onPointerLeave={() => { clearTimeout(openTimer.current); closeLater(); }}
          >
            <i className="fd" />
            {TOOL_TITLES[id]}
          </div>
        ))}
      </div>
    );
  };

  return (
    <>
      {rail('l')}
      {rail('r')}
      {rail('b')}
      {flyId !== null && (
        <div
          ref={flyRef}
          className={`fly ${railOf(sideOf(flyId))}`}
          role="region"
          aria-label={TOOL_TITLES[flyId]}
          onPointerEnter={() => clearTimeout(closeTimer.current)}
          onPointerLeave={closeLater}
        >
          <div className="fly-h">
            <span>{TOOL_TITLES[flyId]}</span>
            <span className="spacer" />
            <button type="button" data-tip="Dock it back into the layout" onClick={() => onPin(flyId)}>⤓ Dock</button>
            <button type="button" aria-label="Hide" data-tip="Hide (Esc)" onClick={onClose}>×</button>
          </div>
          <div className="fly-b">{renderTool(flyId)}</div>
        </div>
      )}
    </>
  );
}
