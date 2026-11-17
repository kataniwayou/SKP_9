import { NodeResizeControl, NodeToolbar, Position, ResizeControlVariant, type ControlPosition, type NodeProps } from '@xyflow/react';
import { minFrameSize } from '../placement';
import { useBoardEdit } from './boardContext';
import { cronText } from '../../model/cronText';
import { useWorkflowStatus } from '../../live/LiveContext';
import { STATE_COLOUR, StateBadge } from '../live/StateBadge';
import { useBoardWorkflow, useToolbarActions } from './boardContext';
import { confirmText } from '../../operate/deleteWorkflow';
import { Toolbar } from '../Toolbar';
import { PickBadge, type PickInfo } from './PickBadge';

/** Spec §5: the right edge, the bottom edge and their corner resize a frame; its top-left never moves. */
const RESIZE: { position: ControlPosition; variant: ResizeControlVariant }[] = [
  { position: 'right', variant: ResizeControlVariant.Line },
  { position: 'bottom', variant: ResizeControlVariant.Line },
  { position: 'bottom-right', variant: ResizeControlVariant.Handle },
];

export function WorkflowFrame({ data, selected }: NodeProps) {
  const { workflowId, pick } = data as { workflowId: string; pick?: PickInfo };
  const info = useBoardWorkflow(workflowId);
  const status = useWorkflowStatus(workflowId);
  const edit = useBoardEdit();
  const tb = useToolbarActions();
  if (!info) return null;
  const { workflow } = info.graph;
  const cron = workflow.cronExpression;
  const parsed = cron ? cronText(cron) : null;
  const schedule = parsed === null ? 'not scheduled' : 'text' in parsed ? parsed.text : cron;
  const n = info.stepIds.length;
  const st = tb?.status(workflowId);
  const plan = tb?.pendingRemove() ?? null;
  const pending = plan && plan.ids.includes(workflowId) ? plan : null;
  const min = minFrameSize(info.stepAt, info.graph.caches.size);
  return (
    <div className={`frame${selected ? ' sel' : ''}`}>
      {selected && edit && RESIZE.map(({ position, variant }) => (
        <NodeResizeControl key={position} position={position} variant={variant} minWidth={min.w} minHeight={min.h}
          onResizeEnd={(_, p) => edit.resizeFrame(workflowId, { w: p.width, h: p.height })} />
      ))}
      <PickBadge pick={pick} />
      {selected && pick?.solo && tb && st && (
        <NodeToolbar isVisible position={Position.Top} offset={10}>
          <Toolbar selection={{ kind: 'workflow' }} actions={{ onSave: () => tb.save(workflowId), onDelete: () => tb.remove([workflowId]) }} unsaved={st.unsaved} saving={st.saving}
            {...(pending ? { confirm: { text: confirmText(pending), onConfirm: tb.confirmRemove, onCancel: tb.cancelRemove } } : {})}
            run={status === 'running' ? { op: 'stop', enabled: true, onRun: () => tb.stop(workflowId) } : { op: 'start', enabled: status === 'stopped', onRun: () => tb.start(workflowId) }} />
        </NodeToolbar>
      )}
      <div className="fh" style={{ boxShadow: `inset 0 4px 0 ${STATE_COLOUR[status]}` }}>
        <span className="nm">{workflow.name}</span>
        <span className="meta">{workflow.version} · {schedule}</span>
        {info.entryDiff.stops.length + info.entryDiff.starts.length > 0 && <span className="diff-tag">first steps differ</span>}
        {st?.unsaved && <span className="unsaved-tag">unsaved</span>}
        {st && st.problems > 0 && <span className="warn-mark" title={`${st.problems} validation problem${st.problems === 1 ? '' : 's'}`}>⚠ {st.problems}</span>}
        <span className="sp" />
        <span className="state-slot"><StateBadge status={status} /></span>
      </div>
      {n === 0 && <div className="empty">Empty workflow</div>}
    </div>
  );
}
