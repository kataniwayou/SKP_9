import type { DragEvent } from 'react';
import type { Processor } from '../model/graph';
import { HealthDot } from '../board/live/HealthDot';
import { processorColour } from '../board/nodes/StepCard';
import { CACHE_TONE } from '../board/nodes/CacheNode';
import { useProcessorLive } from '../live/LiveContext';
import { livenessText } from '../live/liveState';
import { DRAG_TYPE, type ToolboxDrag } from './drag';

const dragOf = (item: ToolboxDrag) => (e: DragEvent) => {
  e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(item));
  e.dataTransfer.effectAllowed = 'copy';
};

const ACCENT = 'var(--accent)';

function ProcessorItem({ processor }: { processor: Processor }) {
  const { known, processor: live } = useProcessorLive(processor.id);
  return (
    <div className="tool" data-testid="toolbox-step" draggable onDragStart={dragOf({ kind: 'step', processorId: processor.id })}>
      <span className="ti" aria-hidden="true" style={{ background: processorColour(processor.name) }}>{processor.name.slice(0, 1).toUpperCase()}</span>
      <span className="tx">{processor.name}<small className="lv">{livenessText(known, live)}</small></span>
      <HealthDot processorId={processor.id} />
    </div>
  );
}

/** The toolbox (spec §7): Create › Workflow and Cache, and Steps (one per processor, with its live health); each dropped anywhere on the board. */
export function ToolboxPanel({ processors }: { processors: Processor[] }) {
  return (
    <>
      <h2>Create</h2>
      <button type="button" className="tool big" draggable onDragStart={dragOf({ kind: 'workflow' })}>
        <span className="ti" aria-hidden="true" style={{ background: ACCENT }}>W</span>
        <span className="tx">Workflow<small>drop on the board</small></span>
      </button>
      <button type="button" className="tool big" draggable onDragStart={dragOf({ kind: 'cache' })}>
        <span className="ti" aria-hidden="true" style={{ background: CACHE_TONE }}>C</span>
        <span className="tx">Cache<small>drop on the board</small></span>
      </button>
      <h2>Steps</h2>
      {processors.map((p) => <ProcessorItem key={p.id} processor={p} />)}
    </>
  );
}
