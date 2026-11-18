import type { CSSProperties } from 'react';
import { getBezierPath, type EdgeProps } from '@xyflow/react';
import type { PickInfo } from '../toFlow';
import { EdgeExtras } from './EdgeExtras';

/** An entry arrow (edge type `entry`): solid ink from a triangle's tip to an entry step; accent while its workflow is selected or it is picked. */
export function EntryEdge({ id, data, selected, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition }: EdgeProps) {
  const { workflowId, stepId, hue, running = false, ghost = false, pick } = data as { workflowId: string; stepId: string; hue: string | null; running?: boolean; ghost?: boolean; pick?: PickInfo };
  const [d, mx, my] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX: targetX - 2, targetY, targetPosition });
  const marker = `arrow-${id}`;
  return (
    <g className={`entry-edge${selected || hue !== null ? ' on' : ''}${ghost ? ' ghost' : ''}`} style={hue !== null ? ({ '--hue': hue } as CSSProperties) : undefined}>
      <defs>
        <marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto">
          <path className="entry-head" d="M 0 0 L 10 5 L 0 10 z" />
        </marker>
      </defs>
      <path className="edge-hit" d={d} />
      <path className={`entry-line${running ? ' running' : ''}`} d={d} fill="none" markerEnd={`url(#${marker})`} />
      <EdgeExtras id={id} pick={pick} self={{ kind: 'entry', workflowId, stepId }} selected={selected} x={mx} y={my - 4} />
    </g>
  );
}
