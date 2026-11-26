import { Handle, NodeToolbar, Position, type NodeProps } from '@xyflow/react';
import type { SchemaRow } from '../../design/board';
import type { SchemaState } from '../../design/schemaStates';
import { ItemToolbar, useHasToolbar } from '../ItemToolbar';
import type { Pick } from '../selection';
import type { PickInfo } from '../toFlow';
import { PickBadge } from './PickBadge';

/**
 * A schema card (Schemas mode): a small mono `SCHEMA` label with its tag at the right (`held`, or `orphan` in red; a
 * wired schema has none), then the bold name and the version in mono. Reference wires arrive at its top handle `ref`.
 */
export function SchemaCard({ data, selected }: NodeProps) {
  const { row, state, ghost = false, ghostKey, pick } = data as { row: SchemaRow; state: SchemaState; ghost?: boolean; ghostKey?: string; pick?: PickInfo };
  const self: Pick = ghostKey ? { kind: 'ghost', key: ghostKey } : { kind: 'schema', id: row.id };
  const toolbar = useHasToolbar(self);
  return (
    <div className={`schema-card${selected ? ' sel' : ''}${ghost ? ' ghost' : ''}`} title={`${row.name} ${row.version}`}>
      <PickBadge pick={pick} />
      {selected && pick?.solo && toolbar && (
        <NodeToolbar isVisible position={Position.Top} offset={10}><ItemToolbar pick={self} /></NodeToolbar>
      )}
      <Handle id="ref" type="target" position={Position.Top} isConnectable={false} className="ref-handle" />
      <div className="card-k">
        <span>SCHEMA</span>
        {!ghost && state !== 'wired' && <span className={`schema-tag ${state}`}>{state}</span>}
      </div>
      <div className="card-t"><span className="card-nm">{row.name}</span><small>{row.version}</small></div>
      {ghost && <span className="ghost-tag">deleted · ghost</span>}
    </div>
  );
}
