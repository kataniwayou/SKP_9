import type { PointerEvent as ReactPointerEvent } from 'react';
import { useStore, ViewportPortal } from '@xyflow/react';
import type { Side } from '../circuit/circuit';
import type { WireRoute } from '../layout/circuitRoute';
import type { Bends } from '../layout/shape';
import type { Pt } from '../layout/router';
import { pathOf } from '../canvas/svgPath';
import { squaresOf, SQUARE } from './cut';
import { dropLabel } from './drop';
import type { GuideLine } from './guides';
import type { FlowRect } from './hit';
import type { DropHint } from './useWireGestures';

export interface DesignOverlayProps {
  band: FlowRect | null;
  /** Alignment guides while blocks are dragged (spec §3.4). */
  guides: GuideLine[];
  /** The picked wires, as shown. */
  wires: WireRoute[];
  /** A wire's shape as bends (its own manual bends, else the router's): its run squares follow it. */
  bendsOf: (wire: WireRoute) => Bends;
  onSegment: (wire: WireRoute, k: number, e: ReactPointerEvent) => void;
  /** An end square pressed: the wire's tail or head, whatever it is on (plan 9 §6). */
  onEnd: (wire: WireRoute, side: Side, e: ReactPointerEvent) => void;
  /** A new wire's path, right-angled from its source to the pointer (spec §4.5); a dragged end moves its own wire. */
  ghost: Pt[] | null;
  /** What is under each dragged end: the label next to it says what the drop does, or why it is refused. */
  hints?: readonly DropHint[];
  /** The part of a wire an end released here would cut away, drawn faded (the user's rule, 2026-10-09). */
  gone?: Pt[] | null;
}

/** On-screen sizes (px) that do not shrink with the zoom: at the fitted zoom a 2 px line would vanish. */
const LINE = 1.5, GHOST = 1.6, LABEL_H = 18, LABEL_PAD = 6, LABEL_FONT = 11.5;

/**
 * Drawn above the blocks in flow coordinates: the rubber band (spec §3.2), the alignment guides (§3.4), and a picked
 * wire's squares (§4.2, Visio; plan 9 rule 14): one on each end (tail and head, on whatever they are), one in the
 * middle of each run of its core (no mark on a bend); and the ghost of a new wire while it is drawn (§4.5).
 */
export function DesignOverlay({ band, guides, wires, bendsOf, onSegment, onEnd, ghost, hints = [], gone = null }: DesignOverlayProps) {
  // one screen pixel in flow units
  const k = 1 / useStore((s) => s.transform[2]);
  return (
    <ViewportPortal>
      <svg className="design-overlay" width={1} height={1}>
        {band && <rect className="design-band" x={band.x0} y={band.y0} width={band.x1 - band.x0} height={band.y1 - band.y0} strokeWidth={k} strokeDasharray={`${4 * k} ${3 * k}`} />}
        {guides.map((l, i) => <line key={i} className="design-guide" x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} strokeWidth={k} />)}
        {wires.map((w) => {
          const sq = (x: number, y: number) => ({ x: x - (SQUARE / 2) * k, y: y - (SQUARE / 2) * k, width: SQUARE * k, height: SQUARE * k, strokeWidth: LINE * k });
          return (
            <g key={w.id} className="design-wire" data-wire={w.id}>
              {squaresOf(w, bendsOf(w), k).map((s) => (s.kind === 'run'
                ? <rect key={`s${s.k}`} className={s.vertical ? 'design-handle seg v' : 'design-handle seg h'} data-k={s.k} {...sq(s.x, s.y)}
                  onPointerDown={(e) => onSegment(w, s.k, e)} />
                : <rect key={s.side} className="design-handle end" data-end={s.side} {...sq(s.x, s.y)} onPointerDown={(e) => onEnd(w, s.side, e)} />))}
            </g>
          );
        })}
        {ghost && <path className="design-ghost" d={pathOf(ghost)} strokeWidth={GHOST * k} />}
        {gone && gone.length > 1 && <path className="design-gone" d={pathOf(gone)} strokeWidth={4 * k} />}
        {hints.map((hint, i) => {
          const label = dropLabel(hint.why);
          return (
            // drawn in screen pixels: the group undoes the zoom, offset below-right of the pointer (or the end)
            <g key={i} className={`design-drop-label ${hint.tone}`} transform={`translate(${hint.at.x + 14 * k} ${hint.at.y + 14 * k}) scale(${k})`}>
              <rect x={0} y={0} rx={4} height={LABEL_H} width={label.length * LABEL_FONT * 0.56 + 2 * LABEL_PAD} />
              <text x={LABEL_PAD} y={LABEL_H / 2 + LABEL_FONT * 0.36} fontSize={LABEL_FONT}>{label}</text>
            </g>
          );
        })}
      </svg>
    </ViewportPortal>
  );
}
