import { Handle, NodeToolbar, Position, useStore, type NodeProps } from '@xyflow/react';
import type { StepRole } from '../roles';
import { conditionStyle } from '../wires';
import { ZOOM_DETAIL } from '../geometry';
import { HealthDot } from '../live/HealthDot';
import { useBoardWorkflow, useToolbarActions } from './boardContext';
import { Toolbar } from '../Toolbar';

const PALETTE = [1, 2, 3, 4, 5].map((c) => conditionStyle(c).colour);
export function processorColour(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

export function StepCard({ data, selected }: NodeProps) {
  const { workflowId, stepId, role } = data as { workflowId: string; stepId: string; role: StepRole };
  const info = useBoardWorkflow(workflowId);
  const far = useStore((s) => s.transform[2] < ZOOM_DETAIL);
  const tb = useToolbarActions();
  if (far || !info) return null;
  const step = info.graph.steps.get(stepId);
  const proc = step?.processorId ? info.graph.processors.get(step.processorId)?.name : undefined;
  return (
    <div className={`node${role === 'parked' ? ' parked' : ''}${role === 'first' ? ' first' : ''}${selected ? ' sel' : ''}`}>
      {selected && tb && (
        <NodeToolbar isVisible position={Position.Top} offset={10}>
          <Toolbar selection={{ kind: 'step' }} actions={{ onDelete: () => tb.deleteStep(workflowId, stepId) }} />
        </NodeToolbar>
      )}
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      {role === 'first' && <span className="tag">FIRST</span>}
      {role === 'parked' && <span className="tag">PARKED</span>}
      <div className="nh">
        <span className="ico" style={{ background: processorColour(proc ?? '') }}>{(proc ?? '?').charAt(0).toUpperCase()}</span>
        <div>
          <div className="sn">{step?.name ?? stepId}</div>
          <div className="sp2">{proc ?? 'no processor'}</div>
        </div>
      </div>
      <div className="nf"><span>{step?.version}</span><span className="health-slot"><HealthDot processorId={step?.processorId ?? null} /></span></div>
    </div>
  );
}
