import { Fragment, useContext } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { Health } from '../../api/liveness';
import { DesignContext } from '../../design/DesignContext';
import { CHIP, PMID, STEP_H, STEP_W } from '../../layout/geometry';
import type { FittedText } from '../fitText';
import { useLiveArt } from '../liveArt';
import { ChipView, type ProcessorView } from './Chip';
import { Label } from './Label';
import { STEP_CAP, STEP_FRAME, STEP_FRAME_IN, STEP_GLOSS } from './nxShapes';

export type { ProcessorView } from './Chip';

export type StepNodeData = {
  name: FittedText;
  version: FittedText;
  parked: boolean;
  letter: string;
  colour: string;
  /** `◆ 3 keys`, `◇ {}`, or null when the step has no assignment in this workflow. */
  assignment: string | null;
  /** The step's tooltip (unique name, entry condition, assignment, parked); the processor panel has its own. */
  tip: string;
  fanIn: number;
  /** Step-local heights where wires land (left edge) and leave (right edge). */
  ins: number[];
  outs: number[];
  processor: ProcessorView;
};
export type StepNodeType = Node<StepNodeData, 'step'>;

const W = STEP_W, H = STEP_H;

/** Where a wire meets the frame (gallery socket): a dark ring with a dot, lit when that side has a schema. */
function Socket({ x, y, lit }: { x: number; y: number; lit: boolean }) {
  return (
    <g className="nx-socket">
      <circle className="nx-nd" cx={x} cy={y} r={3.2} />
      <circle className={lit ? 'nx-fh' : 'nx-fh nx-d2'} cx={x} cy={y} r={1.4} />
    </g>
  );
}

/**
 * A step in the notched HUD frame (spec §5.1; mockup v50 drawStep). The glossy cap carries what is the
 * step's: name, `STEP vX`, the entry-condition pill and the assignment keys. Its processor panel sits
 * inside, and traces run from the frame edge to the panel at every landing and departure.
 */
export function StepView({ health, ...d }: StepNodeData & { health: Health }) {
  const ins = d.ins.length > 0 ? d.ins : [PMID];
  const outs = d.outs.length > 0 ? d.outs : [PMID];
  const versionX = d.parked ? 56 : 42;
  const p = d.processor;

  return (
    <g className={d.parked ? 'blk nx parked' : 'blk nx'}>
      <title>{d.tip}</title>
      <path className="nx-bd" d={STEP_FRAME} />
      <g className="nx-g"><path className="nx-hl nx-frame" d={STEP_FRAME} /></g>
      <path className="nx-ln nx-d2" d={STEP_FRAME_IN} />
      {[0, 1, 2, 3, 4].map((i) => <path key={`t${i}`} className="nx-fc nx-g" d={`M${92 + i * 9} 0.5h6l-2 3h-6z`} />)}
      {[0, 1, 2, 3].map((i) => (
        <Fragment key={`s${i}`}>
          <path className="nx-fc nx-d1" d={`M2 ${26 + i * 7}l3-2v4l-3 2z`} />
          <rect className="nx-fc nx-d1" x={219} y={24 + i * 7} width={3} height={3} />
        </Fragment>
      ))}
      {[0, 1, 2, 3, 4].map((i) => <rect key={`b${i}`} className="nx-fc" x={96 + i * 7} y={155.5} width={3} height={3} />)}
      <path d={STEP_CAP} fill="url(#nxCap)" />
      <path d={STEP_GLOSS} fill="#fff" opacity={0.22} />
      <path className="nx-hl nx-d1" d="M4 40H220" />
      <Label className="nx-sn" x={12} y={24} fitted={d.name} />
      <text className="nx-sk" x={12} y={36}>{d.parked ? 'PARKED' : 'STEP'}</text>
      <Label className="nx-skv" x={versionX} y={36} fitted={d.version} />
      <rect x={W - 26} y={10} width={14} height={13} rx={2} fill={d.colour} stroke="rgba(3,12,28,.4)" />
      <text className="badge" x={W - 19} y={20} textAnchor="middle" fill="#04111F" fontWeight={600}>{d.letter}</text>
      {d.assignment && <text className="badge nx-asg" x={W - 12} y={36} textAnchor="end">{d.assignment}</text>}
      {d.fanIn > 1 && (
        <>
          <rect x={W - 70} y={-9} width={58} height={16} rx={8} fill="var(--panel)" stroke="var(--line-2)" />
          <text className="badge" x={W - 41} y={2.5} textAnchor="middle" fill="var(--muted)">{`fan-in ×${d.fanIn}`}</text>
        </>
      )}
      {ins.map((y, i) => <path key={`ti${i}`} className={p.inputLit ? 'nx-ln' : 'nx-ln nx-d3'} d={`M0 ${y}H${CHIP.x}`} />)}
      {outs.map((y, i) => <path key={`to${i}`} className={p.outputLit ? 'nx-ln' : 'nx-ln nx-d3'} d={`M${CHIP.x + CHIP.w} ${y}H${W}`} />)}
      {ins.map((y, i) => <Socket key={`si${i}`} x={0} y={y} lit={p.inputLit} />)}
      {outs.map((y, i) => <Socket key={`so${i}`} x={W} y={y} lit={p.outputLit} />)}
      <ChipView p={p} health={health} ins={ins.map((y) => y - CHIP.y)} outs={outs.map((y) => y - CHIP.y)} />
    </g>
  );
}

/** Where a new wire is drawn from (spec §4.5): the step's output side, at its processor middle; design mode only. */
const PORT = { left: W - 6, top: PMID - 6 } as const;

export function StepNode({ id, data }: NodeProps<StepNodeType>) {
  const { health } = useLiveArt();
  const gestures = useContext(DesignContext);
  return (
    <>
      <Handle id="in" type="target" position={Position.Left} isConnectable={false} style={{ top: PMID }} />
      <svg width={W} height={H} overflow="visible" style={{ display: 'block' }}>
        <StepView {...data} health={health(data.processor.processorId)} />
      </svg>
      <Handle id="out" type="source" position={Position.Right} isConnectable={false} style={{ top: PMID }} />
      {gestures && <div className="nx-port nodrag nopan" style={PORT} onPointerDown={(e) => gestures.portPointerDown(id, e)} />}
    </>
  );
}
