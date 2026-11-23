import type { StudioApi } from '../api/client';
import { describeError } from '../api/describeError';
import type { BoardStore } from '../design/boardStore';
import { affectedWorkflows } from '../design/changes';
import type { LiveStore } from '../live/liveClient';
import { statusOf } from '../live/liveState';
import type { Id } from '../model/graph';
import type { OutputStore } from '../output/outputStore';

export const RUN_TIMEOUT_MS = 30_000;
export type RunOp = 'start' | 'stop';

/** Per workflow, how many Start/Stop presses were sent: a timer only speaks for the latest press. */
const presses = new Map<Id, number>();

/**
 * Start or Stop acts on the workflow BaseAPI holds, never on the drawing (the names come from the board). Output logs the press and BaseAPI's answer;
 * that it runs or stopped is the liveness store's own line (watchTransitions). An accepted press the live set has not
 * agreed with after RUN_TIMEOUT_MS is reported in red, unless a later Start/Stop of that workflow was pressed by then;
 * a live set that is still checking or unknown cannot confirm either way, and says that instead.
 */
export async function runWorkflow(api: StudioApi, store: BoardStore, output: OutputStore, live: LiveStore,
  workflowId: Id, op: RunOp, later: (run: () => void, ms: number) => void = (run, ms) => { setTimeout(run, ms); },
): Promise<'requested' | 'refused' | 'failed'> {
  const base = store.base();
  const present = store.state();
  const name = present.workflows[workflowId]?.name ?? base.workflows[workflowId]?.name ?? workflowId;
  const verb = op === 'start' ? 'Start' : 'Stop';
  if (!base.workflows[workflowId]) {
    output.log(`${name}: not saved yet — BaseAPI has no such workflow`, 'warn');
    return 'refused';
  }
  if (op === 'start' && affectedWorkflows(base, present).includes(workflowId)) output.log(`${name}: started the saved workflow; your unsaved changes are not part of this run`, 'warn');
  output.log(`${name}: ${verb} requested`);
  const press = (presses.get(workflowId) ?? 0) + 1;
  presses.set(workflowId, press);
  const answer = await (op === 'start' ? api.startWorkflow(workflowId) : api.stopWorkflow(workflowId));
  if (!answer.ok) {
    output.log(answer.error.kind === 'unprocessable'
      ? `${name}: ${verb} refused — ${answer.error.detail}`
      : `${name}: ${verb} failed — ${describeError(answer.error)}`, 'error');
    // the start names its first problem only: the workflow's check lists them all and sets the count [user, 2026-11-23 rev 2]
    if (op === 'start' && answer.error.kind === 'unprocessable') {
      const before = store.state();
      const check = await api.validateWorkflow(workflowId);
      // an edit meanwhile clears the count; the check describes the stored version, so it would put back a stale one
      const editedMeanwhile = affectedWorkflows(before, store.state()).includes(workflowId);
      if (check.ok && !editedMeanwhile) {
        const problems = check.value.problems ?? [];
        for (const p of problems) output.log(`${name}: ${p.title ?? p.gate ?? 'problem'} — ${p.detail ?? ''}`, 'warn');
        store.setProblems(workflowId, problems.length);
      }
    }
    return 'failed';
  }
  if (op === 'start') store.setProblems(workflowId, 0);
  const want = op === 'start' ? 'running' : 'stopped';
  later(() => {
    if (presses.get(workflowId) !== press) return;
    const now = statusOf(live.getState(), workflowId);
    if (now === want) return;
    const s = RUN_TIMEOUT_MS / 1000;
    output.log(now === 'running' || now === 'stopped'
      ? `${name}: ${verb} accepted, but it is still not ${want} after ${s} s`
      : `${name}: ${verb} accepted, but it could not be confirmed after ${s} s`, 'error');
  }, RUN_TIMEOUT_MS);
  return 'requested';
}
