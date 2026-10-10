import type { ApiResult, StudioApi } from '../api/client';
import { describeError } from '../api/describeError';
import { designLogFromDto } from '../api/toModel';
import type { WorkflowDeleteOutcomeDto } from '../api/types';
import { runningOf } from '../live/liveState';
import type { Id } from '../model/graph';
import type { LineDraft } from '../store/output';
import { designDirty } from '../store/studioState';
import type { StudioStore } from '../store/studioStore';

/** How long the fresh liveness reading may take: none by then, the workflow cannot be proven stopped. */
export const FRESH_READING_MS = 5000;

/** What the warning shows before the user's Continue: the dry run's counts, and whether a draft is dropped. */
export interface DeletePlan {
  workflowId: Id;
  name: string;
  steps: number;
  assignments: number;
  caches: number;
  processors: number;
  /** The document has a design draft not saved: deleted, it is dropped. */
  dropsDraft: boolean;
}

export interface DeleteDeps {
  now?: () => Date;
  /** Resolves after `ms` (tests pass their own). */
  wait?: (ms: number) => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** BaseApi's own lines, as Output shows a Save's ("BaseApi · …"; a rolled-back change says so). */
function baseApiLines(dto: WorkflowDeleteOutcomeDto, at: string): LineDraft[] {
  return (designLogFromDto(dto) ?? []).map((l) => ({ at, text: `BaseApi · ${l.rolledBack ? '(rolled back) ' : ''}${l.message}`, level: l.level }));
}

/**
 * Workspace › Delete workflow…, up to the warning (the user's rules, 2026-10-10). First a liveness reading taken after
 * the request (`GET /orchestration/live` asked now; the status the studio already shows never counts): running, or no
 * reading within FRESH_READING_MS, and the deletion is refused. Then BaseApi's dry run, which reads the live set again
 * and does the whole deletion in a transaction it rolls back: refused, nothing more happens. Every step is logged in
 * Output under the workflow. The plan for the warning, or null when the deletion stops here.
 */
export async function prepareDelete(api: StudioApi, store: StudioStore, workflowId: Id, deps: DeleteDeps = {}): Promise<DeletePlan | null> {
  const now = deps.now ?? (() => new Date());
  const wait = deps.wait ?? sleep;
  const doc = store.getState().docs.find((d) => d.workflowId === workflowId);
  if (!doc) return null;
  const log = (text: string, level: 'info' | 'error' = 'info') => store.dispatch({ type: 'log', workflowId, lines: [{ at: now().toISOString(), text, level }] });

  log('Delete requested: reading the live set now (a reading from before the request does not count)');
  const reading = await Promise.race<ApiResult<unknown> | 'timeout'>([
    api.listLive().catch((e: unknown) => ({ ok: false as const, error: { kind: 'network' as const, message: String(e) } })),
    wait(FRESH_READING_MS).then(() => 'timeout' as const),
  ]);
  if (reading === 'timeout') {
    log(`Not deleted: could not confirm it is stopped (no liveness reading within ${FRESH_READING_MS / 1000} s)`, 'error');
    return null;
  }
  const running = runningOf(reading);
  if (running === null) {
    log(`Not deleted: could not confirm it is stopped (${reading.ok ? 'the live set could not be read' : describeError(reading.error)})`, 'error');
    return null;
  }
  if (running.has(workflowId.toLowerCase())) {
    log('Not deleted: it is running. Stop it first: deleted while running, it could never be stopped', 'error');
    return null;
  }
  log('Live set read now: not running. Dry run: BaseApi deletes it in a transaction and rolls back');

  const dry = await api.deleteWorkflow(workflowId, true);
  if (!dry.ok) {
    log(`Not deleted: the dry run got no answer (${describeError(dry.error)})`, 'error');
    return null;
  }
  const at = now().toISOString();
  store.dispatch({ type: 'log', workflowId, lines: baseApiLines(dry.value, at) });
  const errors = dry.value.errors ?? [];
  if (errors.length > 0) {
    log(`Not deleted: the dry run found ${count(errors.length, 'error')}`, 'error');
    return null;
  }
  const still = store.getState().docs.find((d) => d.workflowId === workflowId);
  return {
    workflowId, name: doc.name, steps: dry.value.steps ?? 0, assignments: dry.value.assignments ?? 0,
    caches: dry.value.caches ?? 0, processors: dry.value.processors ?? 0, dropsDraft: still ? designDirty(still) : false,
  };
}

/** Cancel on the warning: nothing was sent, the document stays as it was. */
export function cancelDelete(store: StudioStore, workflowId: Id, now: () => Date = () => new Date()): void {
  store.dispatch({ type: 'log', workflowId, lines: [{ at: now().toISOString(), text: 'Delete cancelled: nothing was sent; the workflow is as it was' }] });
}

/**
 * Continue on the warning: BaseApi's real run (it holds the start guard, reads the live set again, deletes and commits).
 * Deleted: the document closes and the workflow leaves the studio (`workflowDeleted`); true. Refused or no answer: red
 * lines, the document stays; false.
 */
export async function commitDelete(api: StudioApi, store: StudioStore, plan: DeletePlan, now: () => Date = () => new Date()): Promise<boolean> {
  const { workflowId, name } = plan;
  store.dispatch({ type: 'log', workflowId, lines: [{ at: now().toISOString(), text: 'Delete confirmed: BaseApi reads the live set again and deletes' }] });
  const answer = await api.deleteWorkflow(workflowId, false);
  const at = now().toISOString();
  if (!answer.ok) {
    store.dispatch({ type: 'log', workflowId, lines: [{ at, text: `Not deleted: BaseApi gave no answer (${describeError(answer.error)})`, level: 'error' }] });
    return false;
  }
  const lines = baseApiLines(answer.value, at);
  if (answer.value.applied !== true) {
    const errors = answer.value.errors?.length ?? 0;
    store.dispatch({ type: 'log', workflowId, lines: [...lines, { at, text: `Not deleted: ${count(errors, 'error')}`, level: 'error' }] });
    return false;
  }
  store.dispatch({
    type: 'workflowDeleted', workflowId, name,
    lines: [...lines, { at, text: `Deleted: the workflow, ${count(answer.value.steps ?? 0, 'step')} and ${count(answer.value.assignments ?? 0, 'assignment')}; its id is gone for good` }],
  });
  return true;
}
