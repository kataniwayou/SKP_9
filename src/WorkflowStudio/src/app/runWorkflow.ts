import type { StudioApi } from '../api/client';
import { describeError } from '../api/describeError';
import type { Id } from '../model/graph';
import { RUN_TIMEOUT_MS, runBlocked, type RunOp } from '../store/run';
import { startNote } from '../store/studioState';
import type { StudioStore } from '../store/studioStore';

let presses = 0;

/**
 * Start or Stop (2026-10-09): acts on the workflow BaseApi holds, never on the drawing. Output logs the press, BaseApi's
 * answer (a refusal in red, with BaseApi's reason) and, once the live poll agrees, that it runs or stopped; a Start with
 * an unsaved design says first that the design is not part of the run (and still starts). An accepted press the live set
 * has not agreed with after RUN_TIMEOUT_MS is reported in red (a start whose message is parked never appears there).
 * Does nothing when the press is not allowed now (`runBlocked`).
 */
export async function runWorkflow(
  api: StudioApi, store: StudioStore, workflowId: Id, op: RunOp,
  now: () => Date = () => new Date(), later: (run: () => void, ms: number) => void = (run, ms) => { setTimeout(run, ms); },
): Promise<void> {
  const doc = store.getState().docs.find((d) => d.workflowId === workflowId);
  if (!doc || runBlocked(doc, op) !== null) return;
  const token = `${op}-${++presses}-${now().getTime()}`;
  const note = op === 'start' ? startNote(doc) : null;
  store.dispatch({ type: 'runRequested', workflowId, op, token, at: now().toISOString(), ...(note ? { note } : {}) });
  const answer = await (op === 'start' ? api.startWorkflow(workflowId) : api.stopWorkflow(workflowId));
  store.dispatch(answer.ok
    ? { type: 'runAnswered', workflowId, token, at: now().toISOString(), ok: true }
    : { type: 'runAnswered', workflowId, token, at: now().toISOString(), ok: false, message: describeError(answer.error) });
  if (answer.ok) later(() => store.dispatch({ type: 'runTimeout', workflowId, token, at: now().toISOString() }), RUN_TIMEOUT_MS);
}
