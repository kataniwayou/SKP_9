import type { Edge, EdgeProps } from '@xyflow/react';
import type { Pt } from '../../layout/router';
import { pathOf } from '../svgPath';

export type TetherEdgeData = { points: Pt[] };
export type TetherEdgeType = Edge<TetherEdgeData, 'tether'>;

/** The dashed tether that ties a linked cache to the workflow sphere. */
export function TetherEdge({ data }: EdgeProps<TetherEdgeType>) {
  return data ? <path className="tether" d={pathOf(data.points)} /> : null;
}
