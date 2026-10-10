import { useContext, useId } from 'react';
import type { LiveStatus } from '../../api/liveStatus';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { DesignContext } from '../../design/DesignContext';
import { SPHERE_R } from '../../layout/geometry';
import { WORKFLOW_SOURCE } from '../../layout/ports';
import { useLiveArt } from '../liveArt';
import { closingDash } from './nxShapes';

export type WorkflowNodeData = {
  /** The workflow's unique name (spec §7): the dial's tooltip. */
  tip: string;
};
export type WorkflowNodeType = Node<WorkflowNodeData, 'workflow'>;

const R = SPHERE_R, C = SPHERE_R; // the node box is 2r × 2r, so the centre is (r, r)
const SPINNER = closingDash(R - 9, [44, 14, 8, 14]);
const TICKS = `1.5 ${(2 * Math.PI * R / 48 - 1.5).toFixed(2)}`;
/** The state written inside the dial, under WORKFLOW, for each run status. Only a verdict says started or not started. */
const STATES: Record<LiveStatus, string> = {
  running: '● started',
  stopped: '○ not started',
  unknown: '? status unknown',
  checking: 'checking…',
};

/**
 * The workflow as the hub dial (spec §5.1; mockup v50 drawWorkflow, gallery hubDial). The two outer
 * rings are static and white. Inside them the state: started is green with the segment ring turning;
 * not started is grey, still and blinking slowly. Nothing is written outside the dial, whose outer ring is for the
 * wires' contact points (the user's rule, 2026-10-10): inside it WORKFLOW, and under it the state, which never
 * blinks. An unknown or unchecked status has not started's look, but its state says so rather than "not started".
 * The state's colour (2026-10-10): started healthy green, not started undetermined grey, unknown warn amber,
 * checking muted.
 */
export function WorkflowView({ tip, started, status }: WorkflowNodeData & { started: boolean; status: LiveStatus }) {
  const core = `nxcore${useId().replace(/[^\w-]/g, '')}`;
  return (
    <g className={started ? 'wf nx started' : 'wf nx nx-idlewf'} data-started={String(started)}>
      <title>{tip}</title>
      <g className="sphere">
        <circle className="nx-fc nx-glow" cx={C} cy={C} r={R + 28} />
        <g className="nx hub-outer">
          <g className="nx-g"><circle className="nx-hl nx-ticks" cx={C} cy={C} r={R} style={{ strokeDasharray: TICKS }} /></g>
          <g className="nx-g"><circle className="nx-hl nx-rim" cx={C} cy={C} r={R + 6} /></g>
        </g>
        <g className="hub-inner">
          <circle className="nx-hl nx-spin nx-hub-spinner" cx={C} cy={C} r={R - 9} style={{ strokeDasharray: SPINNER }} />
          <radialGradient id={core}>
            <stop offset="0" style={{ stopColor: 'var(--nc)', stopOpacity: 0.3 }} />
            <stop offset="1" style={{ stopColor: 'var(--nc)', stopOpacity: 0.05 }} />
          </radialGradient>
          <circle className="nx-bd" cx={C} cy={C} r={R - 22} />
          <circle className="nx-core-glow" cx={C} cy={C} r={R - 22} fill={`url(#${core})`} />
          <g className="nx-g"><circle className="nx-ln nx-core-dots" cx={C} cy={C} r={R - 22} /></g>
        </g>
      </g>
      <text className="nx-wl" x={C} y={C - 2} textAnchor="middle">WORKFLOW</text>
      <text className={`nx-state st-${status}`} data-status={status} x={C} y={C + 16} textAnchor="middle"><tspan>{STATES[status]}</tspan></text>
    </g>
  );
}

export function WorkflowNode({ data }: NodeProps<WorkflowNodeType>) {
  const { started, status } = useLiveArt();
  const gestures = useContext(DesignContext);
  return (
    <>
      <svg width={2 * R} height={2 * R} overflow="visible" style={{ display: 'block' }}>
        <WorkflowView {...data} started={started} status={status} />
      </svg>
      <Handle id="out" type="source" position={Position.Right} isConnectable={false} style={{ top: R }} />
      <Handle id="down" type="source" position={Position.Bottom} isConnectable={false} />
      {/* a wire on no terminal hangs on the hub's ring: React Flow needs a target handle to draw it (plan 9) */}
      <Handle id="ring" type="target" position={Position.Right} isConnectable={false} style={{ top: R }} />
      {/* where entry wires are drawn from (spec §4.5): the dial's right side at its centre height; design mode only */}
      {gestures && <div className="nx-port nodrag nopan" style={{ left: 2 * R, top: R }} onPointerDown={(e) => gestures.portPointerDown(WORKFLOW_SOURCE, e)} />}
    </>
  );
}
