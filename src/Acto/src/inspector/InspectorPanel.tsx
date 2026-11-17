import type { ReactNode } from 'react';
import type { BoardWorkflow } from '../board/loadBoard';
import { lastPick, pickKey, type Pick } from '../board/picks';
import { useLive, useLiveStore, useProcessorLive } from '../live/LiveContext';
import { livenessText, statusOf } from '../live/liveState';
import { cronText } from '../model/cronText';
import { CONDITIONS, conditionInfo } from '../model/entryConditions';
import { checkPayload } from '../model/payloadCheck';
import { useEntry, type BoardStore } from '../design/boardStore';
import { canRedo, canUndo } from '../design/history';
import { newId } from '../design/ids';
import { removeAssignment, setCacheField, setPayload, setStepField, setWorkflowField } from '../design/state';
import { AreaField, SelectField, TextField } from './fields';
import { ProcessorSection } from './ProcessorSection';

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

const orNull = (v: string) => (v === '' ? null : v);

function EditWorkflow({ w, store }: { w: BoardWorkflow; store: BoardStore }) {
  const { workflow } = w.graph;
  const id = workflow.id;
  const set = (key: 'name' | 'version' | 'description' | 'cronExpression', v: string | null) =>
    store.edit(id, (s) => setWorkflowField(s, key, v), `field:${id}:${key}`);
  const parsed = workflow.cronExpression ? cronText(workflow.cronExpression) : null;
  return (
    <>
      <TextField key={`${id}:name`} label="Name" value={workflow.name} onChange={(v) => set('name', v)} />
      <TextField key={`${id}:version`} label="Version" value={workflow.version} onChange={(v) => set('version', v)} />
      <TextField key={`${id}:description`} label="Description" value={workflow.description} onChange={(v) => set('description', orNull(v))} />
      <TextField key={`${id}:cron`} label="Cron" value={workflow.cronExpression} onChange={(v) => set('cronExpression', orNull(v))} />
      <p className="in-note">{parsed === null ? 'not scheduled' : 'text' in parsed ? parsed.text : workflow.cronExpression}</p>
      <Row k="Steps">{w.stepIds.length}</Row>
      <Row k="Wires">{w.wires.length}</Row>
    </>
  );
}

function PayloadCheckNote({ w, stepId, payload }: { w: BoardWorkflow; stepId: string; payload: string }) {
  const step = w.graph.steps.get(stepId);
  const processor = step?.processorId ? w.graph.processors.get(step.processorId) : undefined;
  const schema = processor?.configSchemaId ? w.graph.schemas.get(processor.configSchemaId) : undefined;
  if (!schema?.definition) return null;
  const r = checkPayload(schema.definition, payload);
  if ('unchecked' in r) return <p className="in-note">{r.unchecked}</p>;
  return <>{r.problems.map((p, i) => <p key={i} className="in-problem">{p}</p>)}</>;
}

function EditStep({ w, stepId, workflows, store }: { w: BoardWorkflow; stepId: string; workflows: BoardWorkflow[]; store: BoardStore }) {
  const step = w.graph.steps.get(stepId);
  if (!step) return null;
  const wf = w.graph.workflow.id;
  const set = (key: 'name' | 'version' | 'description' | 'entryCondition', v: string | number | null) =>
    store.edit(wf, (s) => setStepField(s, stepId, key, v), `field:${stepId}:${key}`);
  const assignment = w.graph.assignments.find((a) => a.stepId === stepId);
  const payload = assignment?.payload ?? '';
  const sharing = workflows.filter((x) => x.stepIds.includes(stepId));
  return (
    <>
      <TextField key={`${stepId}:name`} label="Name" value={step.name} onChange={(v) => set('name', v)} />
      <TextField key={`${stepId}:version`} label="Version" value={step.version} onChange={(v) => set('version', v)} />
      <TextField key={`${stepId}:description`} label="Description" value={step.description} onChange={(v) => set('description', orNull(v))} />
      <SelectField key={`${stepId}:entryCondition`} label="Entry condition · colours every wire into this step" value={step.entryCondition}
        options={CONDITIONS.map((c) => ({ value: c.value, label: `${c.letter} ${c.name}` }))} onChange={(v) => set('entryCondition', v)} />
      {step.processorId ? <ProcessorSection w={w} store={store} processorId={step.processorId} /> : <Row k="Processor">none</Row>}
      {step.processorId && <ProcessorLine processorId={step.processorId} />}
      <Row k="Role">{w.roles.get(stepId) ?? 'reached'}</Row>
      {sharing.length > 1 && <Row k="Shared">{`shared · ${sharing.length}: ${sharing.map((x) => x.graph.workflow.name).join(', ')}`}</Row>}
      <AreaField key={`${stepId}:payload`} label="Payload (JSON)" value={payload}
        onChange={(v) => { if (v === '' && !assignment) return; store.edit(wf, (s) => setPayload(s, stepId, v, newId), `field:${stepId}:payload`); }} />
      {assignment && <PayloadCheckNote w={w} stepId={stepId} payload={payload} />}
      {assignment && <button type="button" className="in-act" onClick={() => store.edit(wf, (s) => removeAssignment(s, stepId))}>Remove assignment</button>}
    </>
  );
}

function EditCache({ w, cacheId, store }: { w: BoardWorkflow; cacheId: string; store: BoardStore }) {
  const cache = w.graph.caches.get(cacheId);
  if (!cache) return null;
  const wf = w.graph.workflow.id;
  const set = (key: 'name' | 'version' | 'description' | 'root' | 'items', v: string | null) =>
    store.edit(wf, (s) => setCacheField(s, cacheId, key, v), `field:${cacheId}:${key}`);
  return (
    <>
      <TextField key={`${cacheId}:name`} label="Name" value={cache.name} onChange={(v) => set('name', v)} />
      <TextField key={`${cacheId}:version`} label="Version" value={cache.version} onChange={(v) => set('version', v)} />
      <TextField key={`${cacheId}:description`} label="Description" value={cache.description} onChange={(v) => set('description', orNull(v))} />
      <TextField key={`${cacheId}:root`} label="Root" value={cache.root} onChange={(v) => set('root', v)} />
      <AreaField key={`${cacheId}:items`} label="Items" value={cache.items} onChange={(v) => set('items', v)} />
    </>
  );
}

function Header({ store, workflowId, name }: { store: BoardStore; workflowId: string | null; name: string | null }) {
  const entry = useEntry(store, workflowId ?? '');
  return (
    <div className="ph"><span>Inspector</span>
      {name !== null && <span className="ph-wf">{name}</span>}
      <button type="button" disabled={!entry || !canUndo(entry.history)} onClick={() => workflowId && store.undo(workflowId)}>Undo</button>
      <button type="button" disabled={!entry || !canRedo(entry.history)} onClick={() => workflowId && store.redo(workflowId)}>Redo</button>
    </div>
  );
}

function pickName(p: Pick, workflows: BoardWorkflow[]): string | null {
  const w = workflows.find((x) => x.graph.workflow.id === p.workflowId);
  if (!w) return null;
  if (p.kind === 'workflow') return w.graph.workflow.name;
  if (p.kind === 'step') return w.graph.steps.get(p.stepId)?.name ?? null;
  if (p.kind === 'cache') return w.graph.caches.get(p.cacheId)?.name ?? null;
  const wire = w.wires.find((x) => x.id === p.wireId);
  if (!wire) return null;
  const name = (id: string) => w.graph.steps.get(id)?.name ?? id;
  return `${name(wire.from)} → ${name(wire.to)}`;
}

function PickList({ picks, workflows }: { picks: Pick[]; workflows: BoardWorkflow[] }) {
  return (
    <>
      <div className="in-title">{`${picks.length} selected`}</div>
      <ol className="in-picks">
        {picks.map((p) => {
          const n = pickName(p, workflows);
          return n === null ? null : <li key={pickKey(p)} data-kind={p.kind}>{n}</li>;
        })}
      </ol>
    </>
  );
}

/** What the selection is, as the loaded board knows it; editable when given the store. */
export function InspectorPanel({ workflows, picks, store }: { workflows: BoardWorkflow[]; picks: Pick[]; store?: BoardStore }) {
  const selection = lastPick(picks);
  const w = selection === null ? undefined : workflows.find((x) => x.graph.workflow.id === selection.workflowId);
  return (
    <>
      {store ? <Header store={store} workflowId={w ? w.graph.workflow.id : null} name={w ? w.graph.workflow.name : null} />
        : <div className="ph"><span>Inspector</span></div>}
      <div className="pb">
        {picks.length > 1 ? <PickList picks={picks} workflows={workflows} />
          : selection === null || !w ? <BoardSummary workflows={workflows} />
          : selection.kind === 'workflow' ? (store ? <EditWorkflow w={w} store={store} /> : <WorkflowView w={w} />)
          : selection.kind === 'step' ? (store ? <EditStep w={w} stepId={selection.stepId} workflows={workflows} store={store} /> : <StepView w={w} stepId={selection.stepId} workflows={workflows} />)
          : selection.kind === 'cache' ? (store ? <EditCache w={w} cacheId={selection.cacheId} store={store} /> : <CacheView w={w} cacheId={selection.cacheId} />)
          : <WireView w={w} wireId={selection.wireId} />}
      </div>
    </>
  );
}
