import { conditionStyle } from '../../board/wires';
import { reachOf } from '../../design/board';
import { removeEntries, setWorkflowField, unlinkCaches } from '../../design/edits';
import { newId } from '../../design/ids';
import { assignmentOf, assignmentsOf, removeAssignment, setAssignmentPayload } from '../../design/payloads';
import { useWorkflowStatus } from '../../live/LiveContext';
import { payloadKeyCount } from '../../model/assignments';
import { cronText } from '../../model/cronText';
import type { Id } from '../../model/graph';
import { Ro, Row, Sec, TextField } from '../fields';
import { JsonField } from '../JsonField';
import { EntityBase, locationText, metaOfRow, orNull, PayloadCheckNote, stepName, type Ctx } from './shared';

const keysText = (payload: string) => {
  const n = payloadKeyCount(payload);
  return n === null ? '◆ payload' : `◆ ${n} key${n === 1 ? '' : 's'}`;
};

/** A workflow: its fields, entry steps and caches as chips (✕ removes), its assignments, and the payload keys in its stream. */
export function WorkflowTab({ state, base, edit, id }: Ctx & { id: Id }) {
  const status = useWorkflowStatus(id);
  const w = state.workflows[id];
  if (!w) return null;
  const set = (key: 'name' | 'version' | 'description' | 'cronExpression', v: string | null) =>
    edit((b) => setWorkflowField(b, id, key, v), `field:${id}:${key}`);
  const parsed = w.cronExpression ? cronText(w.cronExpression) : null;
  const assignments = assignmentsOf(state, id);
  const run = status === 'running' ? 'running' : status === 'stopped' ? 'stopped' : 'checking…';
  const stream = [...reachOf(state, id)].flatMap((sid) => {
    const a = assignmentOf(state, id, sid);
    return a ? [{ sid, a }] : [];
  });
  return (
    <>
      <EntityBase head={`${w.name} ${w.version}`} kind={`workflow · ${run}`} k={id} row={w} meta={metaOfRow(w)} set={set} />
      <TextField key={`${id}:cron`} label="Cron" value={w.cronExpression} onChange={(v) => set('cronExpression', orNull(v))} />
      <p className="in-note sub">{parsed === null ? 'not scheduled' : 'text' in parsed ? parsed.text : w.cronExpression}</p>
      <Sec>Related</Sec>
      <Ro><Row k="Location">{locationText(w.at)}</Row></Ro>
      <Sec>Entry steps</Sec>
      <div className="chips">
        {w.entryStepIds.length === 0 && <span className="none">none</span>}
        {w.entryStepIds.map((sid) => (
          <span key={sid} className="chip">
            <i style={{ background: conditionStyle(state.steps[sid]?.entryCondition ?? 0).colour }} />{stepName(state, sid)}
            <button type="button" className="chip-x" aria-label={`Remove entry ${stepName(state, sid)}`} onClick={() => edit((b) => removeEntries(b, [[id, sid]]))}>✕</button>
          </span>
        ))}
      </div>
      <Sec>{`Caches · ${w.cacheIds.length}`}</Sec>
      <div className="chips">
        {w.cacheIds.map((cid) => (
          <span key={cid} className="chip">
            ⛁ {state.caches[cid]?.name ?? cid}
            <button type="button" className="chip-x" aria-label={`Remove cache ${state.caches[cid]?.name ?? cid}`} onClick={() => edit((b) => unlinkCaches(b, [[id, cid]]))}>✕</button>
          </span>
        ))}
      </div>
      <p className="in-note">Drag from the triangle&apos;s back to any cache to link another; ✕ unlinks.</p>
      <Sec>Assignments</Sec>
      <div data-testid="assignments">
        {assignments.length === 0 && <p className="none">No assignments.</p>}
        {assignments.map((a, i) => (
          <div key={`${id}:${i}`} className="in-assign">
            <b>{stepName(state, a.stepId)}</b>
            <JsonField key={`${id}:${i}:payload`} label={`Payload · ${stepName(state, a.stepId)}`} value={a.payload} saved={base.assignments[a.id]?.payload}
              onChange={(v) => edit((b) => { const cur = b.workflows[id]?.assignmentIds[i]; return cur ? setAssignmentPayload(b, id, cur, v, newId) : b; }, `field:${id}:${i}:payload`)} />
            <PayloadCheckNote state={state} stepId={a.stepId} payload={a.payload} />
            <button type="button" className="pbtn in-act" onClick={() => edit((b) => removeAssignment(b, id, a.id))}>Delete</button>
          </div>
        ))}
      </div>
      <Sec>Payload keys in its stream</Sec>
      {stream.length === 0 ? <p className="none">No payloads in its stream.</p> : (
        <Ro>{stream.map(({ sid, a }) => <Row key={sid} k={stepName(state, sid)}>{keysText(a.payload)}</Row>)}</Ro>
      )}
    </>
  );
}
