import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { CAP_H, CHIP, PMID, STEP_H, STEP_W } from '../../layout/geometry';
import type { FittedText } from '../fitText';
import { ChipView, type ProcessorView } from './Chip';
import { Label } from './Label';

export type { ProcessorView } from './Chip';

export type StepNodeData = {
  name: FittedText;
  version: FittedText;
  parked: boolean;
  letter: string;
  colour: string;
  /** `◆ 3 keys`, `◇ {}`, or null when the step has no assignment in this workflow. */
  assignment: string | null;
  fanIn: number;
  /** Step-local heights where wires land (left edge) and leave (right edge). */
  ins: number[];
  outs: number[];
  processor: ProcessorView;
};
export type StepNodeType = Node<StepNodeData, 'step'>;

const W = STEP_W, H = STEP_H;

/** A step: a dark body under a glossy title cap, with its processor drawn inside (mockup drawStep). */
export function StepView(d: StepNodeData) {
  const ins = d.ins.length > 0 ? d.ins : [PMID];
  const outs = d.outs.length > 0 ? d.outs : [PMID];
  const versionX = d.parked ? 60 : 44;

  return (
    <g className={d.parked ? 'blk parked' : 'blk'}>
      <rect className="contact" x={5} y={9} width={W} height={H} rx={9} />
      <rect className="shell" width={W} height={H} rx={8} />
      <path className="cap" d={`M0 8 a8 8 0 0 1 8 -8 H${W - 8} a8 8 0 0 1 8 8 V${CAP_H} H0Z`} />
      <ellipse cx={56} cy={8} rx={62} ry={9} fill="url(#glint)" opacity={0.55} />
      <path d={`M0 ${CAP_H} H${W}`} stroke="rgba(160,215,255,.5)" />
      <rect className="rimr" x={0.6} y={0.6} width={W - 1.2} height={H - 1.2} rx={7.5} />
      <Label className="name" x={12} y={19} fitted={d.name} />
      <text className="kind" x={12} y={33}>{d.parked ? 'PARKED' : 'STEP'}</text>
      <Label className="ver" x={versionX} y={33} fitted={d.version} />
      <rect x={W - 24} y={8} width={14} height={13} rx={2} fill={d.colour} stroke="rgba(3,12,28,.35)" />
      <text className="badge" x={W - 17} y={18} textAnchor="middle" fill="#04111F" fontWeight={600}>{d.letter}</text>
      {d.assignment && <text className="badge asg" x={W - 11} y={33} textAnchor="end">{d.assignment}</text>}
      {d.fanIn > 1 && (
        <>
          <rect x={W - 70} y={-9} width={58} height={16} rx={8} fill="var(--panel)" stroke="var(--line-2)" />
          <text className="badge" x={W - 41} y={2.5} textAnchor="middle" fill="var(--muted)">{`fan-in ×${d.fanIn}`}</text>
        </>
      )}
      <path className="trace" d={`${ins.map((y) => `M0 ${y} H${CHIP.x}`).join(' ')} ${outs.map((y) => `M${CHIP.x + CHIP.w} ${y} H${W}`).join(' ')}`} />
      <ChipView p={d.processor} ins={ins.map((y) => y - CHIP.y)} outs={outs.map((y) => y - CHIP.y)} />
    </g>
  );
}

export function StepNode({ data }: NodeProps<StepNodeType>) {
  return (
    <>
      <Handle id="in" type="target" position={Position.Left} isConnectable={false} style={{ top: PMID }} />
      <svg width={W} height={H} overflow="visible" style={{ display: 'block' }}>
        <StepView {...data} />
      </svg>
      <Handle id="out" type="source" position={Position.Right} isConnectable={false} style={{ top: PMID }} />
    </>
  );
}
