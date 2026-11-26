import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { ProcessorRow } from '../../design/board';
import type { PickInfo } from '../toFlow';
import { PickBadge } from './PickBadge';

/**
 * A processor no step uses (Schemas mode), React Flow's dark node: `PROCESSOR` with the `no step` tag, its name, then
 * `version · instanceId`. Read-only: no toolbar. Its held schemas' wires leave its bottom (I, O, C).
 */
export function ProcessorCard({ data, selected }: NodeProps) {
  const { row, pick } = data as { row: ProcessorRow; pick?: PickInfo };
  return (
    <div className={`proc-card${selected ? ' sel' : ''}`} title={row.name}>
      <PickBadge pick={pick} />
      <div className="card-k"><span>PROCESSOR</span><span className="schema-tag">no step</span></div>
      <div className="card-t"><span className="card-nm">{row.name}</span></div>
      <div className="card-s">{`${row.version} · ${row.instanceId ?? '—'}`}</div>
      {(['I', 'O', 'C'] as const).map((l, i) => (
        <Handle key={l} id={`ref-${l}`} type="source" position={Position.Bottom} isConnectable={false} className="ref-handle" style={{ left: `${30 + 20 * i}%` }} />
      ))}
    </div>
  );
}
