import { Handle, NodeToolbar, Position, type NodeProps } from '@xyflow/react';
import { conditionStyle } from '../wires';
import { HealthDot } from '../live/HealthDot';
import { ItemToolbar, useHasToolbar } from '../ItemToolbar';
import type { Pick } from '../selection';
import type { PickInfo, StepChip } from '../toFlow';
import { PickBadge } from './PickBadge';
import { UnsavedMark } from './UnsavedMark';

const PALETTE = [1, 2, 3, 4, 5].map((c) => conditionStyle(c).colour);
export function processorColour(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

/**
 * A step, React Flow UI's BaseNode look: a header row (processor square, processor name, entry-condition pill, health dot)
 * over a border, the step's name as the body. Key chips of the selected workflows hang under the card; a running
 * workflow reaching it draws the green ring.
 */
export function StepCard({ data, selected }: NodeProps) {
  const { stepId, name, processor, processorId, condition = 1, running = false, chips = [], ghost = false, ghostKey, failed = false, unsaved, pick } = data as {
    stepId: string; name: string; processor: string | null; processorId: string | null; condition?: number; running?: boolean; chips?: StepChip[];
    ghost?: boolean; ghostKey?: string; failed?: boolean; unsaved?: boolean; pick?: PickInfo;
  };
  const self: Pick = ghostKey ? { kind: 'ghost', key: ghostKey } : { kind: 'step', id: stepId };
  const toolbar = useHasToolbar(self);
  const cond = conditionStyle(condition);
  return (
    <div className={`node${selected ? ' sel' : ''}${running ? ' running' : ''}${failed ? ' failed' : ''}${ghost ? ' ghost' : ''}`}>
      <PickBadge pick={pick} />
      <UnsavedMark on={unsaved} />
      {selected && pick?.solo && toolbar && (
        <NodeToolbar isVisible position={Position.Top} offset={10}><ItemToolbar pick={self} /></NodeToolbar>
      )}
      <Handle id="in" type="target" position={Position.Left} />
      <Handle id="out" type="source" position={Position.Right} />
      <div className="bn-header">
        <span className="ico" style={{ background: processorColour(processor ?? '') }}>{(processor ?? '?').charAt(0).toUpperCase()}</span>
        <span className="sp2">{processor ?? 'no processor'}</span>
        <span className="cond-pill" style={{ background: cond.colour }} title={cond.name}>{cond.letter}</span>
        {!ghost && <HealthDot processorId={processorId} />}
      </div>
      <div className="bn-body"><span className="sn">{name}</span></div>
      {ghost && <span className="ghost-tag">deleted · ghost</span>}
      {chips.length > 0 && (
        <div className="key-chips">
          {chips.map((c, i) => <span key={`${i}:${c.text}`} className="key-chip" style={{ borderColor: c.hue }} title={c.text}>{c.text}</span>)}
        </div>
      )}
    </div>
  );
}
