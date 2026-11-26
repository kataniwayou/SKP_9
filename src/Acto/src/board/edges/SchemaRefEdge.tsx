import { getBezierPath, type EdgeProps } from '@xyflow/react';
import type { Slot } from '../../design/board';
import { SLOT_LETTER } from '../toFlow';

/**
 * A reference wire (edge type `schemaRef`), drawn from the data and never picked: a dotted bezier, no arrowhead, a dot
 * at the schema's end and the slot's letter (I, O, C) in a pill midway. Thicker while its schema card is hovered.
 */
export function SchemaRefEdge({ data, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition }: EdgeProps) {
  const { slot, lit = false } = data as { slot: Slot; lit?: boolean };
  const [d, mx, my] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  return (
    <g className={`schema-ref${lit ? ' lit' : ''}`} data-slot={slot}>
      <path className="schema-ref-line" d={d} fill="none" strokeDasharray="1 4" strokeLinecap="round" strokeWidth={lit ? 2.6 : 1.8} />
      <circle className="schema-ref-end" cx={targetX} cy={targetY} r={3.5} />
      <circle className="schema-ref-pill" cx={mx} cy={my} r={8} strokeWidth={1.2} />
      <text className="schema-ref-slot" x={mx} y={my + 3.5} textAnchor="middle">{SLOT_LETTER[slot]}</text>
    </g>
  );
}
