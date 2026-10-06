import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { SPHERE_R } from '../../layout/geometry';

export type WorkflowNodeData = { lines: string[]; full: string; cut: boolean };
export type WorkflowNodeType = Node<WorkflowNodeData, 'workflow'>;

const R = SPHERE_R, C = SPHERE_R; // the node box is 2r × 2r, so the centre is (r, r)

/** The workflow as a lit sphere showing only "WORKFLOW" and its name (spec §5.1, mockup drawWorkflow). */
export function WorkflowView({ lines, full, cut }: WorkflowNodeData) {
  const top = C - 6 - (lines.length - 1) * 8;
  return (
    <g className="wf">
      {cut && <title>{full}</title>}
      <ellipse cx={C + 6} cy={C + R + 16} rx={R * 0.95} ry={R * 0.18} fill="url(#wfShadow)" />
      <circle cx={C} cy={C} r={R + 30} fill="url(#wfHalo)" />
      <g className="sphere">
        <circle cx={C} cy={C} r={R} fill="url(#wfBody)" />
        <circle cx={C} cy={C} r={R} fill="url(#wfShade)" />
        <circle cx={C} cy={C} r={R} fill="url(#wfRim)" />
        <ellipse cx={C - R * 0.34} cy={C - R * 0.42} rx={R * 0.36} ry={R * 0.24} fill="url(#wfSpec)" transform={`rotate(-28 ${C - R * 0.34} ${C - R * 0.42})`} />
        <circle cx={C} cy={C} r={R} fill="none" stroke="rgba(125,211,252,.55)" strokeWidth={1} />
      </g>
      <text className="wft" x={C} y={top - 14} textAnchor="middle" fontSize={9.5} letterSpacing={2.5} fill="#BFE6FF">WORKFLOW</text>
      {lines.map((line, k) => (
        <text key={k} className="wft" x={C} y={C - 6 + (k - (lines.length - 1) / 2) * 16 + 8} textAnchor="middle" fontSize={14} fontWeight={600} fill="#F4F9FF">{line}</text>
      ))}
    </g>
  );
}

export function WorkflowNode({ data }: NodeProps<WorkflowNodeType>) {
  return (
    <>
      <svg width={2 * R} height={2 * R} overflow="visible" style={{ display: 'block' }}>
        <WorkflowView {...data} />
      </svg>
      <Handle id="out" type="source" position={Position.Right} isConnectable={false} style={{ top: R }} />
      <Handle id="down" type="source" position={Position.Bottom} isConnectable={false} />
    </>
  );
}
