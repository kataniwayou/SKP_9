import { useContext } from 'react';
import { Handle, NodeToolbar, Position, type NodeProps } from '@xyflow/react';
import type { StepRole } from '../roles';
import { conditionStyle } from '../wires';
import { HealthDot } from '../live/HealthDot';
import { BoardContext, useBoardWorkflow, useToolbarActions } from './boardContext';
import { Toolbar } from '../Toolbar';
import { PickBadge, type PickInfo } from './PickBadge';
import { holders, type EntityKey } from '../../design/shared';
import type { BoardWorkflow } from '../loadBoard';
import type { Id } from '../../model/graph';

// one holders map per board (the context map is rebuilt when the workflows change)
const heldCache = new WeakMap<ReadonlyMap<string, BoardWorkflow>, Map<EntityKey, Id[]>>();
function useSharedCount(stepId: string): number {
  const byId = useContext(BoardContext);
  let held = heldCache.get(byId);
  if (!held) { held = holders([...byId.values()]); heldCache.set(byId, held); }
  return held.get(`step:${stepId}`)?.length ?? 0;
}

const PALETTE = [1, 2, 3, 4, 5].map((c) => conditionStyle(c).colour);
export function processorColour(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

export function StepCard({ data, selected }: NodeProps) {
  const { workflowId, stepId, role, pick } = data as { workflowId: string; stepId: string; role: StepRole; pick?: PickInfo };
  const info = useBoardWorkflow(workflowId);
  const tb = useToolbarActions();
  const sharedIn = useSharedCount(stepId);
  if (!info) return null;
  const step = info.graph.steps.get(stepId);
  const proc = step?.processorId ? info.graph.processors.get(step.processorId)?.name : undefined;
  return (
    <div className={`node${role === 'parked' ? ' parked' : ''}${role === 'first' ? ' first' : ''}${selected ? ' sel' : ''}`}>
      <PickBadge pick={pick} />
      {selected && pick?.solo && tb && (
        <NodeToolbar isVisible position={Position.Top} offset={10}>
          <Toolbar selection={{ kind: 'step' }} actions={{ onCopy: () => tb.copy(workflowId, stepId), onDelete: () => tb.deleteStep(workflowId, stepId) }} />
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
      <div className="nf"><span>{step?.version}{sharedIn > 1 && <span className="shared-tag">{`shared · ${sharedIn}`}</span>}</span><span className="health-slot"><HealthDot processorId={step?.processorId ?? null} /></span></div>
    </div>
  );
}
