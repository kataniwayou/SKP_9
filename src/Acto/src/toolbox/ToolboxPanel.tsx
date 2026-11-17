import type { DragEvent } from 'react';
import type { Cache, Processor } from '../model/graph';
import type { DropItem } from '../board/dropTarget';
import { HealthDot } from '../board/live/HealthDot';
import { processorColour } from '../board/nodes/StepCard';
import { useProcessorLive } from '../live/LiveContext';
import { livenessText } from '../live/liveState';

const dragOf = (item: DropItem) => (e: DragEvent) => {
  e.dataTransfer.setData('application/acto', JSON.stringify(item));
  e.dataTransfer.effectAllowed = 'copy';
};

/** The cache chip's colour, as the icon of a cache item. */
const CACHE_TONE = '#B8A36A';
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

/** The mock's toolbox: Create, Steps (one per processor, with its live health) and Caches; every item is dragged. */
export function ToolboxPanel({ processors, caches = [] }: { processors: Processor[]; caches?: Cache[] }) {
  return (
    <>
      <h2>Create</h2>
      <button type="button" className="tool big" draggable onDragStart={dragOf({ kind: 'workflow' })}>
        <span className="ti" aria-hidden="true" style={{ background: ACCENT }}>W</span>
        <span className="tx">Workflow<small>drop on empty board</small></span>
      </button>
      <button type="button" className="tool big" draggable onDragStart={dragOf({ kind: 'cache-new' })}>
        <span className="ti" aria-hidden="true" style={{ background: CACHE_TONE }}>C</span>
        <span className="tx">Cache<small>drop inside a workflow</small></span>
      </button>
      <h2>Steps</h2>
      {processors.map((p) => <ProcessorItem key={p.id} processor={p} />)}
      <h2>Caches</h2>
      {caches.map((c) => (
        <div key={c.id} className="tool" data-testid="toolbox-cache" draggable onDragStart={dragOf({ kind: 'cache', cacheId: c.id })}>
          <span className="ti" aria-hidden="true" style={{ background: CACHE_TONE }}>C</span>
          <span className="tx">{c.name}<small className="lv">{c.version}</small></span>
        </div>
      ))}
    </>
  );
}
