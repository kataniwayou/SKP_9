import { EdgeLabelRenderer, type EdgeProps } from '@xyflow/react';
import { useWorkflowStatus } from '../../live/LiveContext';
import { conditionStyle } from '../wires';
import { wirePath } from '../wirePath';
import type { Point } from '../../model/geometry';
import { Toolbar } from '../Toolbar';
import { useToolbarActions } from '../nodes/boardContext';
import { PickBadge, type PickInfo } from '../nodes/PickBadge';

/** One wire (the mock's): a 2.2 px curve in the target's entry colour, its arrowhead, the letter pill just before it. */
export function LinkWire({ id, data, selected }: EdgeProps) {
  const workflowId = (data as { workflowId?: string } | undefined)?.workflowId ?? '';
  const running = useWorkflowStatus(workflowId) === 'running';
  const tb = useToolbarActions();
  const { condition, out, in: inn, wireId, pick } = data as { condition: number; out: Point; in: Point; wireId: string; pick?: PickInfo };
  const style = conditionStyle(condition);
  const { d, pill } = wirePath(out, inn);
  const px = pill.x;
  const py = pill.y;
  // the curve's middle (its control points are symmetric): where the mock puts a wire's pick number and its toolbar
  const mx = (out.x + inn.x - 9) / 2;
  const my = (out.y + inn.y) / 2;
  const marker = `arrow-${id}`;
  return (
    <g className={`link-wire${selected ? ' sel' : ''}`} data-condition={style.name}>
      <defs>
        <marker id={marker} viewBox="0 0 10 10" refX="1" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={style.colour} />
        </marker>
      </defs>
      <path className="wire-hit" d={d} />
      <path className={`wire${selected ? ' sel' : ''}${running ? ' running' : ''}`} d={d} stroke={style.colour} fill="none" markerEnd={`url(#${marker})`} />
      <circle className="pill" cx={px} cy={py} r={8} fill={style.colour} />
      <text className="pilltx" x={px} y={py + 3.5} textAnchor="middle">{style.letter}</text>
      {pick && !pick.solo && (
        <EdgeLabelRenderer>
          <div className="pick-wire" style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${mx}px, ${my}px)`, pointerEvents: 'none' }}>
            <PickBadge pick={pick} className="inline" />
          </div>
        </EdgeLabelRenderer>
      )}
      {selected && pick?.solo && tb && (
        <EdgeLabelRenderer>
          <div style={{ position: 'absolute', transform: `translate(-50%, calc(-100% - 10px)) translate(${mx}px, ${my - 4}px)`, pointerEvents: 'all' }}>
            <Toolbar selection={{ kind: 'wire' }} actions={{ onDelete: () => tb.deleteWire(workflowId, wireId) }} />
          </div>
        </EdgeLabelRenderer>
      )}
    </g>
  );
}
