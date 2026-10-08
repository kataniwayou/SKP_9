import { useContext, useId, type CSSProperties } from 'react';
import type { Edge, EdgeProps } from '@xyflow/react';
import { DesignContext } from '../../design/DesignContext';
import { LOOSE_PREFIX } from '../../design/draft';
import type { Pt } from '../../layout/router';
import { useLiveArt } from '../liveArt';
import { longestSegmentMiddle, pathOf } from '../svgPath';

export type CableEdgeData = {
  points: Pt[];
  colour: string;
  broken: boolean;
  /** The pulse's animation delay in seconds (≤ 0), so the wires do not pulse in step. */
  delay: number;
  /** Picked in design mode (plan 4): drawn with a halo. */
  picked?: boolean;
  /** A joined wire's branch, from its split to its landing (plan 7). */
  branch?: Pt[];
  /** A joined wire's filled dots: its contact, then its split. */
  joints?: Pt[];
  /** The line under a dragged wire end: green when it may be joined, grey when the wire would be loose there (plan 7, plan 8 §5). */
  halo?: 'ok' | 'no' | 'loose';
  /** A loose wire (plan 8 §5): grey, dashed, an open circle at its end, no arrow head. */
  loose?: boolean;
  /** Loose at its start (its tail detached): dashed in its own colour, an open circle at its start, its head and junction as drawn when connected. */
  openStart?: boolean;
};
export type CableEdgeType = Edge<CableEdgeData, 'cable'>;

/** A loose wire's colour: grey, of no entry condition (plan 8 §5). */
export const LOOSE_COLOUR = '#8A97A8';

/**
 * One wire as a circuit trace (spec §5.1; gallery trace90, mockup v50 cable): right-angled, a ring at
 * the source, an open chevron whose tip is the landing point, in the target's entry-condition colour.
 * Broken: dashed, with a soft transparent gap cut at the middle of the longest segment and ⚠ in it.
 * While `flowing` (the workflow is started) an intact wire carries a pulse toward its target.
 * Loose (plan 8 §5): grey and dashed, a ring at its source and an open circle where it was dropped; never pulses.
 * Loose at its start: dashed in its colour, an open circle where its tail was dropped, its arrow head kept; never pulses.
 */
export function CableEdgeView({ points, colour, broken, delay, picked, flowing, branch, joints, halo, loose, openStart }: CableEdgeData & { flowing: boolean }) {
  const gap = `nxgap${useId().replace(/[^\w-]/g, '')}`;
  if (loose && !openStart) {
    const [sx0, sy0] = points[0]!;
    const [ex, ey] = points[points.length - 1]!;
    return (
      <g className={`wire loose${picked ? ' picked' : ''}`} style={{ '--nc': LOOSE_COLOUR } as CSSProperties}>
        <circle className="nx-src" cx={sx0} cy={sy0} r={2.6} />
        <path className="w" d={pathOf(points)} stroke={LOOSE_COLOUR} />
        <circle className="nx-open" cx={ex} cy={ey} r={4.5} />
      </g>
    );
  }
  const d = pathOf(points);
  const [sx, sy] = points[0]!;
  // the arrow head goes on the line that enters a step: a plain wire's end, or a joined wire's branch end (spec §3)
  const into = joints ? (branch && branch.length > 1 ? branch : null) : points;
  const tip = into ? into[into.length - 1]! : null;
  const mark = broken ? longestSegmentMiddle(points) : null;

  const trace = (
    <>
      {!openStart && <circle className="nx-src" cx={sx} cy={sy} r={2.6} />}
      <path className="w" d={d} stroke={colour} />
      {branch && branch.length > 1 && <path className="w branch" d={pathOf(branch)} stroke={colour} />}
      {tip && <path className="nx-head" d={`M${tip[0] - 9} ${tip[1] - 6}L${tip[0]} ${tip[1]}L${tip[0] - 9} ${tip[1] + 6}`} stroke={colour} />}
      {joints?.map(([x, y], i) => <circle key={i} className="nx-joint" cx={x} cy={y} r={4.5} />)}
      {openStart && <circle className="nx-open" cx={sx} cy={sy} r={4.5} />}
    </>
  );

  return (
    <g className={`${broken ? 'wire broken' : 'wire'}${openStart ? ' loose' : ''}${picked ? ' picked' : ''}${halo ? ` halo-${halo}` : ''}`} style={{ '--nc': colour } as CSSProperties}>
      {mark ? (
        <>
          <defs>
            <filter id={`${gap}s`} x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation={3} /></filter>
            <mask id={gap} maskUnits="userSpaceOnUse" x={-1e5} y={-1e5} width={2e5} height={2e5}>
              <rect x={-1e5} y={-1e5} width={2e5} height={2e5} fill="#fff" />
              <rect x={mark[0] - 10} y={mark[1] - 7} width={20} height={14} rx={5} fill="#000" filter={`url(#${gap}s)`} />
            </mask>
          </defs>
          <g mask={`url(#${gap})`}>{trace}</g>
          <text className="nx-warn" x={mark[0]} y={mark[1] + 5} textAnchor="middle">⚠</text>
        </>
      ) : trace}
      {flowing && !broken && !openStart && <path className="nx-pulse" d={d} style={{ animationDelay: `${delay}s` }} />}
      {flowing && !broken && !openStart && branch && branch.length > 1 && <path className="nx-pulse" d={pathOf(branch)} style={{ animationDelay: `${delay}s` }} />}
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
      {/* an invisible band about 8 px wide, so the hand cursor and clicks need no pixel precision (spec §4.1);
          a loose wire keeps it too: it is what makes a click pick the wire */}
      <path className="nx-hit" d={pathOf(data.points)} onPointerDown={gestures ? (e) => gestures.wirePointerDown(id, e, 'own') : undefined} />
      {data.branch && data.branch.length > 1 && (
        <path className="nx-hit branch" d={pathOf(data.branch)} onPointerDown={gestures ? (e) => gestures.wirePointerDown(id, e, 'branch') : undefined} />
      )}
      {/* a loose wire's open end (or open start) is always draggable in design mode (plan 8 §5) */}
      {data.loose && gestures && (() => {
        const [ex, ey] = data.openStart ? data.points[0]! : data.points[data.points.length - 1]!;
        return <circle className="nx-open-hit" cx={ex} cy={ey} r={9} onPointerDown={(e) => gestures.looseEndPointerDown(id.slice(LOOSE_PREFIX.length), e)} />;
      })()}
    </>
  );
}
