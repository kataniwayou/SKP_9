import type { Edge, EdgeProps } from '@xyflow/react';
import type { Pt } from '../../layout/router';
import { longestSegmentMiddle, pathOf } from '../svgPath';

export type CableEdgeData = { points: Pt[]; colour: string; broken: boolean };
export type CableEdgeType = Edge<CableEdgeData, 'cable'>;

/**
 * One lit cable (spec §5.2): shadow, halo, line and specular core, ending in an arrow head whose tip
 * is exactly the landing point on the step's left edge. A broken wire is dashed, has no core, and
 * carries a "!" disc at the middle of its longest segment. The points come from layout/wires.ts;
 * React Flow's handle coordinates are not used.
 */
export function CableEdgeView({ points, colour, broken }: CableEdgeData) {
  const d = pathOf(points);
  const [tx, ty] = points[points.length - 1]!;
  const head = `${tx},${ty} ${tx - 10},${ty - 5} ${tx - 10},${ty + 5}`;
  const mark = broken ? longestSegmentMiddle(points) : null;

  return (
    <g className={broken ? 'wire broken' : 'wire'}>
      <path className="wshadow" d={d} />
      <polygon className="ashadow" points={head} />
      <path className="whalo" d={d} stroke={colour} />
      <path className="w" d={d} stroke={colour} />
      <path className="wcore" d={d} />
      <polygon className="ahead" points={head} fill={colour} />
      <path className="alit" d={`M${tx - 10} ${ty - 5} L${tx} ${ty}`} />
      {mark && (
        <>
          <circle className="brk" cx={mark[0]} cy={mark[1]} r={9} fill="#0A1220" stroke={colour} strokeWidth={1.4} />
          <text x={mark[0]} y={mark[1] + 4} textAnchor="middle" fontSize={11} fontWeight={600} fill={colour}>!</text>
        </>
      )}
    </g>
  );
}

export function CableEdge({ data }: EdgeProps<CableEdgeType>) {
  return data ? <CableEdgeView {...data} /> : null;
}
