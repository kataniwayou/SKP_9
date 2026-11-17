import { NodeResizer, NodeToolbar, Position, useStore, type NodeProps } from '@xyflow/react';
import { frameSizeOf } from '../placement';
import { useBoardEdit } from './boardContext';
import { cronText } from '../../model/cronText';
import { ZOOM_DETAIL } from '../geometry';
import { useWorkflowStatus } from '../../live/LiveContext';
import { STATE_COLOUR, StateBadge } from '../live/StateBadge';
import { useBoardWorkflow, useToolbarActions } from './boardContext';
import { Toolbar } from '../Toolbar';

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
  const edit = useBoardEdit();
  const tb = useToolbarActions();
  const st = tb?.status(workflowId);
  const min = frameSizeOf(info.stepAt);
  return (
    <div className={`frame${selected ? ' sel' : ''}${far ? ' far' : ''}`}>
      {selected && edit && (
        <NodeResizer minWidth={min.w} minHeight={min.h} isVisible
          onResizeEnd={(_, p) => edit.resizeFrame(workflowId, { w: p.width, h: p.height }, { x: p.x, y: p.y })} />
      )}
      {selected && tb && st && (
        <NodeToolbar isVisible position={Position.Top} offset={10}>
          <Toolbar selection={{ kind: 'workflow' }} actions={{ onSave: () => tb.save(workflowId) }} unsaved={st.unsaved} saving={st.saving} />
        </NodeToolbar>
      )}
      <div className="fh" style={{ boxShadow: `inset 0 4px 0 ${STATE_COLOUR[status]}` }}>
        <span className="nm">{workflow.name}</span>
        {!far && <span className="meta">{workflow.version} · {schedule}</span>}
        {!far && info.entryDiff.stops.length + info.entryDiff.starts.length > 0 && <span className="diff-tag">first steps differ</span>}
        {st?.unsaved && <span className="unsaved-tag">unsaved</span>}
        {st && st.problems > 0 && <span className="warn-mark" title={`${st.problems} validation problem${st.problems === 1 ? '' : 's'}`}>⚠ {st.problems}</span>}
        <span className="sp" />
        <span className="state-slot"><StateBadge status={status} /></span>
      </div>
      {far && <div className="far-body">{n} {n === 1 ? 'step' : 'steps'}</div>}
      {!far && n === 0 && <div className="empty">Empty workflow</div>}
    </div>
  );
}
