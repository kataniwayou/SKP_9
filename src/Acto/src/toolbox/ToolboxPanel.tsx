import type { Processor } from '../model/graph';
import { HealthDot } from '../board/live/HealthDot';
import { useProcessorLive } from '../live/LiveContext';
import { livenessText } from '../live/liveState';

function ProcessorItem({ processor }: { processor: Processor }) {
  const { known, processor: live } = useProcessorLive(processor.id);
  return (
    <div className="tb-item" data-testid="toolbox-step">
      <span className="tb-ico" aria-hidden="true">{processor.name.slice(0, 1).toUpperCase()}</span>
      <span className="tb-text">
        <span className="tb-name">{processor.name}</span>
        <span className="tb-sub">{livenessText(known, live)}</span>
      </span>
      <HealthDot processorId={processor.id} />
    </div>
  );
}

export function ToolboxPanel({ processors }: { processors: Processor[] }) {
  return (
    <>
      <div className="ph"><span>Toolbox</span></div>
      <div className="pb">
        <div className="tb-sec">Create</div>
        <button type="button" className="tb-item tb-create" disabled>
          <span className="tb-ico" aria-hidden="true">W</span>
          <span className="tb-text"><span className="tb-name">Workflow</span><span className="tb-sub">drop anywhere on the board</span></span>
        </button>
        <div className="tb-sec">Steps</div>
        {processors.map((p) => <ProcessorItem key={p.id} processor={p} />)}
      </div>
    </>
  );
}
