import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { windowKey } from './windowKey';
import { asElement } from './nodes';

const DELAY_MS = 350;

/**
 * The tooltip an element asks for (mockup v49): `data-tip` always shows; `data-tipcut` (read-only
 * text) shows only when the element's text was cut, i.e. it overflows its box (spec §7).
 */
export function tipFor(target: Element | null): { el: Element; text: string } | null {
  const el = target?.closest('[data-tip],[data-tipcut]') ?? null;
  if (!el) return null;
  const always = el.getAttribute('data-tip');
  if (always !== null) return always === '' ? null : { el, text: always };
  const box = el as HTMLElement;
  if (box.scrollWidth <= box.clientWidth + 1) return null;
  return { el, text: el.getAttribute('data-tipcut') ?? '' };
}

/** One window's tooltip, at --z-tip, following the pointer in that window's document. */
function WindowTooltip({ win }: { win: Window }) {
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const [on, setOn] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const doc = win.document;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: Element | null = null;
    const move = (e: PointerEvent) => {
      const found = tipFor(asElement(e.target));
      if ((found?.el ?? null) !== current) {
        current = found?.el ?? null;
        clearTimeout(timer);
        setOn(false);
        if (found) timer = setTimeout(() => { setTip({ text: found.text, x: e.clientX, y: e.clientY }); setOn(true); }, DELAY_MS);
      } else if (found) {
        setTip((t) => (t ? { ...t, x: e.clientX, y: e.clientY } : t));
      }
    };
    const down = () => { clearTimeout(timer); current = null; setOn(false); };
    doc.addEventListener('pointermove', move);
    doc.addEventListener('pointerdown', down, true);
    return () => {
      clearTimeout(timer);
      doc.removeEventListener('pointermove', move);
      doc.removeEventListener('pointerdown', down, true);
    };
  }, [win]);

  // keep it inside the window, as the mockup's placeTip does
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !tip) return;
    el.style.left = `${Math.min(tip.x + 14, win.innerWidth - el.offsetWidth - 8)}px`;
    el.style.top = `${Math.min(tip.y + 18, win.innerHeight - el.offsetHeight - 8)}px`;
  }, [tip, win]);

  return createPortal(
    <div ref={ref} className={on ? 'tip on' : 'tip'} role="tooltip" aria-hidden={!on}>{tip?.text ?? ''}</div>,
    win.document.body,
  );
}

/** Tooltips for the main window and every pop-out window. */
export function Tooltips({ windows }: { windows: readonly Window[] }) {
  return <>{windows.map((w) => <WindowTooltip key={windowKey(w)} win={w} />)}</>;
}
