import { useSyncExternalStore } from 'react';
import { lastPick, pickKey } from '../board/picks';
import type { Pick } from '../board/selection';
import { processorColour } from '../board/nodes/StepCard';
import { CACHE_TONE } from '../board/nodes/CacheNode';
import { conditionStyle } from '../board/wires';
import type { BoardState } from '../design/board';
import { reachOf } from '../design/board';
import type { BoardStore } from '../design/boardStore';
import { removeEntries, setCacheField, setStepField, setWorkflowField, unlinkCaches } from '../design/edits';
import { newId } from '../design/ids';
import { assignmentOf, assignmentsOf, removeAssignment, setAssignmentPayload, setPayload } from '../design/payloads';
import { useLive, useLiveStore, useProcessorLive, useWorkflowStatus } from '../live/LiveContext';
import { livenessText, statusOf } from '../live/liveState';
import { cronText } from '../model/cronText';
import { CONDITIONS, conditionInfo } from '../model/entryConditions';
import { checkPayload, payloadJsonProblem } from '../model/payloadCheck';
import { AreaField, Ro, Row, Sec, SelectField, TextField } from './fields';
import { ProcessorSection } from './ProcessorSection';

type Id = string;
export interface InspectorSelection { workflows: Id[]; picks: Pick[] }

const orNull = (v: string) => (v === '' ? null : v);

/** The mock's .ins-title: an icon, the bold name and a small line under it. */
const Title = ({ tone, letter, name, sub }: { tone: string; letter: string; name: string; sub: string }) => (
  <div className="ins-title"><span className="ico" style={{ background: tone }}>{letter}</span><div><b>{name}</b><small>{sub}</small></div></div>
);

type Edit = (fn: (b: BoardState) => BoardState, merge?: string) => void;
interface Ctx { state: BoardState; edit: Edit }

const stepName = (b: BoardState, id: Id) => b.steps[id]?.name ?? id;

function WorkflowTitle({ state, id }: { state: BoardState; id: Id }) {
  const status = useWorkflowStatus(id);
  const run = status === 'running' ? 'Running' : status === 'stopped' ? 'Stopped' : 'Checking…';
  return <Title tone="var(--accent)" letter="W" name={state.workflows[id]?.name ?? id} sub={run} />;
}

function StepTitle({ state, id, sub }: { state: BoardState; id: Id; sub: string }) {
  const step = state.steps[id];
  const proc = step?.processorId ? state.processors[step.processorId]?.name : undefined;
  return <Title tone={processorColour(proc ?? '')} letter={(proc ?? '?').charAt(0).toUpperCase()} name={step?.name ?? id} sub={sub} />;
}

function BoardSummary({ state }: { state: BoardState }) {
  const live = useLiveStore();
  useLive((s) => s.running);
  useLive((s) => s.workflows);
  const ids = Object.keys(state.workflows);
  const running = ids.filter((id) => statusOf(live.getState(), id) === 'running').length;
  return (
    <p className="none">Select a workflow, step or wire to see and edit it here.<br /><br />
      <span>{`Board: ${ids.length} workflow${ids.length === 1 ? '' : 's'}, ${running} running`}</span>.</p>
  );
}

function PayloadCheckNote({ state, stepId, payload }: { state: BoardState; stepId: Id; payload: string }) {
  const processorId = state.steps[stepId]?.processorId;
  const processor = processorId ? state.processors[processorId] : undefined;
  const schema = processor?.configSchemaId ? state.schemas[processor.configSchemaId] : undefined;
  // text that is not JSON says so whether or not there is a schema to check it against
  const notJson = payloadJsonProblem(payload);
  if (notJson !== null) return <p className="in-problem">{notJson}</p>;
  if (!schema?.definition) return null;
  const r = checkPayload(schema.definition, payload);
  if ('unchecked' in r) return <p className="in-note">{r.unchecked}</p>;
  return <>{r.problems.map((p, i) => <p key={i} className="in-problem">{p}</p>)}</>;
}

function ProcessorLine({ processorId }: { processorId: Id }) {
  const { known, processor } = useProcessorLive(processorId);
  return <Row k="Liveness">{livenessText(known, processor)}</Row>;
}

function EditWorkflow({ state, edit, id }: Ctx & { id: Id }) {
  const w = state.workflows[id];
  if (!w) return null;
  const set = (key: 'name' | 'version' | 'description' | 'cronExpression', v: string | null) =>
    edit((b) => setWorkflowField(b, id, key, v), `field:${id}:${key}`);
  const parsed = w.cronExpression ? cronText(w.cronExpression) : null;
  const assignments = assignmentsOf(state, id);
  return (
    <>
      <WorkflowTitle state={state} id={id} />
      <TextField key={`${id}:name`} label="Name" value={w.name} onChange={(v) => set('name', v)} />
      <TextField key={`${id}:version`} label="Version" value={w.version} onChange={(v) => set('version', v)} />
      <TextField key={`${id}:cron`} label="Cron" value={w.cronExpression} onChange={(v) => set('cronExpression', orNull(v))} />
      <p className="in-note">{parsed === null ? 'not scheduled' : 'text' in parsed ? parsed.text : w.cronExpression}</p>
      <AreaField key={`${id}:description`} label="Description" value={w.description ?? ''} onChange={(v) => set('description', orNull(v))} />
      <Sec>Entry steps and caches</Sec>
      <Ro>
        {w.entryStepIds.map((sid) => (
          <Row key={`e:${sid}`} k="Entry step">
            {stepName(state, sid)}{' '}
            <button type="button" className="pbtn in-act" aria-label={`Remove entry ${stepName(state, sid)}`} onClick={() => edit((b) => removeEntries(b, [[id, sid]]))}>Remove</button>
          </Row>
        ))}
        {w.cacheIds.map((cid) => (
          <Row key={`c:${cid}`} k="Cache">
            {state.caches[cid]?.name ?? cid}{' '}
            <button type="button" className="pbtn in-act" aria-label={`Remove cache ${state.caches[cid]?.name ?? cid}`} onClick={() => edit((b) => unlinkCaches(b, [[id, cid]]))}>Remove</button>
          </Row>
        ))}
      </Ro>
      <Ro><Row k="Location">{w.at ? `${Math.round(w.at.x)}, ${Math.round(w.at.y)}` : 'not placed'}</Row></Ro>
      <Sec>Assignments</Sec>
      <div data-testid="assignments">
        {assignments.length === 0 && <p className="none">No assignments.</p>}
        {assignments.map((a, i) => (
          <div key={`${id}:${i}`} className="in-assign">
            <b>{stepName(state, a.stepId)}</b>
            <AreaField key={`${id}:${i}:payload`} label="Payload · JSON" value={a.payload}
              onChange={(v) => edit((b) => { const cur = b.workflows[id]?.assignmentIds[i]; return cur ? setAssignmentPayload(b, id, cur, v, newId) : b; }, `field:${id}:${i}:payload`)} />
            <PayloadCheckNote state={state} stepId={a.stepId} payload={a.payload} />
            <button type="button" className="pbtn in-act" onClick={() => edit((b) => removeAssignment(b, id, a.id))}>Delete</button>
          </div>
        ))}
      </div>
    </>
  );
}

function EditStep({ state, edit, id, workflow }: Ctx & { id: Id; workflow: Id | null }) {
  const step = state.steps[id];
  if (!step) return null;
  const set = (key: 'name' | 'version' | 'description' | 'entryCondition', v: string | number | null) =>
    edit((b) => setStepField(b, id, key, v as never), `field:${id}:${key}`);
  const wf = workflow ? state.workflows[workflow] : undefined;
  const reached = wf && workflow ? reachOf(state, workflow).has(id) : false;
  const assignment = wf && workflow ? assignmentOf(state, workflow, id) : null;
  const payload = assignment?.payload ?? '';
  const users = Object.values(state.workflows).filter((x) => reachOf(state, x.id).has(id));
  return (
    <>
      <StepTitle state={state} id={id} sub={wf ? `in ${wf.name}` : 'step'} />
      <p className="in-note">{users.length > 0 ? `shared fields · used by ${users.map((x) => x.name).join(', ')}` : 'shared fields · used by no workflow'}</p>
      <TextField key={`${id}:name`} label="Name" value={step.name} onChange={(v) => set('name', v)} />
      <TextField key={`${id}:version`} label="Version" value={step.version} onChange={(v) => set('version', v)} />
      <TextField key={`${id}:description`} label="Description" value={step.description} onChange={(v) => set('description', orNull(v))} />
      <SelectField key={`${id}:entryCondition`} label="Entry condition · colours every wire into this step" value={step.entryCondition}
        options={CONDITIONS.map((c) => ({ value: c.value, label: `${c.letter} · ${c.name}` }))} onChange={(v) => set('entryCondition', v)} />
      <Sec>Processor · live</Sec>
      {step.processorId ? <ProcessorSection state={state} edit={edit} processorId={step.processorId} /> : <Ro><Row k="Processor">none</Row></Ro>}
      {step.processorId && <Ro><ProcessorLine processorId={step.processorId} /></Ro>}
      {wf && workflow && (
        reached ? (
          <>
            <Sec>{`Payload · ${wf.name}`}</Sec>
            <AreaField key={`${workflow}:${id}:payload`} label="Payload · JSON" value={payload}
              onChange={(v) => { if (v === '' && !assignment) return; edit((b) => setPayload(b, workflow, id, v, newId), `field:${workflow}:${id}:payload`); }} />
            {assignment && <PayloadCheckNote state={state} stepId={id} payload={payload} />}
            {assignment && <button type="button" className="pbtn in-act" onClick={() => edit((b) => removeAssignment(b, workflow, assignment.id))}>Remove assignment</button>}
          </>
        ) : <p className="none">{`not in ${wf.name}`}</p>
      )}
    </>
  );
}

function EditCache({ state, edit, id }: Ctx & { id: Id }) {
  const cache = state.caches[id];
  if (!cache) return null;
  const set = (key: 'name' | 'version' | 'description' | 'root' | 'items', v: string | null) =>
    edit((b) => setCacheField(b, id, key, v as never), `field:${id}:${key}`);
  const users = Object.values(state.workflows).filter((w) => w.cacheIds.includes(id)).map((w) => w.name);
  return (
    <>
      <Title tone={CACHE_TONE} letter="C" name={cache.name} sub={users.length ? `cache · ${users.join(', ')}` : 'cache'} />
      <TextField key={`${id}:name`} label="Name" value={cache.name} onChange={(v) => set('name', v)} />
      <TextField key={`${id}:version`} label="Version" value={cache.version} onChange={(v) => set('version', v)} />
      <TextField key={`${id}:description`} label="Description" value={cache.description} onChange={(v) => set('description', orNull(v))} />
      <TextField key={`${id}:root`} label="Root" value={cache.root} onChange={(v) => set('root', v)} />
      <AreaField key={`${id}:items`} label="Items" value={cache.items} onChange={(v) => set('items', v)} />
    </>
  );
}

/** A wire, an entry arrow or a cache line: from, to and, for a step target, when it runs. */
function LinkView({ state, pick }: { state: BoardState; pick: Extract<Pick, { kind: 'wire' | 'entry' | 'cacheLink' }> }) {
  if (pick.kind === 'cacheLink') {
    const from = state.workflows[pick.workflowId]?.name ?? pick.workflowId;
    const to = state.caches[pick.cacheId]?.name ?? pick.cacheId;
    return (
      <>
        <Title tone={CACHE_TONE} letter="C" name={`${from} → ${to}`} sub="cache line" />
        <Ro><Row k="From">{from}</Row><Row k="To">{to}</Row></Ro>
        <p className="none">{`${from} uses the cache ${to}.`}</p>
      </>
    );
  }
  const toId = pick.kind === 'wire' ? pick.to : pick.stepId;
  const from = pick.kind === 'wire' ? stepName(state, pick.from) : state.workflows[pick.workflowId]?.name ?? pick.workflowId;
  const to = stepName(state, toId);
  const c = conditionStyle(state.steps[toId]?.entryCondition ?? 0);
  return (
    <>
      <Title tone={c.colour} letter={c.letter} name={`${from} → ${to}`} sub={pick.kind === 'wire' ? 'wire' : 'entry arrow'} />
      <Ro>
        <Row k="From">{from}</Row>
        <Row k="To">{to}</Row>
        <Row k="Runs when">{conditionInfo(state.steps[toId]?.entryCondition ?? 0).name}</Row>
      </Ro>
      <p className="none">{`The colour is the entry condition of ${to}. Change it on that step; every wire into it follows.`}</p>
    </>
  );
}

function pickName(p: Pick, b: BoardState): string | null {
  switch (p.kind) {
    case 'workflow': return b.workflows[p.id]?.name ?? null;
    case 'step': return b.steps[p.id]?.name ?? null;
    case 'cache': return b.caches[p.id]?.name ?? null;
    case 'wire': return `${stepName(b, p.from)} → ${stepName(b, p.to)}`;
    case 'entry': return `${b.workflows[p.workflowId]?.name ?? p.workflowId} → ${stepName(b, p.stepId)}`;
    case 'cacheLink': return `${b.workflows[p.workflowId]?.name ?? p.workflowId} → ${b.caches[p.cacheId]?.name ?? p.cacheId}`;
    case 'ghost': return p.key; // Task 6 shows ghosts properly
  }
}

function PickList({ picks, state }: { picks: Pick[]; state: BoardState }) {
  return (
    <>
      <p className="none">{`${picks.length} things are selected. The toolbar acts on all of them; pick one alone to edit it here.`}</p>
      <ol className="in-picks">
        {picks.map((p) => {
          const n = pickName(p, state);
          return n === null ? null : <li key={pickKey(p)} data-kind={p.kind}>{n}</li>;
        })}
      </ol>
    </>
  );
}

const kindOf = (picks: Pick[]) => (picks.length > 1 ? `${picks.length} selected` : lastPick(picks)?.kind ?? '');

function Header({ store, kind }: { store: BoardStore; kind: string }) {
  return (
    <div className="ph"><span>Inspector</span><span className="cnt">{kind}</span><span className="sp" />
      <button type="button" className="pbtn" disabled={!store.canUndo()} onClick={() => store.undo()}>Undo</button>
      <button type="button" className="pbtn" disabled={!store.canRedo()} onClick={() => store.redo()}>Redo</button>
    </div>
  );
}

/**
 * What the selection is, read from and edited through the board store (one state, one history). `selection.workflow`
 * is the selected triangle: it decides whether a step shows a payload.
 */
export function InspectorPanel({ store, selection }: { store: BoardStore; selection: InspectorSelection }) {
  const state = useSyncExternalStore(store.subscribe, store.state);
  const edit: Edit = (fn, merge) => store.edit(fn, merge);
  const { picks } = selection;
  const workflow = selection.workflows.at(-1) ?? null;
  const one = picks.length === 1 ? picks[0]! : null;
  const target = one ?? (picks.length === 0 && workflow ? { kind: 'workflow', id: workflow } as const : null);
  return (
    <>
      <Header store={store} kind={kindOf(picks.length === 0 && target ? [target] : picks)} />
      <div className="pb">
        {picks.length > 1 ? <PickList picks={picks} state={state} />
          : target === null || target.kind === 'ghost' ? <BoardSummary state={state} />
          : target.kind === 'workflow' ? <EditWorkflow state={state} edit={edit} id={target.id} />
          : target.kind === 'step' ? <EditStep state={state} edit={edit} id={target.id} workflow={workflow} />
          : target.kind === 'cache' ? <EditCache state={state} edit={edit} id={target.id} />
          : <LinkView state={state} pick={target} />}
      </div>
    </>
  );
}
