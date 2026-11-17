import { useStore, type NodeProps } from '@xyflow/react';
import { cronText } from '../../model/cronText';
import { ZOOM_DETAIL } from '../geometry';
import { useWorkflowStatus } from '../../live/LiveContext';
import { STATE_COLOUR, StateBadge } from '../live/StateBadge';
import { useBoardWorkflow } from './boardContext';

export function WorkflowFrame({ data, selected }: NodeProps) {
  const workflowId = (data as { workflowId: string }).workflowId;
  const info = useBoardWorkflow(workflowId);
  const status = useWorkflowStatus(workflowId);
  const far = useStore((s) => s.transform[2] < ZOOM_DETAIL);
  if (!info) return null;
  const { workflow } = info.graph;
  const cron = workflow.cronExpression;
  const parsed = cron ? cronText(cron) : null;
  const schedule = parsed === null ? 'not scheduled' : 'text' in parsed ? parsed.text : cron;
  const n = info.stepIds.length;
  return (
    <div className={`frame${selected ? ' sel' : ''}${far ? ' far' : ''}`}>
      <div className="fh" style={{ boxShadow: `inset 0 4px 0 ${STATE_COLOUR[status]}` }}>
        <span className="nm">{workflow.name}</span>
        {!far && <span className="meta">{workflow.version} · {schedule}</span>}
        {!far && info.entryDiff.stops.length + info.entryDiff.starts.length > 0 && <span className="diff-tag">first steps differ</span>}
        <span className="sp" />
        <span className="state-slot"><StateBadge status={status} /></span>
      </div>
      {far && <div className="far-body">{n} {n === 1 ? 'step' : 'steps'}</div>}
      {!far && n === 0 && <div className="empty">Empty workflow</div>}
    </div>
  );
}
