import { getBezierPath, type EdgeProps } from '@xyflow/react';
import type { PickInfo } from '../toFlow';
import { EdgeExtras } from './EdgeExtras';

/** A cache link (edge type `cacheLink`): a dashed line from a triangle's back to one of its caches. */
export function CacheLinkEdge({ id, data, selected, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition }: EdgeProps) {
  const { workflowId, cacheId, hue, pick } = data as { workflowId: string; cacheId: string; hue: string | null; pick?: PickInfo };
  const [d, mx, my] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  return (
    <g className={`cache-edge${selected || hue !== null ? ' on' : ''}`}>
      <path className="edge-hit" d={d} />
      <path className="cache-line" d={d} fill="none" />
      <EdgeExtras id={id} pick={pick} self={{ kind: 'cacheLink', workflowId, cacheId }} selected={selected} x={mx} y={my - 4} />
    </g>
  );
}
