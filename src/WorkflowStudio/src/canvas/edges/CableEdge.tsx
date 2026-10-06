import { useId, type CSSProperties } from 'react';
import type { Edge, EdgeProps } from '@xyflow/react';
import type { Pt } from '../../layout/router';
import { useLiveArt } from '../liveArt';
import { longestSegmentMiddle, pathOf } from '../svgPath';

export type CableEdgeData = {
  points: Pt[];
  colour: string;
  broken: boolean;
  /** The pulse's animation delay in seconds (≤ 0), so the wires do not pulse in step. */
  delay: number;
};
export type CableEdgeType = Edge<CableEdgeData, 'cable'>;

/**
 * One wire as a circuit trace (spec §5.1; gallery trace90, mockup v50 cable): right-angled, a ring at
 * the source, an open chevron whose tip is the landing point, in the target's entry-condition colour.
 * Broken: dashed, with a soft transparent gap cut at the middle of the longest segment and ⚠ in it.
 * While `flowing` (the workflow is started) an intact wire carries a pulse toward its target.
 */
export function CableEdgeView({ points, colour, broken, delay, flowing }: CableEdgeData & { flowing: boolean }) {
  const gap = `nxgap${useId().replace(/[^\w-]/g, '')}`;
  const d = pathOf(points);
  const [sx, sy] = points[0]!;
  const [tx, ty] = points[points.length - 1]!;
  const mark = broken ? longestSegmentMiddle(points) : null;

  const trace = (
    <>
      <circle className="nx-src" cx={sx} cy={sy} r={2.6} />
      <path className="w" d={d} stroke={colour} />
      <path className="nx-head" d={`M${tx - 9} ${ty - 6}L${tx} ${ty}L${tx - 9} ${ty + 6}`} stroke={colour} />
    </>
  );

  return (
    <g className={broken ? 'wire broken' : 'wire'} style={{ '--nc': colour } as CSSProperties}>
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
      {flowing && !broken && <path className="nx-pulse" d={d} style={{ animationDelay: `${delay}s` }} />}
    </g>
  );
}

export function CableEdge({ data }: EdgeProps<CableEdgeType>) {
  const { started } = useLiveArt();
  return data ? <CableEdgeView {...data} flowing={started} /> : null;
}
