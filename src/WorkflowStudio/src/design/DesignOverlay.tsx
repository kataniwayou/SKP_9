import type { PointerEvent as ReactPointerEvent } from 'react';
import { ViewportPortal } from '@xyflow/react';
import { endsOf, segmentHandles, type Bends } from '../layout/shape';
import type { WireRoute } from '../layout/wires';
import type { Point } from '../layout/geometry';
import type { GuideLine } from './guides';
import type { FlowRect } from './hit';

export interface DesignOverlayProps {
  band: FlowRect | null;
  /** Alignment guides while blocks are dragged (spec §3.4). */
  guides: GuideLine[];
  /** The picked wires, as shown. */
  wires: WireRoute[];
  /** A wire's shape as bends (the draft's manual bends, else the router's): its run squares follow it. */
  bendsOf: (wire: WireRoute) => Bends;
  onSegment: (wire: WireRoute, k: number, e: ReactPointerEvent) => void;
  onEnd: (wire: WireRoute, end: 'source' | 'target', e: ReactPointerEvent) => void;
  /** The line from a dragged wire end's fixed side to the pointer (spec §4.4-§4.5). */
  ghost: { from: Point; to: Point } | null;
}

/**
 * Drawn above the blocks in flow coordinates: the rubber band (spec §3.2), the alignment guides (§3.4),
 * and a picked wire's handles (§4.2, Visio): a green dot on each end, a square in the middle of each run,
 * a diamond on each bend; and the ghost wire while an end or a new wire is dragged (§4.4-§4.5).
 */
export function DesignOverlay({ band, guides, wires, bendsOf, onSegment, onEnd, ghost }: DesignOverlayProps) {
  return (
    <ViewportPortal>
      <svg className="design-overlay" width={1} height={1}>
        {band && <rect className="design-band" x={band.x0} y={band.y0} width={band.x1 - band.x0} height={band.y1 - band.y0} />}
        {guides.map((l, i) => <line key={i} className="design-guide" x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} />)}
        {wires.map((w) => {
          const ends = endsOf(w.points);
          const inner = w.points.slice(1, -1);
          return (
            <g key={w.id} className="design-wire" data-wire={w.id}>
              {inner.map(([x, y], i) => <path key={`b${i}`} className="design-handle bend" d={`M${x} ${y - 4}L${x + 4} ${y}L${x} ${y + 4}L${x - 4} ${y}Z`} />)}
              {segmentHandles(ends, bendsOf(w)).map((h) => (
                <rect key={`s${h.k}`} className={h.vertical ? 'design-handle seg v' : 'design-handle seg h'} data-k={h.k} x={h.x - 4} y={h.y - 4} width={8} height={8}
                  onPointerDown={(e) => onSegment(w, h.k, e)} />
              ))}
              <circle className="design-handle end" data-end="source" cx={ends.sx} cy={ends.sy} r={5} onPointerDown={(e) => onEnd(w, 'source', e)} />
              <circle className="design-handle end" data-end="target" cx={ends.tx} cy={ends.ty} r={5} onPointerDown={(e) => onEnd(w, 'target', e)} />
            </g>
          );
        })}
        {ghost && <path className="design-ghost" d={`M${ghost.from.x} ${ghost.from.y}L${ghost.to.x} ${ghost.to.y}`} />}
      </svg>
    </ViewportPortal>
  );
}
