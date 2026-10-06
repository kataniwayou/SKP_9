import { useId } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { SPHERE_R } from '../../layout/geometry';
import type { FittedText } from '../fitText';
import { useLiveArt } from '../liveArt';
import { Tip } from './Label';
import { closingDash } from './nxShapes';

export type WorkflowNodeData = {
  /** The workflow's unique name (spec §7): the dial's tooltip. */
  tip: string;
  /** `⏱ <cron>` fitted to the pill beside the state. */
  cron: FittedText;
};
export type WorkflowNodeType = Node<WorkflowNodeData, 'workflow'>;

const R = SPHERE_R, C = SPHERE_R; // the node box is 2r × 2r, so the centre is (r, r)
const SPINNER = closingDash(R - 9, [44, 14, 8, 14]);
const TICKS = `1.5 ${(2 * Math.PI * R / 48 - 1.5).toFixed(2)}`;
/** The pill (gallery wfPill, 200 wide at its r 80 hub, × 1.2): centred under the dial. */
export const PILL_W = 240;
const STARTED = '  ● started', NOT_STARTED = '  ○ not started';

/**
 * The workflow as the hub dial (spec §5.1; mockup v50 drawWorkflow, gallery hubDial). The two outer
 * rings are static and white. Inside them the state: started is green with the segment ring turning;
 * not started is grey, still and blinking slowly. The dial says only WORKFLOW; the pill under it
 * carries the cron and the state and never blinks.
 */
export function WorkflowView({ tip, cron, started }: WorkflowNodeData & { started: boolean }) {
  const core = `nxcore${useId().replace(/[^\w-]/g, '')}`;
  const pillX = C - PILL_W / 2, pillY = C + R + 14;
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
      <text className="nx-wl" x={C} y={C + 4} textAnchor="middle">WORKFLOW</text>
      <g className="nx-pill">
        <rect className="nx-bd" x={pillX} y={pillY} width={PILL_W} height={18} rx={9} />
        <rect className="nx-ln" x={pillX} y={pillY} width={PILL_W} height={18} rx={9} />
        <Tip full={cron.full} cut={cron.cut}>
          <text className="nx-state" x={pillX + 12} y={pillY + 12.5}>{cron.text}<tspan>{started ? STARTED : NOT_STARTED}</tspan></text>
        </Tip>
      </g>
    </g>
  );
}

/** The longest state text, for the room left to the cron on the pill. */
export const PILL_STATE = NOT_STARTED;

export function WorkflowNode({ data }: NodeProps<WorkflowNodeType>) {
  const { started } = useLiveArt();
  return (
    <>
      <svg width={2 * R} height={2 * R} overflow="visible" style={{ display: 'block' }}>
        <WorkflowView {...data} started={started} />
      </svg>
      <Handle id="out" type="source" position={Position.Right} isConnectable={false} style={{ top: R }} />
      <Handle id="down" type="source" position={Position.Bottom} isConnectable={false} />
    </>
  );
}
