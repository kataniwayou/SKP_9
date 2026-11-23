import { conditionStyle } from '../../board/wires';
import { reachOf } from '../../design/board';
import { removeEntries, setWorkflowField, unlinkCaches } from '../../design/edits';
import { assignmentsOf } from '../../design/payloads';
import { useWorkflowStatus } from '../../live/LiveContext';
import { payloadKeyCount } from '../../model/assignments';
import { cronText } from '../../model/cronText';
import type { Id } from '../../model/graph';
import { CronField, Ro, Row, Sec } from '../fields';
import { EntityBase, LinkChip, locationText, metaOfRow, orNull, stepName, type Ctx } from './shared';

const keysText = (payload: string) => {
  const n = payloadKeyCount(payload);
  return n === null ? '◆ payload' : `◆ ${n} key${n === 1 ? '' : 's'}`;
};

/**
 * A workflow: its fields, then its entry steps, caches and assignments as chips (the step's keys, and whether the workflow
 * reaches it). Every chip links to its item [user, 2026-11-19]: an entry step or an assignment selects this workflow with
 * that step (as a Ctrl+click would) and opens Step (an assignment: Step › this workflow's assignment); a cache is selected
 * alone. ✕ only on connections: it removes the entry arrow or the cache link. An assignment has no ✕ (Step › workflow removes it).
 */
export function WorkflowTab({ state, edit, id, go }: Ctx & { id: Id }) {
  const status = useWorkflowStatus(id);
  const w = state.workflows[id];
  if (!w) return null;
  const set = (key: 'name' | 'version' | 'description' | 'cronExpression', v: string | null) =>
    edit((b) => setWorkflowField(b, id, key, v), `field:${id}:${key}`);
  const parsed = w.cronExpression ? cronText(w.cronExpression) : null;
  const assignments = assignmentsOf(state, id);
  const run = status === 'running' ? 'running' : status === 'stopped' ? 'stopped' : 'checking…';
  const reach = reachOf(state, id);
  const dot = (sid: Id) => conditionStyle(state.steps[sid]?.entryCondition ?? 0).colour;
  const withStep = (sid: Id) => [{ kind: 'workflow' as const, id }, { kind: 'step' as const, id: sid }];
  const cacheName = (cid: Id) => state.caches[cid]?.name ?? cid;
  return (
    <>
      <EntityBase head={`${w.name} ${w.version}`} kind={`workflow · ${run}`} k={id} row={w} meta={metaOfRow(w)} set={set} />
      <CronField key={`${id}:cron`} value={w.cronExpression} onChange={(v) => set('cronExpression', orNull(v))} />
      <p className="in-note sub">{parsed === null ? 'not scheduled' : 'text' in parsed ? parsed.text : w.cronExpression}</p>
      <Sec>Related</Sec>
      <Ro><Row k="Location">{locationText(w.at)}</Row></Ro>
      <Sec>Entry steps</Sec>
      <div className="chips">
        {w.entryStepIds.length === 0 && <span className="none">none</span>}
        {w.entryStepIds.map((sid) => (
          <LinkChip key={sid} dot={dot(sid)} name={stepName(state, sid)} openLabel={`Open entry ${stepName(state, sid)}`}
            {...(go ? { onOpen: () => go(withStep(sid), { tab: 'step' }) } : {})}
            removeLabel={`Remove entry ${stepName(state, sid)}`} onRemove={() => edit((b) => removeEntries(b, [[id, sid]]))} />
        ))}
      </div>
      <Sec>{`Caches · ${w.cacheIds.length}`}</Sec>
      <div className="chips">
        {w.cacheIds.map((cid) => (
          <LinkChip key={cid} icon={<span className="chip-ico">⛁</span>} name={cacheName(cid)} openLabel={`Open cache ${cacheName(cid)}`}
            {...(go ? { onOpen: () => go([{ kind: 'cache', id: cid }]) } : {})}
            removeLabel={`Remove cache ${cacheName(cid)}`} onRemove={() => edit((b) => unlinkCaches(b, [[id, cid]]))} />
        ))}
      </div>
      <p className="in-note">Drag from the triangle&apos;s back to any cache to link another; ✕ unlinks.</p>
      <Sec>Assignments</Sec>
      <div data-testid="assignments">
        {assignments.length === 0 ? <p className="none">No assignments.</p> : (
          <div className="chips">
            {assignments.map((a) => {
              const name = stepName(state, a.stepId);
              return (
                <LinkChip key={a.id} className="in-assign" dot={dot(a.stepId)} name={name}
                  sub={`${keysText(a.payload)}${reach.has(a.stepId) ? '' : ' · not in its stream'}`} openLabel={`Open assignment ${name}`}
                  {...(go ? { onOpen: () => go(withStep(a.stepId), { tab: 'step', child: `assignment:${id}` }) } : {})} />
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
