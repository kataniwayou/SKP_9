import type { StudioApi } from '../api/client';
import { describeError } from '../api/describeError';
import { SAVING_REFUSAL, type BoardStore } from '../design/boardStore';
import type { ModelChange } from '../design/changes';
import { linkedBy } from '../design/payloads';
import { nameOf, reportFailures } from '../design/saveBoard';
import type { Id } from '../model/graph';
import type { OutputStore } from '../output/outputStore';

/**
 * An assignment this workflow shares only with workflows deleted before it in the same run: not in the dry run (BaseAPI
 * refuses deleting a linked assignment, and they still link it then); deleted with this workflow only when every one
 * of `with` really went.
 */
export interface SharedAssignment { id: Id; change: ModelChange; line: string; with: Id[] }

/** `shared`: see SharedAssignment; its lines are in `lines` (the confirm lists them), its changes are not in `changes`. */
export interface DeletePlan { workflowId: Id; changes: ModelChange[]; lines: string[]; assignmentIds: Id[]; shared?: SharedAssignment[] }

/**
 * Delete up to the confirm: `delete workflows/<id>` plus each assignment no other workflow links, put to BaseAPI's dry run.
 * `gone`: workflows deleted before this one in the same run (several triangles); an assignment only they and this one
 * link is this plan's `shared`: left out of the dry run, deleted with this one (the last of them) only if they all
 * went (commitDeletes). Any refusal (a running workflow, say) goes to Output with
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
  const shared: SharedAssignment[] = [];
  const present = store.state();
  if (row) {
    changes.push({ op: 'delete', table: 'workflows', id: wf, ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}) });
    for (const a of row.assignmentIds) {
      const ar = base.assignments[a];
      // in use while any other workflow links it, in base or in the unsaved board
      const goes = (x: Id) => x === wf || gone.includes(x);
      if (!ar || !linkedBy(base, a).every(goes) || !linkedBy(present, a).every(goes)) continue;
      const change: ModelChange = { op: 'delete', table: 'assignments', id: a, ...(ar.updatedAt ? { updatedAt: ar.updatedAt } : {}) };
      const line = `assignment ${ar.name}`;
      lines.push(line);
      const others = [...new Set([...linkedBy(base, a), ...linkedBy(present, a)])].filter((x) => x !== wf);
      if (others.length > 0) { shared.push({ id: a, change, line, with: others }); continue; }
      assignmentIds.push(a);
      changes.push(change);
    }
  }
  const plan: DeletePlan = { workflowId: wf, changes, lines, assignmentIds, ...(shared.length > 0 ? { shared } : {}) };
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
 * An assignment linked only by workflows of this delete is the `shared` of the last of them that links it: not in any dry
 * run, and deleted (once) with that last one when the others really went.
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

/**
 * The real runs, one by one: a refusal of one is reported in Output and the rest still go. A plan's shared assignment
 * is deleted with it only when every other workflow linking it went; otherwise it stays (still linked), silently. The
 * ids deleted.
 */
export async function commitDeletes(api: StudioApi, store: BoardStore, output: OutputStore, plans: readonly DeletePlan[]): Promise<Id[]> {
  const gone: Id[] = [];
  for (const planned of plans) {
    const take = (planned.shared ?? []).filter((x) => x.with.every((w) => gone.includes(w)));
    // the lines of shared assignments that stay leave the Deleted message (one occurrence each: names may repeat)
    const lines = [...planned.lines];
    for (const x of planned.shared ?? []) {
      if (take.includes(x)) continue;
      const i = lines.lastIndexOf(x.line);
      if (i >= 0) lines.splice(i, 1);
    }
    const plan: DeletePlan = {
      workflowId: planned.workflowId,
      changes: [...planned.changes, ...take.map((x) => x.change)],
      lines,
      assignmentIds: [...planned.assignmentIds, ...take.map((x) => x.id)],
    };
    try {
      if (await commitDelete(api, store, output, plan)) gone.push(plan.workflowId);
    } catch (e) {
      const name = nameOf([store.base(), store.state()], 'workflows', plan.workflowId);
      output.log(`${name}: not deleted — ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }
  return gone;
}
