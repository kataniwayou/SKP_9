import type { BoardWorkflow } from '../board/loadBoard';
import type { Id } from '../model/graph';
import { deepEqual, type CacheFields, type CacheState, type StepState, type WorkflowState } from './state';

/** A step, processor or cache: the entities several workflows can show (a schema is changed through its processor). */
export type EntityKey = `step:${Id}` | `processor:${Id}` | `cache:${Id}`;

const sameStep = (a: StepState, b: StepState) =>
  a.name === b.name && a.version === b.version && a.description === b.description && a.entryCondition === b.entryCondition
  && a.processorId === b.processorId && a.nextStepIds.length === b.nextStepIds.length && a.nextStepIds.every((n, i) => n === b.nextStepIds[i]);

const fieldsOf = (c: CacheFields): CacheFields =>
  ({ name: c.name, version: c.version, description: c.description, root: c.root, items: c.items });
const sameCache = (a: CacheFields, b: CacheFields) => deepEqual(fieldsOf(a), fieldsOf(b));

/** What a cache in `cur` is diffed against: the same cache in `base`, else its fields as linked; a new cache is a change. */
function cacheChanged(c: CacheState, was: CacheState | undefined): boolean {
  if (was) return !sameCache(c, was);
  if (c.linked) return !sameCache(c, c.linked);
  return c.isNew;
}

/**
 * Entities whose stored fields differ: a step's fields, processorId, nextStepIds or deletion (not its position, nor
 * its leaving this workflow only);
 * a processor with a different ProcessorEdit; a cache's fields (not linking/unlinking). Against `null` (a workflow
 * never saved) everything it holds is new, and new things are held by it alone.
 */
export function changedEntities(base: WorkflowState | null, cur: WorkflowState): Set<EntityKey> {
  const out = new Set<EntityKey>();
  const bSteps = base?.steps ?? {};
  for (const [id, s] of Object.entries(cur.steps)) {
    const was = bSteps[id];
    if (!was || !sameStep(s, was)) out.add(`step:${id}`);
  }
  // a step that left `steps` without being deleted (removeStepHere) left this workflow only: the step is unchanged
  for (const id of Object.keys(bSteps)) if (!cur.steps[id] && id in cur.deletedSteps) out.add(`step:${id}`);
  const bp = base?.processors ?? {};
  const cp = cur.processors ?? {};
  if (bp !== cp) {
    for (const id of new Set([...Object.keys(bp), ...Object.keys(cp)])) {
      if (!deepEqual(bp[id], cp[id])) out.add(`processor:${id}`);
    }
  }
  const bCaches = base?.caches ?? {};
  for (const [id, c] of Object.entries(cur.caches)) if (cacheChanged(c, bCaches[id])) out.add(`cache:${id}`);
  return out;
}

/** For every step, processor and cache on the board, the workflows that show it (board order). */
export function holders(boards: BoardWorkflow[]): Map<EntityKey, Id[]> {
  const out = new Map<EntityKey, Id[]>();
  const add = (k: EntityKey, wf: Id) => { const l = out.get(k); if (!l) out.set(k, [wf]); else if (l[l.length - 1] !== wf) l.push(wf); };
  for (const b of boards) {
    const wf = b.graph.workflow.id;
    for (const id of b.stepIds) add(`step:${id}`, wf);
    for (const id of b.graph.processors.keys()) add(`processor:${id}`, wf);
    for (const id of b.graph.caches.keys()) add(`cache:${id}`, wf);
  }
  return out;
}

/** 'step extract', 'processor Analyst', 'cache rates': named as the first board holding it shows it. */
export function entityLabel(key: EntityKey, boards: BoardWorkflow[]): string {
  const i = key.indexOf(':');
  const kind = key.slice(0, i) as 'step' | 'processor' | 'cache';
  const id = key.slice(i + 1);
  for (const b of boards) {
    const e = kind === 'step' ? b.graph.steps.get(id) : kind === 'processor' ? b.graph.processors.get(id) : b.graph.caches.get(id);
    if (e) return `${kind} ${e.name}`;
  }
  return `${kind} ${id}`;
}

/** For a step delete in `wf`: its steps another workflow shows too, and those other workflows' names (board order). */
export function stepSharing(boards: BoardWorkflow[], wf: Id): { shared: Set<Id>; others: (stepId: Id) => string[] } {
  const held = holders(boards);
  const names = new Map(boards.map((b) => [b.graph.workflow.id, b.graph.workflow.name]));
  const shared = new Set<Id>();
  for (const id of boards.find((b) => b.graph.workflow.id === wf)?.stepIds ?? []) {
    if ((held.get(`step:${id}`)?.length ?? 0) > 1) shared.add(id);
  }
  return { shared, others: (id) => (held.get(`step:${id}`) ?? []).filter((w) => w !== wf).map((w) => names.get(w) ?? w) };
}
