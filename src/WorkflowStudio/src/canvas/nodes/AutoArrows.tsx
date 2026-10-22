import { useContext } from 'react';
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
  if (!gestures || !dirs || dirs.length === 0) return null;
  const at = (d: Dir) => (d === 'right' ? { left: w, top: mid } : d === 'left' ? { left: 0, top: mid } : d === 'up' ? { left: w / 2, top: 0 } : { left: w / 2, top: h });
  return (
    <>
      {dirs.map((d) => (
        <div key={d} className="nx-ac nodrag nopan" data-dir={d} style={at(d)}
          onPointerDown={(e) => gestures.arrowPointerDown(id, d, e)}
          onPointerEnter={() => gestures.arrowHover({ id, dir: d })}
          onPointerLeave={() => gestures.arrowHover(null)} />
      ))}
    </>
  );
}
