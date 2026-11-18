import type { StudioApi } from '../api/client';
import { describeError } from '../api/describeError';
import { SAVING_REFUSAL, type BoardStore } from '../design/boardStore';
import type { ModelChange } from '../design/changes';
import { linkedBy } from '../design/payloads';
import { nameOf, reportFailures } from '../design/saveBoard';
import type { Id } from '../model/graph';
import type { OutputStore } from '../output/outputStore';

export interface DeletePlan { workflowId: Id; changes: ModelChange[]; lines: string[]; assignmentIds: Id[] }

/**
 * Delete up to the confirm: `delete workflows/<id>` plus each assignment no other workflow links, put to BaseAPI's dry run.
 * `gone`: workflows deleted before this one in the same run (several triangles); an assignment only they and this one
 * link goes with this one, the last of them to be deleted. Any refusal (a running workflow, say) goes to Output with
 * BaseAPI's message; null, and the board is untouched.
 */
export async function prepareDelete(api: StudioApi, store: BoardStore, output: OutputStore, wf: Id, gone: readonly Id[] = []): Promise<DeletePlan | null> {
  if (store.saving()) { output.log(SAVING_REFUSAL, 'warn'); return null; }
  const base = store.base();
  const boards = [base, store.state()];
  const name = nameOf(boards, 'workflows', wf);
  const row = base.workflows[wf];
  const changes: ModelChange[] = [];
  const lines: string[] = [`workflow ${name}`];
  const assignmentIds: Id[] = [];
  const present = store.state();
  if (row) {
    changes.push({ op: 'delete', table: 'workflows', id: wf, ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}) });
    for (const a of row.assignmentIds) {
      const ar = base.assignments[a];
      // in use while any other workflow links it, in base or in the unsaved board
      const goes = (x: Id) => x === wf || gone.includes(x);
      if (!ar || !linkedBy(base, a).every(goes) || !linkedBy(present, a).every(goes)) continue;
      assignmentIds.push(a);
      changes.push({ op: 'delete', table: 'assignments', id: a, ...(ar.updatedAt ? { updatedAt: ar.updatedAt } : {}) });
      lines.push(`assignment ${ar.name}`);
    }
  }
  const plan: DeletePlan = { workflowId: wf, changes, lines, assignmentIds };
  if (changes.length === 0) return plan; // never saved: nothing for BaseAPI to refuse
  // the dry run holds the board like a Save does: no Save and no edit until BaseAPI has answered
  store.setSaving(true);
  try {
    const dry = await api.validateModel(changes);
    if (!dry.ok) { output.log(`${name}: not deleted — ${describeError(dry.error)}`, 'error'); return null; }
    if (dry.value.ok !== true) {
      const map = reportFailures(dry.value.results, boards, output);
      if (map.size === 0) output.log(`${name}: not deleted — BaseAPI refused it`, 'error');
      return null;
    }
    return plan;
  } finally {
    store.setSaving(false);
  }
}

/** The real run. Applied: the workflow and the assignments that went with it leave the board and its base; steps and caches stay. */
export async function commitDelete(api: StudioApi, store: BoardStore, output: OutputStore, plan: DeletePlan): Promise<boolean> {
  if (store.saving()) { output.log(SAVING_REFUSAL, 'warn'); return false; }
  const boards = [store.base(), store.state()];
  const name = nameOf(boards, 'workflows', plan.workflowId);
  if (plan.changes.length > 0) {
    // the apply holds the board like a Save does, so a Save never diffs a base this delete is changing (and vice versa)
    store.setSaving(true);
    try {
      const res = await api.applyModel(plan.changes);
      if (!res.ok) { output.log(`${name}: not deleted — ${describeError(res.error)}`, 'error'); return false; }
      if (res.value.applied !== true) {
        const map = reportFailures(res.value.results, boards, output);
        if (map.size === 0) output.log(`${name}: not deleted — BaseAPI refused it`, 'error');
        return false;
      }
    } finally {
      store.setSaving(false);
    }
  }
  // dropWorkflow takes the workflow and its unshared assignments out of the base rows as well as every history state
  store.dropWorkflow(plan.workflowId, plan.assignmentIds);
  output.log(`Deleted ${plan.lines.join(', ')}. Its steps and caches stay`, 'ok');
  return true;
}

/**
 * Delete of several triangles up to their one confirm: each dry run in turn (each holds the board like a Save). A
 * refused one (a running workflow, say) is reported in Output by its own dry run and left out; the rest are planned.
 * An assignment linked only by workflows of this delete goes with the last of them that links it (deleted in order, the
 * others are gone by then), so it is deleted exactly once.
 */
export async function prepareDeletes(api: StudioApi, store: BoardStore, output: OutputStore, ids: readonly Id[]): Promise<DeletePlan[]> {
  const plans: DeletePlan[] = [];
  for (const wf of ids) {
    // the ones planned before it are deleted before it; one after it still links a shared row when this one goes
    const plan = await prepareDelete(api, store, output, wf, plans.map((p) => p.workflowId));
    if (plan) plans.push(plan);
  }
  return plans;
}

/** The real runs, one by one: a refusal of one is reported in Output and the rest still go. The ids deleted. */
export async function commitDeletes(api: StudioApi, store: BoardStore, output: OutputStore, plans: readonly DeletePlan[]): Promise<Id[]> {
  const gone: Id[] = [];
  for (const plan of plans) {
    try {
      if (await commitDelete(api, store, output, plan)) gone.push(plan.workflowId);
    } catch (e) {
      const name = nameOf([store.base(), store.state()], 'workflows', plan.workflowId);
      output.log(`${name}: not deleted — ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }
  return gone;
}
