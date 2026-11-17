import type { BoardWorkflow } from '../board/loadBoard';
import { lastPick, pickKey, type Pick } from '../board/picks';
import { processorColour } from '../board/nodes/StepCard';
import { conditionStyle } from '../board/wires';
import { useLive, useLiveStore, useProcessorLive, useWorkflowStatus } from '../live/LiveContext';
import { livenessText, statusOf } from '../live/liveState';
import { cronText } from '../model/cronText';
import { CONDITIONS, conditionInfo } from '../model/entryConditions';
import { checkPayload } from '../model/payloadCheck';
import { useEntry, type BoardStore } from '../design/boardStore';
import { canRedo, canUndo } from '../design/history';
import { newId } from '../design/ids';
import { removeAssignment, setCacheField, setPayload, setStepField, setWorkflowField } from '../design/state';
import { AreaField, LockNote, lockerName, Ro, Row, Sec, SelectField, TextField } from './fields';
import { ProcessorSection } from './ProcessorSection';

const CACHE_TONE = '#B8A36A';

/** The mock's .ins-title: an icon, the bold name and a small line under it. */
const Title = ({ tone, letter, name, sub }: { tone: string; letter: string; name: string; sub: string }) => (
  <div className="ins-title"><span className="ico" style={{ background: tone }}>{letter}</span><div><b>{name}</b><small>{sub}</small></div></div>
);

function WorkflowTitle({ w, unsaved = false }: { w: BoardWorkflow; unsaved?: boolean }) {
  const status = useWorkflowStatus(w.graph.workflow.id);
  const run = status === 'running' ? 'Running' : status === 'stopped' ? 'Stopped' : 'Checking…';
  return <Title tone="var(--accent)" letter="W" name={w.graph.workflow.name} sub={`${run}${unsaved ? ' · unsaved' : ''}`} />;
}

function StepTitle({ w, stepId }: { w: BoardWorkflow; stepId: string }) {
  const step = w.graph.steps.get(stepId);
  const proc = step?.processorId ? w.graph.processors.get(step.processorId)?.name : undefined;
  return <Title tone={processorColour(proc ?? '')} letter={(proc ?? '?').charAt(0).toUpperCase()} name={step?.name ?? stepId} sub={`in ${w.graph.workflow.name}`} />;
}

function BoardSummary({ workflows, store }: { workflows: BoardWorkflow[]; store?: BoardStore | undefined }) {
  const live = useLiveStore();
  useLive((s) => s.running);
  useLive((s) => s.workflows);
  const running = workflows.filter((w) => statusOf(live.getState(), w.graph.workflow.id) === 'running').length;
  const unsaved = store ? workflows.filter((w) => store.entry(w.graph.workflow.id)?.unsaved).length : null;
  return (
    <p className="none">Select a workflow, step or wire to see and edit it here.<br /><br />
      <span>{`Board: ${workflows.length} workflow${workflows.length === 1 ? '' : 's'}, ${running} running`}</span>{unsaved !== null ? `, ${unsaved} unsaved.` : '.'}</p>
  );
}

function WorkflowView({ w }: { w: BoardWorkflow }) {
  const { workflow } = w.graph;
  const cron = workflow.cronExpression;
  const parsed = cron ? cronText(cron) : null;
  const schedule = parsed === null ? 'not scheduled' : 'text' in parsed ? parsed.text : cron;
  return (
    <>
      <WorkflowTitle w={w} />
      <Ro>
        <Row k="Version">{workflow.version}</Row>
        <Row k="Description">{workflow.description || 'none'}</Row>
        <Row k="Cron">{schedule}</Row>
      </Ro>
      <OnTheBoard w={w} />
    </>
  );
}

function OnTheBoard({ w }: { w: BoardWorkflow }) {
  const { x, y, w: fw, h } = w.frame;
  return (
    <>
      <Sec>On the board</Sec>
      <Ro>
        <Row k="Steps">{w.stepIds.length}</Row>
        <Row k="Wires">{w.wires.length}</Row>
        <Row k="Position">{`${Math.round(x)}, ${Math.round(y)}`}</Row>
        <Row k="Size">{`${Math.round(fw)} × ${Math.round(h)}`}</Row>
      </Ro>
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
      <StepTitle w={w} stepId={stepId} />
      <Ro>
        <Row k="Version">{step.version}</Row>
        <Row k="Entry condition">{`${cond.letter} ${cond.name}`}</Row>
        <Row k="Role">{w.roles.get(stepId) ?? 'reached'}</Row>
        {sharing.length > 1 && <Row k="Shared">{`shared · ${sharing.length}: ${sharing.map((x) => x.graph.workflow.name).join(', ')}`}</Row>}
      </Ro>
      <Sec>Processor · live</Sec>
      <Ro>
        <Row k="Processor">{!step.processorId ? 'none' : processor?.name ?? step.processorId}</Row>
        {step.processorId && <ProcessorLine processorId={step.processorId} />}
      </Ro>
    </>
  );
}

function WireView({ w, wireId }: { w: BoardWorkflow; wireId: string }) {
  const wire = w.wires.find((x) => x.id === wireId);
  if (!wire) return null;
  const name = (id: string) => w.graph.steps.get(id)?.name ?? id;
  const c = conditionStyle(wire.condition);
  return (
    <>
      <Title tone={c.colour} letter={c.letter} name={`${name(wire.from)} → ${name(wire.to)}`} sub={`in ${w.graph.workflow.name}`} />
      <Ro>
        <Row k="From">{name(wire.from)}</Row>
        <Row k="To">{name(wire.to)}</Row>
        <Row k="Runs when">{conditionInfo(wire.condition).name}</Row>
      </Ro>
      <p className="none">{`The colour is the entry condition of ${name(wire.to)}. Change it on that step; every wire into it follows.`}</p>
    </>
  );
}

function CacheTitle({ w, name }: { w: BoardWorkflow; name: string }) {
  return <Title tone={CACHE_TONE} letter="C" name={name} sub={`cache · in ${w.graph.workflow.name}`} />;
}

function CacheView({ w, cacheId }: { w: BoardWorkflow; cacheId: string }) {
  const cache = w.graph.caches.get(cacheId);
  if (!cache) return null;
  return (
    <>
      <CacheTitle w={w} name={cache.name} />
      <Ro>
        <Row k="Version">{cache.version}</Row>
        <Row k="Description">{cache.description || 'none'}</Row>
        <Row k="Root">{cache.root || 'none'}</Row>
      </Ro>
    </>
  );
}

const orNull = (v: string) => (v === '' ? null : v);

function EditWorkflow({ w, store }: { w: BoardWorkflow; store: BoardStore }) {
  const { workflow } = w.graph;
  const id = workflow.id;
  const entry = useEntry(store, id);
  const set = (key: 'name' | 'version' | 'description' | 'cronExpression', v: string | null) =>
    store.edit(id, (s) => setWorkflowField(s, key, v), `field:${id}:${key}`);
  const parsed = workflow.cronExpression ? cronText(workflow.cronExpression) : null;
  return (
    <>
      <WorkflowTitle w={w} unsaved={entry?.unsaved ?? false} />
      <TextField key={`${id}:name`} label="Name" value={workflow.name} onChange={(v) => set('name', v)} />
      <TextField key={`${id}:version`} label="Version" value={workflow.version} onChange={(v) => set('version', v)} />
      <TextField key={`${id}:cron`} label="Cron" value={workflow.cronExpression} onChange={(v) => set('cronExpression', orNull(v))} />
      <p className="in-note">{parsed === null ? 'not scheduled' : 'text' in parsed ? parsed.text : workflow.cronExpression}</p>
      <TextField key={`${id}:description`} label="Description" value={workflow.description} onChange={(v) => set('description', orNull(v))} />
      <OnTheBoard w={w} />
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
  // another workflow is changing this step: its saved value shows here, read-only
  const by = lockerName(store, `step:${stepId}`, wf);
  const locked = by !== null;
  return (
    <>
      <StepTitle w={w} stepId={stepId} />
      <LockNote by={by} />
      <TextField key={`${stepId}:name`} label="Name" value={step.name} disabled={locked} onChange={(v) => set('name', v)} />
      <TextField key={`${stepId}:version`} label="Version" value={step.version} disabled={locked} onChange={(v) => set('version', v)} />
      <TextField key={`${stepId}:description`} label="Description" value={step.description} disabled={locked} onChange={(v) => set('description', orNull(v))} />
      <SelectField key={`${stepId}:entryCondition`} label="Entry condition · colours every wire into this step" value={step.entryCondition} disabled={locked}
        options={CONDITIONS.map((c) => ({ value: c.value, label: `${c.letter} · ${c.name}` }))} onChange={(v) => set('entryCondition', v)} />
      <Ro>
        <Row k="Role">{w.roles.get(stepId) ?? 'reached'}</Row>
        {sharing.length > 1 && <Row k="Shared">{`shared · ${sharing.length}: ${sharing.map((x) => x.graph.workflow.name).join(', ')}`}</Row>}
      </Ro>
      <Sec>Processor · live</Sec>
      {step.processorId ? <ProcessorSection w={w} store={store} processorId={step.processorId} /> : <Ro><Row k="Processor">none</Row></Ro>}
      {step.processorId && <Ro><ProcessorLine processorId={step.processorId} /></Ro>}
      <Sec>Assignment (config payload)</Sec>
      <AreaField key={`${stepId}:payload`} label="Payload · JSON" value={payload}
        onChange={(v) => { if (v === '' && !assignment) return; store.edit(wf, (s) => setPayload(s, stepId, v, newId), `field:${stepId}:payload`); }} />
      {assignment && <PayloadCheckNote w={w} stepId={stepId} payload={payload} />}
      {assignment && <button type="button" className="pbtn in-act" onClick={() => store.edit(wf, (s) => removeAssignment(s, stepId))}>Remove assignment</button>}
    </>
  );
}

function EditCache({ w, cacheId, store }: { w: BoardWorkflow; cacheId: string; store: BoardStore }) {
  const cache = w.graph.caches.get(cacheId);
  if (!cache) return null;
  const wf = w.graph.workflow.id;
  const set = (key: 'name' | 'version' | 'description' | 'root' | 'items', v: string | null) =>
    store.edit(wf, (s) => setCacheField(s, cacheId, key, v), `field:${cacheId}:${key}`);
  const by = lockerName(store, `cache:${cacheId}`, wf);
  const locked = by !== null;
  return (
    <>
      <CacheTitle w={w} name={cache.name} />
      <LockNote by={by} />
      <TextField key={`${cacheId}:name`} label="Name" value={cache.name} disabled={locked} onChange={(v) => set('name', v)} />
      <TextField key={`${cacheId}:version`} label="Version" value={cache.version} disabled={locked} onChange={(v) => set('version', v)} />
      <TextField key={`${cacheId}:description`} label="Description" value={cache.description} disabled={locked} onChange={(v) => set('description', orNull(v))} />
      <TextField key={`${cacheId}:root`} label="Root" value={cache.root} disabled={locked} onChange={(v) => set('root', v)} />
      <AreaField key={`${cacheId}:items`} label="Items" value={cache.items} disabled={locked} onChange={(v) => set('items', v)} />
    </>
  );
}

/** The kind of the selection, or how many things are picked, next to the panel's name. */
const kindOf = (picks: Pick[]) => (picks.length > 1 ? `${picks.length} selected` : lastPick(picks)?.kind ?? '');

function Header({ store, workflowId, name, kind }: { store: BoardStore; workflowId: string | null; name: string | null; kind: string }) {
  const entry = useEntry(store, workflowId ?? '');
  return (
    <div className="ph"><span>Inspector</span><span className="cnt">{kind}</span><span className="sp" />
      {name !== null && <span className="hw" title={name}>{name}</span>}
      <button type="button" className="pbtn" disabled={!entry || !canUndo(entry.history)} onClick={() => workflowId && store.undo(workflowId)}>Undo</button>
      <button type="button" className="pbtn" disabled={!entry || !canRedo(entry.history)} onClick={() => workflowId && store.redo(workflowId)}>Redo</button>
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

function PickList({ picks, workflows, undoIn }: { picks: Pick[]; workflows: BoardWorkflow[]; undoIn: string | null }) {
  return (
    <>
      <p className="none">{`${picks.length} things are selected. The toolbar acts on all of them; pick one alone to edit it here.`}</p>
      <ol className="in-picks">
        {picks.map((p) => {
          const n = pickName(p, workflows);
          return n === null ? null : <li key={pickKey(p)} data-kind={p.kind}>{n}</li>;
        })}
      </ol>
      {undoIn !== null && <p className="none">Undo and Redo act on <b>{undoIn}</b>, the workflow of the last one picked.</p>}
    </>
  );
}

/** What the selection is, as the loaded board knows it; editable when given the store. */
export function InspectorPanel({ workflows, picks, store }: { workflows: BoardWorkflow[]; picks: Pick[]; store?: BoardStore }) {
  const selection = lastPick(picks);
  const w = selection === null ? undefined : workflows.find((x) => x.graph.workflow.id === selection.workflowId);
  const kind = kindOf(picks);
  return (
    <>
      {store ? <Header store={store} workflowId={w ? w.graph.workflow.id : null} name={w ? w.graph.workflow.name : null} kind={kind} />
        : <div className="ph"><span>Inspector</span><span className="cnt">{kind}</span></div>}
      <div className="pb">
        {picks.length > 1 ? <PickList picks={picks} workflows={workflows} undoIn={store && w ? w.graph.workflow.name : null} />
          : selection === null || !w ? <BoardSummary workflows={workflows} store={store} />
          : selection.kind === 'workflow' ? (store ? <EditWorkflow w={w} store={store} /> : <WorkflowView w={w} />)
          : selection.kind === 'step' ? (store ? <EditStep w={w} stepId={selection.stepId} workflows={workflows} store={store} /> : <StepView w={w} stepId={selection.stepId} workflows={workflows} />)
          : selection.kind === 'cache' ? (store ? <EditCache w={w} cacheId={selection.cacheId} store={store} /> : <CacheView w={w} cacheId={selection.cacheId} />)
          : <WireView w={w} wireId={selection.wireId} />}
      </div>
    </>
  );
}
