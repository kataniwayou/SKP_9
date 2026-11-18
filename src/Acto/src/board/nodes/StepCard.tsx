import { Handle, NodeToolbar, Position, type NodeProps } from '@xyflow/react';
import { conditionStyle } from '../wires';
import { HealthDot } from '../live/HealthDot';
import { ItemToolbar, useHasToolbar } from '../ItemToolbar';
import type { PickInfo, StepChip } from '../toFlow';
import { PickBadge } from './PickBadge';
import { UnsavedMark } from './UnsavedMark';

const PALETTE = [1, 2, 3, 4, 5].map((c) => conditionStyle(c).colour);
export function processorColour(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

/** A step: processor icon, name, processor; the footer is its version, or (with a triangle selected) that workflow's payload. */
export function StepCard({ data, selected }: NodeProps) {
  const { stepId, name, processor, processorId, running = false, chips = [], failed = false, unsaved, pick } = data as {
    stepId: string; name: string; processor: string | null; processorId: string | null; running?: boolean; chips?: StepChip[]; failed?: boolean; unsaved?: boolean; pick?: PickInfo;
  };
  const self = { kind: 'step', id: stepId } as const;
  const toolbar = useHasToolbar(self);
  return (
    <div className={`node${selected ? ' sel' : ''}${running ? ' running' : ''}${failed ? ' failed' : ''}`}>
      <PickBadge pick={pick} />
      <UnsavedMark on={unsaved} />
      {selected && pick?.solo && toolbar && (
        <NodeToolbar isVisible position={Position.Top} offset={10}><ItemToolbar pick={self} /></NodeToolbar>
      )}
      <Handle id="in" type="target" position={Position.Left} />
      <Handle id="out" type="source" position={Position.Right} />
      <div className="nh">
        <span className="ico" style={{ background: processorColour(processor ?? '') }}>{(processor ?? '?').charAt(0).toUpperCase()}</span>
        <div>
          <div className="sn">{name}</div>
          <div className="sp2">{processor ?? 'no processor'}</div>
        </div>
      </div>
      <div className="nf"><span className="mt">{chips.map((c) => <span key={c.hue} className="pay" style={{ color: c.hue, marginRight: 6 }}>{c.text}</span>)}</span><HealthDot processorId={processorId} /></div>
    </div>
  );
}
