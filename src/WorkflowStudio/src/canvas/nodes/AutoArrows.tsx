import { useContext, useEffect, useRef } from 'react';
import type { Dir } from '../../design/autoConnect';
import { DesignContext } from '../../design/DesignContext';

/**
 * Visio's AutoConnect arrows round a block (plan 10 phase 6, spec §4.8): one per `dirs`, anchored at the middle of its
 * side (`mid`: the height of the right and left ones, where wires leave and land); canvas.css draws each as a small
 * light-blue triangle 24 screen px out, at any zoom, shown while the block is hovered, with an invisible bridge back to
 * the block so the pointer can reach it. Pressed, the designer's gestures take it: a click adds the next step, a drag a
 * wire. Design mode only.
 */
export function AutoArrows({ id, dirs, w, h, mid }: { id: string; dirs: readonly Dir[] | undefined; w: number; h: number; mid: number }) {
  const gestures = useContext(DesignContext);
  // the arrow under the pointer: one taken away there (a wire drawn from the block, design mode left) gets no pointer
  // leave, so it says none itself, or the canvas keeps previewing its click (a landing box left behind, 2026-10-22)
  const hovered = useRef<Dir | null>(null);
  const gestureRef = useRef(gestures);
  gestureRef.current = gestures;
  useEffect(() => {
    if (hovered.current !== null && !dirs?.includes(hovered.current)) {
      hovered.current = null;
      gestureRef.current?.arrowHover(null);
    }
  }, [dirs]);
  useEffect(() => () => { if (hovered.current !== null) gestureRef.current?.arrowHover(null); }, []);
  if (!gestures || !dirs || dirs.length === 0) return null;
  const at = (d: Dir) => (d === 'right' ? { left: w, top: mid } : d === 'left' ? { left: 0, top: mid } : d === 'up' ? { left: w / 2, top: 0 } : { left: w / 2, top: h });
  return (
    <>
      {dirs.map((d) => (
        <div key={d} className="nx-ac nodrag nopan" data-dir={d} style={at(d)}
          onPointerDown={(e) => gestures.arrowPointerDown(id, d, e)}
          onPointerEnter={() => { hovered.current = d; gestures.arrowHover({ id, dir: d }); }}
          onPointerLeave={() => { hovered.current = null; gestures.arrowHover(null); }} />
      ))}
    </>
  );
}
