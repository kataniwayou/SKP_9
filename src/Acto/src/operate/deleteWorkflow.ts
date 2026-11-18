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
 * Any refusal (a running workflow, say) goes to Output with BaseAPI's message; null, and the board is untouched.
 */
export async function prepareDelete(api: StudioApi, store: BoardStore, output: OutputStore, wf: Id): Promise<DeletePlan | null> {
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
      if (!ar || !linkedBy(base, a).every((x) => x === wf) || !linkedBy(present, a).every((x) => x === wf)) continue;
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
