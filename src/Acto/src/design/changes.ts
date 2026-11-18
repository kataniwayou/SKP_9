import type { CacheCreateDto, CacheUpdateDto, ProcessorUpdateDto, SchemaCreateDto, StepCreateDto, StepUpdateDto, WorkflowCreateDto, WorkflowUpdateDto } from '../api/types';
import type { Id } from '../model/graph';
import type { AssignmentRow, BoardState, CacheRow, ProcessorRow, SchemaRow, StepRow, WorkflowRow } from './board';
import { deepEqual, reachOf } from './board';

export type Table = 'workflows' | 'steps' | 'caches' | 'assignments' | 'processors' | 'schemas';
export interface ModelChange { op: 'create' | 'update' | 'delete'; table: Table; id: Id; row?: object; updatedAt?: string }

type Rows = Record<Id, { updatedAt: string | null }>;
interface Diff { created: Id[]; updated: Id[]; deleted: Id[] }

const TABLES: readonly Table[] = ['workflows', 'steps', 'caches', 'assignments', 'processors', 'schemas'];
const KEY: Record<Table, string> = {
  workflows: 'workflow', steps: 'step', caches: 'cache', assignments: 'assignment', processors: 'processor', schemas: 'schema',
};

const minusStamp = (r: object) => ({ ...r, updatedAt: undefined });

/** Created: unstamped and not in base. Updated: in cur and (absent from base, or different). Deleted: in base, gone from cur. */
function diffTable(table: Table, base: BoardState, cur: BoardState): Diff {
  const b = base[table] as Rows;
  const c = cur[table] as Rows;
  const out: Diff = { created: [], updated: [], deleted: [] };
  for (const id of Object.keys(c)) {
    const row = c[id]!;
    if (!(id in b)) {
      // processors are never created: a processor missing from base is treated like any restored stamped row
      if (row.updatedAt === null && table !== 'processors') out.created.push(id);
      else out.updated.push(id);
    } else if (!deepEqual(minusStamp(b[id]!), minusStamp(row))) out.updated.push(id);
  }
  if (table !== 'processors') for (const id of Object.keys(b)) if (!(id in c)) out.deleted.push(id);
  return out;
}

const loc = (at: { x: number; y: number } | null) => ({ boardX: at ? at.x : null, boardY: at ? at.y : null });

const workflowBody = (w: WorkflowRow): WorkflowCreateDto & WorkflowUpdateDto => ({
  name: w.name, version: w.version, description: w.description, cronExpression: w.cronExpression,
  entryStepIds: [...w.entryStepIds], assignmentIds: [...w.assignmentIds], cacheIds: [...w.cacheIds], ...loc(w.at),
});
const stepBody = (s: StepRow): StepCreateDto & StepUpdateDto => ({
  name: s.name, version: s.version, description: s.description, processorId: s.processorId as string,
  nextStepIds: [...s.nextStepIds], entryCondition: s.entryCondition as StepCreateDto['entryCondition'], ...loc(s.at),
});
const cacheBody = (c: CacheRow): CacheCreateDto & CacheUpdateDto => ({
  name: c.name, version: c.version, description: c.description, root: c.root, items: c.items, ...loc(c.at),
});
const assignmentBody = (a: AssignmentRow) => ({
  name: a.name, version: a.version, description: a.description, stepId: a.stepId, payload: a.payload,
});
const processorBody = (p: ProcessorRow): ProcessorUpdateDto => ({
  name: p.name, version: p.version, description: p.description, sourceHash: p.sourceHash, instanceId: p.instanceId,
  inputSchemaId: p.inputSchemaId, outputSchemaId: p.outputSchemaId, configSchemaId: p.configSchemaId,
});
const schemaBody = (s: SchemaRow): SchemaCreateDto => ({
  name: s.name, version: s.version, description: s.description, definition: s.definition ?? null,
});

const BODY: Record<Table, (r: never) => object> = {
  workflows: workflowBody as (r: never) => object, steps: stepBody as (r: never) => object, caches: cacheBody as (r: never) => object,
  assignments: assignmentBody as (r: never) => object, processors: processorBody as (r: never) => object, schemas: schemaBody as (r: never) => object,
};

export function boardChanges(base: BoardState, cur: BoardState): ModelChange[] {
  const d = Object.fromEntries(TABLES.map((t) => [t, diffTable(t, base, cur)])) as Record<Table, Diff>;
  const body = (t: Table, id: Id) => BODY[t](cur[t][id] as never);
  const create = (t: Table, id: Id, row?: object): ModelChange => ({ op: 'create', table: t, id, row: row ?? body(t, id) });
  const update = (t: Table, id: Id): ModelChange => {
    const stamp = (cur[t][id] as { updatedAt: string | null }).updatedAt;
    return { op: 'update', table: t, id, row: body(t, id), ...(stamp ? { updatedAt: stamp } : {}) };
  };
  const remove = (t: Table, id: Id): ModelChange => {
    const stamp = (base[t][id] as { updatedAt: string | null }).updatedAt;
    return { op: 'delete', table: t, id, ...(stamp ? { updatedAt: stamp } : {}) };
  };

  const out: ModelChange[] = [];
  const newSteps = new Set(d.steps.created);

  d.schemas.created.forEach((id) => out.push(create('schemas', id)));
  d.caches.created.forEach((id) => out.push(create('caches', id)));
  const lateWires: Id[] = [];
  for (const id of d.steps.created) {
    const s = cur.steps[id]!;
    const persisted = s.nextStepIds.filter((n) => !newSteps.has(n));
    if (persisted.length !== s.nextStepIds.length) lateWires.push(id);
    out.push(create('steps', id, { ...stepBody(s), nextStepIds: persisted }));
  }
  d.assignments.created.forEach((id) => out.push(create('assignments', id)));
  d.workflows.created.forEach((id) => out.push(create('workflows', id)));

  d.schemas.updated.forEach((id) => out.push(update('schemas', id)));
  d.processors.updated.forEach((id) => out.push(update('processors', id)));
  d.steps.updated.forEach((id) => out.push(update('steps', id)));
  // a created step that names created steps gets its full wires now; it has no stamp to check
  lateWires.forEach((id) => out.push({ op: 'update', table: 'steps', id, row: stepBody(cur.steps[id]!) }));
  d.caches.updated.forEach((id) => out.push(update('caches', id)));
  d.assignments.updated.forEach((id) => out.push(update('assignments', id)));
  d.workflows.updated.forEach((id) => out.push(update('workflows', id)));

  d.assignments.deleted.forEach((id) => out.push(remove('assignments', id)));
  // a deleted step goes before the deleted steps it wires into
  const gone = new Set(d.steps.deleted);
  const placed = new Set<Id>();
  const visit = (id: Id) => {
    if (placed.has(id)) return;
    placed.add(id);
    for (const [other, row] of Object.entries(base.steps)) if (gone.has(other) && row.nextStepIds.includes(id)) visit(other);
    out.push(remove('steps', id));
  };
  d.steps.deleted.forEach(visit);
  d.caches.deleted.forEach((id) => out.push(remove('caches', id)));
  d.schemas.deleted.forEach((id) => out.push(remove('schemas', id)));
  return out;
}

/** Every row that is created, changed or deleted, once each: `step:<id>`, `cache:<id>`, ... */
export function changedKeys(base: BoardState, cur: BoardState): Set<string> {
  const keys = new Set<string>();
  for (const t of TABLES) {
    const d = diffTable(t, base, cur);
    for (const id of [...d.created, ...d.updated, ...d.deleted]) keys.add(`${KEY[t]}:${id}`);
  }
  return keys;
}

/** Workflows (still on the board) whose row changed, whose linked payload rows changed, or that reach a changed step before or after. */
export function affectedWorkflows(base: BoardState, cur: BoardState): Id[] {
  const dw = diffTable('workflows', base, cur);
  const touchedWf = new Set([...dw.created, ...dw.updated]);
  const da = diffTable('assignments', base, cur);
  const touchedAssignments = new Set([...da.created, ...da.updated, ...da.deleted]);
  const ds = diffTable('steps', base, cur);
  const touchedSteps = new Set([...ds.created, ...ds.updated, ...ds.deleted]);

  const dc = diffTable('caches', base, cur);
  const touchedCaches = new Set([...dc.created, ...dc.updated, ...dc.deleted]);
  const touchedProcessors = new Set(diffTable('processors', base, cur).updated);
  const dsc = diffTable('schemas', base, cur);
  const touchedSchemas = new Set([...dsc.created, ...dsc.updated, ...dsc.deleted]);
  // a step whose processor row changed, or whose processor points at a created/changed schema row
  const processorTouched = (b: BoardState, stepId: Id) => {
    const pid = b.steps[stepId]?.processorId;
    const p = pid ? b.processors[pid] : undefined;
    if (!pid || !p) return false;
    return touchedProcessors.has(pid) ||
      [p.inputSchemaId, p.outputSchemaId, p.configSchemaId].some((x) => x !== null && touchedSchemas.has(x));
  };

  return Object.keys(cur.workflows).filter((id) => {
    if (touchedWf.has(id)) return true;
    const caches = [...cur.workflows[id]!.cacheIds, ...(base.workflows[id]?.cacheIds ?? [])];
    if (caches.some((c) => touchedCaches.has(c))) return true;
    for (const [bd, reach] of [[cur, reachOf(cur, id)], [base, reachOf(base, id)]] as const)
      for (const sid of reach) if (processorTouched(bd, sid)) return true;
    const links = [...cur.workflows[id]!.assignmentIds, ...(base.workflows[id]?.assignmentIds ?? [])];
    if (links.some((a) => touchedAssignments.has(a))) return true;
    for (const s of [...reachOf(cur, id), ...reachOf(base, id)]) if (touchedSteps.has(s)) return true;
    return false;
  });
}
