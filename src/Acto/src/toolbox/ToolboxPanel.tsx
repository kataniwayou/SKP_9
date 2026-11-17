import type { DragEvent } from 'react';
import type { Cache, Processor } from '../model/graph';
import type { DropItem } from '../board/dropTarget';
import { HealthDot } from '../board/live/HealthDot';
import { useProcessorLive } from '../live/LiveContext';
import { livenessText } from '../live/liveState';

const dragOf = (item: DropItem) => (e: DragEvent) => {
  e.dataTransfer.setData('application/acto', JSON.stringify(item));
  e.dataTransfer.effectAllowed = 'copy';
};

function ProcessorItem({ processor }: { processor: Processor }) {
  const { known, processor: live } = useProcessorLive(processor.id);
  return (
    <div className="tb-item" data-testid="toolbox-step" draggable onDragStart={dragOf({ kind: 'step', processorId: processor.id })}>
      <span className="tb-ico" aria-hidden="true">{processor.name.slice(0, 1).toUpperCase()}</span>
      <span className="tb-text">
        <span className="tb-name">{processor.name}</span>
        <span className="tb-sub">{livenessText(known, live)}</span>
      </span>
      <HealthDot processorId={processor.id} />
    </div>
  );
}

export function ToolboxPanel({ processors, caches = [] }: { processors: Processor[]; caches?: Cache[] }) {
  return (
    <>
      <div className="ph"><span>Toolbox</span></div>
      <div className="pb">
        <div className="tb-sec">Create</div>
        <button type="button" className="tb-item tb-create" draggable onDragStart={dragOf({ kind: 'workflow' })}>
          <span className="tb-ico" aria-hidden="true">W</span>
          <span className="tb-text"><span className="tb-name">Workflow</span><span className="tb-sub">drop on empty board</span></span>
        </button>
        <button type="button" className="tb-item tb-create" draggable onDragStart={dragOf({ kind: 'cache-new' })}>
          <span className="tb-ico" aria-hidden="true">C</span>
          <span className="tb-text"><span className="tb-name">Cache</span><span className="tb-sub">drop inside a workflow</span></span>
        </button>
        <div className="tb-sec">Steps</div>
        {processors.map((p) => <ProcessorItem key={p.id} processor={p} />)}
        <div className="tb-sec">Caches</div>
        {caches.map((c) => (
          <div key={c.id} className="tb-item" data-testid="toolbox-cache" draggable onDragStart={dragOf({ kind: 'cache', cacheId: c.id })}>
            <span className="tb-ico" aria-hidden="true">C</span>
            <span className="tb-text"><span className="tb-name">{c.name}</span><span className="tb-sub">{c.version}</span></span>
          </div>
        ))}
      </div>
    </>
  );
}
