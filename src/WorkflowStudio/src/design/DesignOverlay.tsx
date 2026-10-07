import type { PointerEvent as ReactPointerEvent } from 'react';
import { useStore, ViewportPortal } from '@xyflow/react';
import { endsOf, segmentHandles, type Bends, type Ends } from '../layout/shape';
import type { WireRoute } from '../layout/wires';
import type { Point } from '../layout/geometry';
import type { GuideLine } from './guides';
import type { FlowRect } from './hit';
import { dropLabel } from './rules';
import type { DropHint } from './useWireGestures';

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
  /** The block under a dragged end: the label next to the pointer says why a drop is refused, or what it does. */
  hint?: DropHint | null;
}

/** On-screen sizes (px) that do not shrink with the zoom: at the fitted zoom a 2 px line would vanish. */
const DOT_R = 5, SQUARE = 9, BEND = 4, LINE = 1.5, GHOST = 1.6, LABEL_H = 18, LABEL_PAD = 6, LABEL_FONT = 11.5;

/**
 * A run square is drawn only where an end dot does not cover it: on a run too short on screen, the dot
 * (drawn above) would take every press meant for the square. That run is still dragged through the wire's body.
 */
function clearOfDots(h: { x: number; y: number }, ends: Ends, k: number): boolean {
  const room = (DOT_R + SQUARE / 2 + 1) * k;
  return Math.hypot(h.x - ends.sx, h.y - ends.sy) >= room && Math.hypot(h.x - ends.tx, h.y - ends.ty) >= room;
}

/**
 * Drawn above the blocks in flow coordinates: the rubber band (spec §3.2), the alignment guides (§3.4),
 * and a picked wire's handles (§4.2, Visio): a green dot on each end, a square in the middle of each run,
 * a diamond on each bend; and the ghost wire while an end or a new wire is dragged (§4.4-§4.5).
 */
export function DesignOverlay({ band, guides, wires, bendsOf, onSegment, onEnd, ghost, hint = null }: DesignOverlayProps) {
  // one screen pixel in flow units
  const k = 1 / useStore((s) => s.transform[2]);
  const label = hint ? dropLabel(hint.why, hint.newWire) : null;
  return (
    <ViewportPortal>
      <svg className="design-overlay" width={1} height={1}>
        {band && <rect className="design-band" x={band.x0} y={band.y0} width={band.x1 - band.x0} height={band.y1 - band.y0} strokeWidth={k} strokeDasharray={`${4 * k} ${3 * k}`} />}
        {guides.map((l, i) => <line key={i} className="design-guide" x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} strokeWidth={k} />)}
        {wires.map((w) => {
          const ends = endsOf(w.points);
          const inner = w.points.slice(1, -1);
          return (
            <g key={w.id} className="design-wire" data-wire={w.id}>
              {inner.map(([x, y], i) => <path key={`b${i}`} className="design-handle bend" d={`M${x} ${y - BEND * k}L${x + BEND * k} ${y}L${x} ${y + BEND * k}L${x - BEND * k} ${y}Z`} />)}
              {segmentHandles(ends, bendsOf(w)).filter((h) => clearOfDots(h, ends, k)).map((h) => (
                <rect key={`s${h.k}`} className={h.vertical ? 'design-handle seg v' : 'design-handle seg h'} data-k={h.k} x={h.x - (SQUARE / 2) * k} y={h.y - (SQUARE / 2) * k} width={SQUARE * k} height={SQUARE * k} strokeWidth={LINE * k}
                  onPointerDown={(e) => onSegment(w, h.k, e)} />
              ))}
              <circle className="design-handle end" data-end="source" cx={ends.sx} cy={ends.sy} r={DOT_R * k} strokeWidth={LINE * k} onPointerDown={(e) => onEnd(w, 'source', e)} />
              <circle className="design-handle end" data-end="target" cx={ends.tx} cy={ends.ty} r={DOT_R * k} strokeWidth={LINE * k} onPointerDown={(e) => onEnd(w, 'target', e)} />
            </g>
          );
        })}
        {ghost && <path className="design-ghost" d={`M${ghost.from.x} ${ghost.from.y}L${ghost.to.x} ${ghost.to.y}`} strokeWidth={GHOST * k} strokeDasharray={`${5 * k} ${4 * k}`} />}
        {hint && label && (
          // drawn in screen pixels: the group undoes the zoom, offset below-right of the pointer
          <g className={hint.ok ? 'design-drop-label ok' : 'design-drop-label no'} transform={`translate(${hint.at.x + 14 * k} ${hint.at.y + 14 * k}) scale(${k})`}>
            <rect x={0} y={0} rx={4} height={LABEL_H} width={label.length * LABEL_FONT * 0.56 + 2 * LABEL_PAD} />
            <text x={LABEL_PAD} y={LABEL_H / 2 + LABEL_FONT * 0.36} fontSize={LABEL_FONT}>{label}</text>
          </g>
        )}
      </svg>
    </ViewportPortal>
  );
}
