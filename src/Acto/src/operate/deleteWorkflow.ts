import type { ApiResult, StudioApi } from '../api/client';
import { describeError } from '../api/describeError';
import type { WorkflowDeleteOutcomeDto } from '../api/types';
import type { BoardStore } from '../design/boardStore';
import { runningOf } from '../live/liveState';
import type { Id } from '../model/graph';
import type { OutputStore } from '../output/outputStore';

/** How long the fresh live reading may take: none by then, the workflow cannot be proven stopped. */
export const FRESH_READING_MS = 5000;

export interface DeletePlan {
  ids: Id[];
  names: string[];
  steps: number;
  assignments: number;
  caches: number;
  processors: number;
  /** Ids in `ids` BaseAPI has never seen: discarded here, no request. */
  neverSaved: Id[];
}

const SAVING = 'it is saving, wait for it to finish';
const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const goes = (steps: number, assignments: number) => `${count(steps, 'step')}, ${count(assignments, 'assignment')}`;
const messagesOf = (dto: WorkflowDeleteOutcomeDto): string => {
  const ms = (dto.errors ?? []).map((e) => e.message).filter((m): m is string => typeof m === 'string' && m !== '');
  return ms.length > 0 ? ms.join('; ') : 'BaseAPI refused it';
};

/**
 * Delete up to the confirm: a live reading taken now (a status already shown never counts) raced against
 * FRESH_READING_MS, `running` refuses; then BaseAPI's dry run, which refuses on errors. Several workflows are all or
 * nothing (R4): any refusal returns null, each logged under its workflow's name. Never-saved ones need no request.
 * One that is saving is refused first, before any request.
 */
export async function prepareDelete(api: StudioApi, store: BoardStore, output: OutputStore, ids: Id[],
  wait: (ms: number) => Promise<void> = sleep): Promise<DeletePlan | null> {
  const nameOf = (id: Id) => store.entry(id)?.history.present.fields.name ?? id;
  // a save in flight would land after the delete and bring the workflow back
  const saving = ids.filter((id) => store.entry(id)?.saving === true);
  if (saving.length > 0) {
    for (const id of saving) output.log(`${nameOf(id)}: not deleted — ${SAVING}`, 'error');
    return null;
  }
  const unsavedIds = ids.filter((id) => store.entry(id)?.base === null);
  const savedIds = ids.filter((id) => !unsavedIds.includes(id));
  const plan: DeletePlan = { ids, names: ids.map(nameOf), steps: 0, assignments: 0, caches: 0, processors: 0, neverSaved: unsavedIds };
  if (savedIds.length === 0) return plan;

  let refused = false;
  const refuse = (id: Id, why: string) => { refused = true; output.log(`${nameOf(id)}: not deleted — ${why}`, 'error'); };

  const reading = await Promise.race<ApiResult<unknown> | 'timeout'>([
    Promise.resolve().then(() => api.listLive()).catch((e: unknown) => ({ ok: false as const, error: { kind: 'network' as const, message: String(e) } })),
    wait(FRESH_READING_MS).then(() => 'timeout' as const),
  ]);
  if (reading === 'timeout') {
    for (const id of savedIds) refuse(id, `could not confirm it is stopped (no live reading within ${FRESH_READING_MS / 1000} s)`);
    return null;
  }
  const running = runningOf(reading);
  if (running === null) {
    for (const id of savedIds) refuse(id, `could not confirm it is stopped (${reading.ok ? 'the live set could not be read' : describeError(reading.error)})`);
    return null;
  }
  for (const id of savedIds) {
    if (running.has(id.toLowerCase())) { refuse(id, 'it is running. Stop it first'); continue; }
    const dry = await api.deleteWorkflow(id, true);
    if (!dry.ok) { refuse(id, `the dry run got no answer (${describeError(dry.error)})`); continue; }
    if ((dry.value.errors ?? []).length > 0) { refuse(id, messagesOf(dry.value)); continue; }
    plan.steps += dry.value.steps ?? 0;
    plan.assignments += dry.value.assignments ?? 0;
    plan.caches += dry.value.caches ?? 0;
    plan.processors += dry.value.processors ?? 0;
  }
  return refused ? null : plan;
}

export function confirmText(plan: DeletePlan): string {
  const several = plan.ids.length > 1;
  const subject = several ? `${plan.ids.length} workflows` : plan.names[0] ?? '';
  if (plan.neverSaved.length === plan.ids.length) {
    return several ? `Delete ${subject}? They were never saved.` : `Delete ${subject}? It was never saved.`;
  }
  return `${goes(plan.steps, plan.assignments)} go. Delete ${subject}?`;
}

/** The real run. Returns the ids that are gone; a refusal or no answer leaves its frame and says why in Output. */
export async function commitDelete(api: StudioApi, store: BoardStore, output: OutputStore, plan: DeletePlan): Promise<Id[]> {
  const gone: Id[] = [];
  for (let i = 0; i < plan.ids.length; i++) {
    const id = plan.ids[i]!;
    const name = plan.names[i] ?? id;
    // a save may have started since the confirm was offered
    if (store.entry(id)?.saving === true) { output.log(`${name}: not deleted — ${SAVING}`, 'error'); continue; }
    if (plan.neverSaved.includes(id)) {
      store.remove(id); gone.push(id);
      output.log(`${name} discarded`, 'ok');
      continue;
    }
    const answer = await api.deleteWorkflow(id, false);
    if (!answer.ok) { output.log(`${name}: not deleted — ${describeError(answer.error)}`, 'error'); continue; }
    if (answer.value.applied !== true) { output.log(`${name}: not deleted — ${messagesOf(answer.value)}`, 'error'); continue; }
    store.remove(id); gone.push(id);
    output.log(`${name} deleted: ${goes(answer.value.steps ?? 0, answer.value.assignments ?? 0)}`, 'ok');
  }
  return gone;
}
