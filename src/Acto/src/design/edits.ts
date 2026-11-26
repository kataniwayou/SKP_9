import type { Id, Processor } from '../model/graph';
import type { Point } from '../model/geometry';
import { NO_AUDIT, SLOT_FIELD } from './board';
import type { BoardState, CacheRow, Edit, ItemRef, SchemaCopy, SchemaRow, Slot, StepRow, WorkflowRow } from './board';
import { linkedBy } from './payloads';

const stepName = (b: BoardState, id: Id) => b.steps[id]?.name ?? id;

/** Studio's uniqueName: `base`, then `base-2`, `base-3`, … — the first not taken on the board. */
function uniqueName(names: Iterable<string>, base: string): string {
  const taken = new Set(names);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

export function addStep(b: BoardState, processor: Processor, at: Point, id: Id): BoardState {
  const step: StepRow = {
    id, name: uniqueName(Object.values(b.steps).map((x) => x.name), processor.name), version: '1.0.0', description: null, processorId: processor.id,
    nextStepIds: [], entryCondition: 1, at: { ...at }, updatedAt: null, ...NO_AUDIT,
  };
  return { ...b, steps: { ...b.steps, [id]: step } };
}

export function addCache(b: BoardState, at: Point, id: Id): BoardState {
  const cache: CacheRow = {
    id, name: uniqueName(Object.values(b.caches).map((c) => c.name), 'cache'), version: '1.0.0',
    description: null, root: '', items: '{}', at: { ...at }, updatedAt: null, ...NO_AUDIT,
  };
  return { ...b, caches: { ...b.caches, [id]: cache } };
}

export function addWorkflow(b: BoardState, at: Point, id: Id): BoardState {
  const wf: WorkflowRow = {
    id, name: uniqueName(Object.values(b.workflows).map((w) => w.name), 'untitled'), version: '1.0.0',
    description: null, entryStepIds: [], entryCrons: {}, assignmentIds: [], cacheIds: [], at: { ...at }, updatedAt: null, ...NO_AUDIT,
  };
  return { ...b, workflows: { ...b.workflows, [id]: wf } };
}

export function moveItems(b: BoardState, moved: { ref: ItemRef; at: Point }[]): BoardState {
  const next: BoardState = {
    ...b, steps: { ...b.steps }, caches: { ...b.caches }, workflows: { ...b.workflows }, schemas: { ...b.schemas }, processors: { ...b.processors },
  };
  for (const { ref, at } of moved) {
    const table = ref.kind === 'step' ? next.steps : ref.kind === 'cache' ? next.caches : ref.kind === 'workflow' ? next.workflows
      : ref.kind === 'schema' ? next.schemas : next.processors;
    const row = table[ref.id];
    if (row) (table as Record<Id, unknown>)[ref.id] = { ...row, at: { ...at } };
  }
  return next;
}

export function addWire(b: BoardState, from: Id, to: Id): Edit {
  const s = b.steps[from];
  if (!s) return { state: b };
  if (s.nextStepIds.includes(to)) return { refused: 'That wire already exists' };
  return { state: { ...b, steps: { ...b.steps, [from]: { ...s, nextStepIds: [...s.nextStepIds, to] } } } };
}

export function removeWires(b: BoardState, wires: [Id, Id][]): BoardState {
  const steps = { ...b.steps };
  for (const [from, to] of wires) {
    const s = steps[from];
    if (s) steps[from] = { ...s, nextStepIds: s.nextStepIds.filter((x) => x !== to) };
  }
  return { ...b, steps };
}

export function addEntry(b: BoardState, wf: Id, step: Id): Edit {
  const w = b.workflows[wf];
  if (!w) return { state: b };
  if (w.entryStepIds.includes(step)) return { refused: `${w.name} already starts at ${stepName(b, step)}` };
  return { state: { ...b, workflows: { ...b.workflows, [wf]: { ...w, entryStepIds: [...w.entryStepIds, step] } } } };
}

export function removeEntries(b: BoardState, pairs: [Id, Id][]): BoardState {
  const workflows = { ...b.workflows };
  for (const [wf, step] of pairs) {
    const w = workflows[wf];
    if (w) workflows[wf] = { ...w, entryStepIds: w.entryStepIds.filter((x) => x !== step), entryCrons: without(w.entryCrons, [step]) };
  }
  return { ...b, workflows };
}

/** The cron of one entry arrow, exactly as typed; null or an all-blank text clears it. A step that is not an entry of the workflow changes nothing. */
export function setEntryCron(b: BoardState, wf: Id, step: Id, cron: string | null): BoardState {
  const w = b.workflows[wf];
  if (!w || !w.entryStepIds.includes(step)) return b;
  // kept as typed (spaces included) while editing; it is trimmed where it leaves Acto (the save body) and where crons are compared
  const text = cron ?? '';
  const entryCrons = text.trim() === '' ? without(w.entryCrons, [step]) : { ...w.entryCrons, [step]: text };
  return { ...b, workflows: { ...b.workflows, [wf]: { ...w, entryCrons } } };
}

const without = (crons: Record<Id, string>, drop: Id[]): Record<Id, string> =>
  Object.fromEntries(Object.entries(crons).filter(([k]) => !drop.includes(k)));

export function linkCache(b: BoardState, wf: Id, cache: Id): Edit {
  const w = b.workflows[wf];
  if (!w) return { state: b };
  if (w.cacheIds.includes(cache)) return { refused: `${w.name} already uses ${b.caches[cache]?.name ?? cache}` };
  return { state: { ...b, workflows: { ...b.workflows, [wf]: { ...w, cacheIds: [...w.cacheIds, cache] } } } };
}

export function unlinkCaches(b: BoardState, pairs: [Id, Id][]): BoardState {
  const workflows = { ...b.workflows };
  for (const [wf, cache] of pairs) {
    const w = workflows[wf];
    if (w) workflows[wf] = { ...w, cacheIds: w.cacheIds.filter((x) => x !== cache) };
  }
  return { ...b, workflows };
}

export function deleteSteps(b: BoardState, ids: Id[]): BoardState {
  const gone = new Set(ids);
  const steps: BoardState['steps'] = {};
  for (const [id, s] of Object.entries(b.steps)) {
    if (gone.has(id)) continue;
    steps[id] = s.nextStepIds.some((x) => gone.has(x)) ? { ...s, nextStepIds: s.nextStepIds.filter((x) => !gone.has(x)) } : s;
  }
  const assignments: BoardState['assignments'] = {};
  const goneAssign = new Set<Id>();
  for (const [id, a] of Object.entries(b.assignments)) {
    if (gone.has(a.stepId)) goneAssign.add(id); else assignments[id] = a;
  }
  const workflows: BoardState['workflows'] = {};
  for (const [id, w] of Object.entries(b.workflows)) {
    workflows[id] = {
      ...w,
      entryStepIds: w.entryStepIds.filter((x) => !gone.has(x)),
      entryCrons: without(w.entryCrons, [...gone]),
      assignmentIds: w.assignmentIds.filter((x) => !goneAssign.has(x)),
    };
  }
  return { ...b, steps, assignments, workflows };
}

export function deleteCaches(b: BoardState, ids: Id[]): BoardState {
  const gone = new Set(ids);
  const caches: BoardState['caches'] = {};
  for (const [id, c] of Object.entries(b.caches)) if (!gone.has(id)) caches[id] = c;
  const workflows: BoardState['workflows'] = {};
  for (const [id, w] of Object.entries(b.workflows)) workflows[id] = { ...w, cacheIds: w.cacheIds.filter((x) => !gone.has(x)) };
  return { ...b, caches, workflows };
}

type Fields<T> = Exclude<keyof T, 'id' | 'updatedAt' | 'at'>;

export function setWorkflowField<K extends Fields<WorkflowRow>>(b: BoardState, id: Id, field: K, value: WorkflowRow[K]): BoardState {
  const w = b.workflows[id];
  return w ? { ...b, workflows: { ...b.workflows, [id]: { ...w, [field]: value } } } : b;
}
export function setStepField<K extends Fields<StepRow>>(b: BoardState, id: Id, field: K, value: StepRow[K]): BoardState {
  const s = b.steps[id];
  return s ? { ...b, steps: { ...b.steps, [id]: { ...s, [field]: value } } } : b;
}
export function setCacheField<K extends Fields<CacheRow>>(b: BoardState, id: Id, field: K, value: CacheRow[K]): BoardState {
  const c = b.caches[id];
  return c ? { ...b, caches: { ...b.caches, [id]: { ...c, [field]: value } } } : b;
}

/** The workflow row goes, with the assignment rows no other workflow links; steps, wires and caches stay. */
export function withoutWorkflow(b: BoardState, wf: Id): BoardState {
  const w = b.workflows[wf];
  if (!w) return b;
  const workflows = { ...b.workflows };
  delete workflows[wf];
  const assignments = { ...b.assignments };
  for (const id of w.assignmentIds) if (linkedBy(b, id).every((x) => x === wf)) delete assignments[id];
  return { ...b, workflows, assignments };
}

/** A processor's own field (Studio's FIELDS.processor). sourceHash is never null; a blank instanceId is null. */
export function setProcessorField(
  b: BoardState, processorId: Id, field: 'name' | 'version' | 'description' | 'sourceHash' | 'instanceId', value: string | null,
): BoardState {
  const p = b.processors[processorId];
  if (!p || p[field] === value) return b;
  return { ...b, processors: { ...b.processors, [processorId]: { ...p, [field]: value } } };
}

/**
 * A slot edit gives the processor a schema row of its own (new id, updatedAt null) holding `copy`'s fields and
 * points the slot at it. A slot already on an unsaved row is edited in place instead of piling up copies.
 */
export function setSlotSchema(b: BoardState, processorId: Id, slot: Slot, copy: SchemaCopy, newId: () => Id): BoardState {
  const p = b.processors[processorId];
  if (!p) return b;
  const field = SLOT_FIELD[slot];
  const curId = p[field];
  const cur = curId ? b.schemas[curId] : undefined;
  const id = cur && cur.updatedAt === null ? cur.id : newId();
  const row: SchemaRow = {
    id, name: copy.name, version: copy.version, description: copy.description, definition: copy.definition,
    audit: cur?.audit ?? { createdAt: '', createdBy: null, updatedAt: '', updatedBy: null }, at: cur?.at ?? null, updatedAt: null,
  };
  return {
    ...b,
    schemas: { ...b.schemas, [id]: row },
    processors: { ...b.processors, [processorId]: { ...p, [field]: id } },
  };
}

/** Leaves the slot with no schema. */
export function clearSlot(b: BoardState, processorId: Id, slot: Slot): BoardState {
  const p = b.processors[processorId];
  const field = SLOT_FIELD[slot];
  if (!p || p[field] === null) return b;
  return { ...b, processors: { ...b.processors, [processorId]: { ...p, [field]: null } } };
}
