import { Handle, NodeToolbar, Position, type NodeProps } from '@xyflow/react';
import type { LiveStatus } from '../../api/liveStatus';
import { TRI_SHAPE_H, TRI_SHAPE_W } from '../geometry';
import { ItemToolbar, useHasToolbar } from '../ItemToolbar';
import type { PickInfo } from '../toFlow';
import { PickBadge } from './PickBadge';
import { UnsavedMark } from './UnsavedMark';

const HANDLE = 10;
const TONE: Record<LiveStatus, 'on' | 'off' | 'wait'> = { running: 'on', stopped: 'off', checking: 'wait', unknown: 'wait' };
const LABEL: Record<LiveStatus, string> = { running: '● running', stopped: '■ stopped', checking: 'checking…', unknown: 'checking…' };

/**
 * A workflow: a triangle, tip to the right, with its name and run state under it. Stopped (S1) is slate with a ■ inside and
 * a "■ stopped" pill; running is a green ▶ inside a spinning dashed green ring, with "● running". Solid arrows leave only
 * from the tip (handle `tip`); dashed lines to its caches leave from the back (handle `back`). A problem badge counts the
 * last dry run's problems; a failure outline marks a Save BaseAPI refused on it.
 */
export function TriangleNode({ data, selected }: NodeProps) {
  const { workflowId, name, status, hue, problems = 0, ghost = false, failed = false, unsaved, pick } = data as {
    workflowId: string; name: string; status: LiveStatus; hue: string | null; problems?: number; ghost?: boolean; failed?: boolean; unsaved?: boolean; pick?: PickInfo;
  };
  const tone = TONE[status];
  const run = status === 'running';
  const on = selected || hue !== null;
  const self = { kind: 'workflow', id: workflowId } as const;
  const toolbar = useHasToolbar(self);
  const W = TRI_SHAPE_W;
  const H = TRI_SHAPE_H;
  const mid = H / 2;
  return (
    <div className={`tri ${run ? 'running' : 'stopped'}${on ? ' sel' : ''}${failed ? ' failed' : ''}${ghost ? ' ghost' : ''}`} data-workflow={workflowId}>
      <PickBadge pick={pick} />
      <UnsavedMark on={unsaved} />
      {problems > 0 && <span className="tri-problems" title={`${problems} problem${problems === 1 ? '' : 's'} in the last dry run`}>{problems}</span>}
      {selected && pick?.solo && toolbar && (
        <NodeToolbar isVisible position={Position.Top} offset={10}><ItemToolbar pick={self} /></NodeToolbar>
      )}
      <svg className="tri-shape" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
        {on && <polygon className="tri-halo" points={`0,0 ${W},${mid} 0,${H}`} style={hue !== null ? { fill: `color-mix(in srgb, ${hue} 16%, transparent)` } : undefined} />}
        {run && <polygon className="tri-ring" points={`-4,-8 ${W + 6},${mid} -4,${H + 8}`} />}
        <polygon className="tri-body" points={`3,4 ${W - 5},${mid} 3,${H - 4}`} style={hue !== null ? { stroke: hue } : undefined} />
        {run
          ? <path className="tri-play" d={`M22 ${mid - 8} l12 8 l-12 8z`} />
          : <rect className="tri-stop" x={20} y={mid - 6} width={12} height={12} rx={2} />}
      </svg>
      <Handle id="tip" type="source" position={Position.Right}
        style={{ left: W - HANDLE, top: mid - HANDLE / 2, right: 'auto', transform: 'none' }} />
      <Handle id="back" type="source" position={Position.Left}
        style={{ left: 0, top: mid - HANDLE / 2, transform: 'none' }} />
      <div className="tri-nm" title={name}>{name}</div>
      <div className={`tri-st ${tone}`} data-status={status}>{LABEL[status]}</div>
      {ghost && <div className="ghost-tag">deleted · ghost</div>}
    </div>
  );
}
