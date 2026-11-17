import type { ReactNode } from 'react';
import type { BoardWorkflow } from '../board/loadBoard';
import type { Selection } from '../board/selection';
import { useLive, useLiveStore, useProcessorLive } from '../live/LiveContext';
import { livenessText, statusOf } from '../live/liveState';
import { cronText } from '../model/cronText';
import { conditionInfo } from '../model/entryConditions';

const Row = ({ k, children }: { k: string; children: ReactNode }) => (
  <div className="in-row"><span className="in-k">{k}</span><span className="in-v">{children}</span></div>
);

function BoardSummary({ workflows }: { workflows: BoardWorkflow[] }) {
  const store = useLiveStore();
  useLive((s) => s.running);
  useLive((s) => s.workflows);
  const running = workflows.filter((w) => statusOf(store.getState(), w.graph.workflow.id) === 'running').length;
  return <div className="in-sum">{`Board: ${workflows.length} workflow${workflows.length === 1 ? '' : 's'}, ${running} running`}</div>;
}

function WorkflowView({ w }: { w: BoardWorkflow }) {
  const { workflow } = w.graph;
  const cron = workflow.cronExpression;
  const parsed = cron ? cronText(cron) : null;
  const schedule = parsed === null ? 'not scheduled' : 'text' in parsed ? parsed.text : cron;
  const { x, y, w: fw, h } = w.frame;
  return (
    <>
      <div className="in-title">{workflow.name}</div>
      <Row k="Version">{workflow.version}</Row>
      <Row k="Description">{workflow.description || 'none'}</Row>
      <Row k="Cron">{schedule}</Row>
      <Row k="Steps">{w.stepIds.length}</Row>
      <Row k="Wires">{w.wires.length}</Row>
      <Row k="Position">{`${Math.round(x)}, ${Math.round(y)}`}</Row>
      <Row k="Size">{`${Math.round(fw)} × ${Math.round(h)}`}</Row>
    </>
  );
}

function ProcessorLine({ processorId }: { processorId: string }) {
  const { known, processor } = useProcessorLive(processorId);
  return <Row k="Liveness">{livenessText(known, processor)}</Row>;
}

function StepView({ w, stepId, workflows }: { w: BoardWorkflow; stepId: string; workflows: BoardWorkflow[] }) {
  const step = w.graph.steps.get(stepId);
  if (!step) return null;
  const cond = conditionInfo(step.entryCondition);
  const processor = step.processorId ? w.graph.processors.get(step.processorId) : undefined;
  const sharing = workflows.filter((x) => x.stepIds.includes(stepId));
  return (
    <>
      <div className="in-title">{step.name}</div>
      <Row k="Version">{step.version}</Row>
      <Row k="Entry condition">{`${cond.letter} ${cond.name}`}</Row>
      <Row k="Processor">{!step.processorId ? 'none' : processor?.name ?? step.processorId}</Row>
      {step.processorId && <ProcessorLine processorId={step.processorId} />}
      <Row k="Role">{w.roles.get(stepId) ?? 'reached'}</Row>
      {sharing.length > 1 && <Row k="Shared">{`shared · ${sharing.length}: ${sharing.map((x) => x.graph.workflow.name).join(', ')}`}</Row>}
    </>
  );
}

function WireView({ w, wireId }: { w: BoardWorkflow; wireId: string }) {
  const wire = w.wires.find((x) => x.id === wireId);
  if (!wire) return null;
  const name = (id: string) => w.graph.steps.get(id)?.name ?? id;
  return (
    <>
      <div className="in-title">Wire</div>
      <Row k="From">{name(wire.from)}</Row>
      <Row k="To">{name(wire.to)}</Row>
      <Row k="Runs when">{conditionInfo(wire.condition).name}</Row>
      <p className="in-note">{`The colour is the entry condition of ${name(wire.to)}. Change it on that step; every wire into it follows.`}</p>
    </>
  );
}

function CacheView({ w, cacheId }: { w: BoardWorkflow; cacheId: string }) {
  const cache = w.graph.caches.get(cacheId);
  if (!cache) return null;
  return (
    <>
      <div className="in-title">{cache.name}</div>
      <Row k="Version">{cache.version}</Row>
      <Row k="Description">{cache.description || 'none'}</Row>
      <Row k="Root">{cache.root || 'none'}</Row>
    </>
  );
}

/** Read-only in Plan 1: what the selection is, as the loaded board knows it. */
export function InspectorPanel({ workflows, selection }: { workflows: BoardWorkflow[]; selection: Selection | null }) {
  const w = selection === null ? undefined : workflows.find((x) => x.graph.workflow.id === selection.workflowId);
  return (
    <>
      <div className="ph"><span>Inspector</span></div>
      <div className="pb">
        {selection === null || !w ? <BoardSummary workflows={workflows} />
          : selection.kind === 'workflow' ? <WorkflowView w={w} />
          : selection.kind === 'step' ? <StepView w={w} stepId={selection.stepId} workflows={workflows} />
          : selection.kind === 'cache' ? <CacheView w={w} cacheId={selection.cacheId} />
          : <WireView w={w} wireId={selection.wireId} />}
      </div>
    </>
  );
}
