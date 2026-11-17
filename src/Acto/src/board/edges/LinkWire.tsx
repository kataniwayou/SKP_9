import { EdgeLabelRenderer, useStore, type EdgeProps } from '@xyflow/react';
import { useWorkflowStatus } from '../../live/LiveContext';
import { conditionStyle } from '../wires';
import { wirePath } from '../wirePath';
import type { Point } from '../../model/geometry';
import { ZOOM_DETAIL } from '../geometry';
import { Toolbar } from '../Toolbar';
import { useToolbarActions } from '../nodes/boardContext';
import { PickBadge, type PickInfo } from '../nodes/PickBadge';

export function LinkWire({ id, data, selected }: EdgeProps) {
  const workflowId = (data as { workflowId?: string } | undefined)?.workflowId ?? '';
  const running = useWorkflowStatus(workflowId) === 'running';
  const far = useStore((s) => s.transform[2] < ZOOM_DETAIL);
  const tb = useToolbarActions();
  if (far) return null;
  const { condition, out, in: inn, wireId, pick } = data as { condition: number; out: Point; in: Point; wireId: string; pick?: PickInfo };
  const style = conditionStyle(condition);
  const { d, pill } = wirePath(out, inn);
  const px = pill.x;
  const py = pill.y;
  const marker = `arrow-${id}`;
  return (
    <g className={`link-wire${selected ? ' sel' : ''}`} data-condition={style.name}>
      <defs>
        <marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={style.colour} />
        </marker>
      </defs>
      <path className="wire-hit" d={d} />
      <path className={`wire${selected ? ' sel' : ''}${running ? ' running' : ''}`} d={d} stroke={style.colour} strokeWidth={selected ? 3.6 : 2.2} fill="none" markerEnd={`url(#${marker})`} />
      <circle cx={px} cy={py} r={8} fill={style.colour} />
      <text className="pilltx" x={px} y={py} textAnchor="middle" dominantBaseline="central">{style.letter}</text>
      {pick && !pick.solo && (
        <EdgeLabelRenderer>
          <div className="pick-wire" style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${px + 8}px, ${py - 12}px)`, pointerEvents: 'none' }}>
            <PickBadge pick={pick} className="inline" />
          </div>
        </EdgeLabelRenderer>
      )}
      {selected && pick?.solo && tb && (
        <EdgeLabelRenderer>
          <div style={{ position: 'absolute', transform: `translate(-50%, calc(-100% - 18px)) translate(${px}px, ${py}px)`, pointerEvents: 'all' }}>
            <Toolbar selection={{ kind: 'wire' }} actions={{ onDelete: () => tb.deleteWire(workflowId, wireId) }} />
          </div>
        </EdgeLabelRenderer>
      )}
    </g>
  );
}
