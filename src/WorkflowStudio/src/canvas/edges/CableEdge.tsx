import { useContext, type CSSProperties } from 'react';
import type { Edge, EdgeProps } from '@xyflow/react';
import { DesignContext } from '../../design/DesignContext';
import type { EndKind } from '../../layout/circuitRoute';
import type { Pt } from '../../layout/router';
import { useLiveArt } from '../liveArt';
import { pathOf } from '../svgPath';

export type CableEdgeData = {
  points: Pt[];
  colour: string;
  /** The pulse's animation delay in seconds (≤ 0), so the wires do not pulse in step. */
  delay: number;
  /** Picked in design mode (plan 4): drawn with a halo. */
  picked?: boolean;
  /** The line under a dragged wire end (plan 7, plan 9 §6): green when the end may join it, red when refused. */
  halo?: 'ok' | 'no';
  /** Not solid (plan 9 §5): an end open, or the family undecided. */
  dashed?: boolean;
  /** What each end is on; absent: a terminal. */
  tailOn?: EndKind;
  headOn?: EndKind;
  /** In a short circuit (§2.2-7): its junction circles are red. */
  short?: boolean;
};
export type CableEdgeType = Edge<CableEdgeData, 'cable'>;

/** An undecided wire's colour: grey, of no entry condition (plan 9 rule 12). */
export const UNDECIDED_COLOUR = '#8A97A8';

/** An open chevron whose tip is `tip`, pointing along the run from `prev` (a run of no length points right). */
export function arrowHead(prev: Pt, tip: Pt): string {
  const dx = tip[0] - prev[0], dy = tip[1] - prev[1];
  const len = Math.hypot(dx, dy);
  const ux = len === 0 ? 1 : dx / len, uy = len === 0 ? 0 : dy / len;
  const bx = tip[0] - 9 * ux, by = tip[1] - 9 * uy;
  return `M${bx + 6 * uy} ${by - 6 * ux}L${tip[0]} ${tip[1]}L${bx - 6 * uy} ${by + 6 * ux}`;
}

/**
 * One wire as a circuit trace (spec §5.1; plan 9 §5): right-angled, in its family's colour (grey while undecided),
 * dashed unless both its ends are connected and its family decided. Its tail has a small ring and its head an open
 * chevron, on a terminal or open alike; an end on another wire is a filled circle instead (red in a short circuit).
 * While `flowing` (the workflow is started) a solid wire carries a pulse toward its head.
 */
export function CableEdgeView({ points, colour, delay, picked, flowing, halo, dashed, tailOn = 'terminal', headOn = 'terminal', short }: CableEdgeData & { flowing: boolean }) {
  const d = pathOf(points);
  const first = points[0]!, tip = points[points.length - 1]!;
  const dot = (p: Pt) => <circle className={short ? 'nx-joint short' : 'nx-joint'} cx={p[0]} cy={p[1]} r={4.5} />;

  return (
    <g className={`wire${dashed ? ' dashed' : ''}${picked ? ' picked' : ''}${halo ? ` halo-${halo}` : ''}`} style={{ '--nc': colour } as CSSProperties}>
      {tailOn !== 'junction' && <circle className="nx-src" cx={first[0]} cy={first[1]} r={2.6} />}
      <path className="w" d={d} stroke={colour} />
      {headOn !== 'junction' && <path className="nx-head" d={arrowHead(points[points.length - 2] ?? tip, tip)} stroke={colour} />}
      {tailOn === 'junction' && dot(first)}
      {headOn === 'junction' && dot(tip)}
      {flowing && !dashed && <path className="nx-pulse" d={d} style={{ animationDelay: `${delay}s` }} />}
    </g>
  );
}

export function CableEdge({ id, data }: EdgeProps<CableEdgeType>) {
  const { started } = useLiveArt();
  const gestures = useContext(DesignContext);
  if (!data) return null;
  return (
    <>
      <CableEdgeView {...data} flowing={started} />
      {/* an invisible band about 8 px wide, so the hand cursor and clicks need no pixel precision (spec §4.1); in design
          mode the open hand: pressed and dragged, the whole wire moves (the user's rule, 2026-10-08) */}
      <path className={gestures ? 'nx-hit grab' : 'nx-hit'} d={pathOf(data.points)} onPointerDown={gestures ? (e) => gestures.wirePointerDown(id, e) : undefined} />
    </>
  );
}
