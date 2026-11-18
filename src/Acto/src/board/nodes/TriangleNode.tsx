import { Handle, NodeToolbar, Position, type NodeProps } from '@xyflow/react';
import type { LiveStatus } from '../../api/liveStatus';
import { TRI_SHAPE_H, TRI_SHAPE_W } from '../geometry';
import { ItemToolbar, useHasToolbar } from '../ItemToolbar';
import type { PickInfo } from '../toFlow';
import { PickBadge } from './PickBadge';

const HANDLE = 10;
const TONE: Record<LiveStatus, 'on' | 'off' | 'wait'> = { running: 'on', stopped: 'off', checking: 'wait', unknown: 'wait' };
const LABEL: Record<LiveStatus, string> = { running: 'Running', stopped: 'Stopped', checking: 'Checking…', unknown: 'Unknown' };

/**
 * A workflow: a white triangle, tip to the right, with its run dot inside and its name and state under it. Solid arrows leave
 * only from the tip (handle `tip`); dashed lines to its caches leave from the back (handle `back`).
 */
export function TriangleNode({ data, selected }: NodeProps) {
  const { workflowId, name, status, lit, pick } = data as { workflowId: string; name: string; status: LiveStatus; lit: boolean; pick?: PickInfo };
  const tone = TONE[status];
  const on = selected || lit;
  const self = { kind: 'workflow', id: workflowId } as const;
  const toolbar = useHasToolbar(self);
  const mid = TRI_SHAPE_H / 2;
  return (
    <div className={`tri${on ? ' sel' : ''}`} data-workflow={workflowId}>
      <PickBadge pick={pick} />
      {selected && pick?.solo && toolbar && (
        <NodeToolbar isVisible position={Position.Top} offset={10}><ItemToolbar pick={self} /></NodeToolbar>
      )}
      <svg className="tri-shape" width={TRI_SHAPE_W} height={TRI_SHAPE_H} viewBox={`0 0 ${TRI_SHAPE_W} ${TRI_SHAPE_H}`} aria-hidden="true">
        {on && <polygon className="tri-halo" points={`0,0 ${TRI_SHAPE_W},${mid} 0,${TRI_SHAPE_H}`} />}
        <polygon className="tri-body" points={`3,4 ${TRI_SHAPE_W - 5},${mid} 3,${TRI_SHAPE_H - 4}`} />
        <circle className={`tri-dot ${tone}`} cx={26} cy={mid} r={6} />
      </svg>
      <Handle id="tip" type="source" position={Position.Right}
        style={{ left: TRI_SHAPE_W - HANDLE, top: mid - HANDLE / 2, right: 'auto', transform: 'none' }} />
      <Handle id="back" type="source" position={Position.Left}
        style={{ left: 0, top: mid - HANDLE / 2, transform: 'none' }} />
      <div className="tri-nm" title={name}>{name}</div>
      <div className={`tri-st ${tone}`} data-status={status}>{LABEL[status]}</div>
    </div>
  );
}
