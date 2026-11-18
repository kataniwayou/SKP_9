import { conditionStyle } from '../../board/wires';
import { reachOf } from '../../design/board';
import { removeEntries, setWorkflowField, unlinkCaches } from '../../design/edits';
import { assignmentsOf } from '../../design/payloads';
import { useWorkflowStatus } from '../../live/LiveContext';
import { payloadKeyCount } from '../../model/assignments';
import { cronText } from '../../model/cronText';
import type { Id } from '../../model/graph';
import { Ro, Row, Sec, TextField } from '../fields';
import { EntityBase, locationText, metaOfRow, orNull, stepName, type Ctx } from './shared';

const keysText = (payload: string) => {
  const n = payloadKeyCount(payload);
  return n === null ? '◆ payload' : `◆ ${n} key${n === 1 ? '' : 's'}`;
};

/** A workflow: its fields, entry steps and caches as chips (✕ removes), and its assignments (read-only: the step's keys, and whether the workflow reaches it). */
export function WorkflowTab({ state, edit, id }: Ctx & { id: Id }) {
  const status = useWorkflowStatus(id);
  const w = state.workflows[id];
  if (!w) return null;
  const set = (key: 'name' | 'version' | 'description' | 'cronExpression', v: string | null) =>
    edit((b) => setWorkflowField(b, id, key, v), `field:${id}:${key}`);
  const parsed = w.cronExpression ? cronText(w.cronExpression) : null;
  const assignments = assignmentsOf(state, id);
  const run = status === 'running' ? 'running' : status === 'stopped' ? 'stopped' : 'checking…';
  const reach = reachOf(state, id);
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
        {assignments.length === 0 ? <p className="none">No assignments.</p> : (
          <Ro>
            {assignments.map((a, i) => (
              <Row key={`${id}:${i}`} k={stepName(state, a.stepId)} className="in-assign">
                {keysText(a.payload)}{reach.has(a.stepId) ? '' : ' · not in its stream'}
              </Row>
            ))}
          </Ro>
        )}
      </div>
    </>
  );
}
