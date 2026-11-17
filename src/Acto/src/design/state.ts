import type { Cache, Graph, Id, Processor, Schema, Step, Workflow, Assignment, Audit } from '../model/graph';
import type { Point, Rect } from '../model/geometry';
import type { BoardWorkflow } from '../board/loadBoard';
import { frameSizeOf, minFrameSize } from '../board/placement';
import { derivedEntrySteps, entryDiff, stepRoles } from '../board/roles';
import { wiresOf } from '../board/wires';

export interface StepState {
  id: Id; name: string; version: string; description: string | null; entryCondition: number;
  processorId: Id | null; nextStepIds: Id[]; at: Point; updatedAt: string | null; isNew: boolean;
}
export interface CacheFields { name: string; version: string; description: string | null; root: string; items: string }
export interface CacheState extends CacheFields {
  id: Id; isNew: boolean;
  /** An existing cache linked here and not saved yet: its fields as linked, what an edit is diffed against. */
  linked?: CacheFields;
}
export interface AssignmentState {
  id: Id; stepId: Id; name: string; version: string; description: string | null; payload: string;
  updatedAt: string | null; isNew: boolean;
}
export type Slot = 'input' | 'output' | 'config';
export interface SchemaCopy { id: Id; name: string; version: string; description: string | null; definition: string }
export interface ProcessorEdit {
  fields: Partial<{ name: string; version: string; description: string | null }>;
  slots: Partial<Record<Slot, { copy: SchemaCopy } | { cleared: true }>>;
}
/** The processor field that holds a slot's schema id (the same keys WorkflowStudio sends). */
export const SLOT_FIELD: Readonly<Record<Slot, 'inputSchemaId' | 'outputSchemaId' | 'configSchemaId'>> = {
  input: 'inputSchemaId', output: 'outputSchemaId', config: 'configSchemaId',
};
export const SLOTS: readonly Slot[] = ['input', 'output', 'config'];

export interface WorkflowState {
  workflowId: Id; isNew: boolean; updatedAt: string | null;
  fields: { name: string; version: string; description: string | null; cronExpression: string | null };
  steps: Record<Id, StepState>; caches: Record<Id, CacheState>; assignments: Record<Id, AssignmentState>;
  deletedSteps: Record<Id, string | null>; frame: Rect;
  /** The entry steps the base stored (what BaseAPI runs first today); the designer only derives them. */
  storedEntry?: Id[];
  /** Edits to processors and their schema slots (shared entities, last write wins); absent means none. */
  processors?: Record<Id, ProcessorEdit>;
}

const NO_AUDIT: Audit = { createdAt: '', createdBy: null, updatedAt: '', updatedBy: null };

export function stateOf(bw: BoardWorkflow): WorkflowState {
  const { graph } = bw;
  const w = graph.workflow;
  const steps: Record<Id, StepState> = {};
  for (const id of bw.stepIds) {
    const s = graph.steps.get(id);
    if (!s) continue;
    steps[id] = {
      id, name: s.name, version: s.version, description: s.description, entryCondition: s.entryCondition,
      processorId: s.processorId, nextStepIds: [...s.nextStepIds], at: { ...(bw.stepAt.get(id) ?? { x: 0, y: 0 }) },
      updatedAt: s.updatedAt, isNew: false,
    };
  }
  const assignments: Record<Id, AssignmentState> = {};
  for (const a of graph.assignments) {
    const stepName = steps[a.stepId]?.name ?? a.stepId;
    assignments[a.stepId] = {
      id: a.id, stepId: a.stepId, name: a.name ?? `${stepName}-assignment`, version: a.version ?? '1.0.0',
      description: a.description ?? null, payload: a.payload, updatedAt: a.updatedAt, isNew: false,
    };
  }
  const caches: Record<Id, CacheState> = {};
  for (const [id, c] of graph.caches) {
    caches[id] = { id, name: c.name, version: c.version, description: c.description, root: c.root, items: c.items, isNew: false };
  }
  return {
    workflowId: w.id, isNew: false, updatedAt: w.updatedAt,
    fields: { name: w.name, version: w.version, description: w.description, cronExpression: w.cronExpression },
    steps, caches, assignments, deletedSteps: {}, frame: { ...bw.frame },
    storedEntry: [...w.entryStepIds],
  };
}

export function newWorkflowState(id: Id, name: string, at: Point): WorkflowState {
  return {
    workflowId: id, isNew: true, updatedAt: null,
    fields: { name, version: '1.0.0', description: null, cronExpression: null },
    steps: {}, caches: {}, assignments: {}, deletedSteps: {}, frame: { ...at, ...frameSizeOf(new Map()) },
  };
}

const stepAtOf = (s: WorkflowState) => new Map(Object.entries(s.steps).map(([id, st]) => [id, st.at]));

export function boardWorkflowOf(
  state: WorkflowState, base: BoardWorkflow | null, processors: ReadonlyMap<Id, Processor>,
): BoardWorkflow {
  const stepIds = Object.keys(state.steps);
  const stepAt = stepAtOf(state);
  const steps = new Map<Id, Step>();
  for (const id of stepIds) {
    const st = state.steps[id]!;
    steps.set(id, {
      id, name: st.name, version: st.version, description: st.description, processorId: st.processorId,
      nextStepIds: [...st.nextStepIds], entryCondition: st.entryCondition, updatedAt: st.updatedAt ?? '',
      audit: base?.graph.steps.get(id)?.audit ?? NO_AUDIT,
    });
  }
  const procs = new Map<Id, Processor>();
  const schemas = new Map(base?.graph.schemas ?? []);
  for (const st of Object.values(state.steps)) {
    const pid = st.processorId;
    if (!pid) continue;
    const p = processors.get(pid) ?? base?.graph.processors.get(pid);
    if (!p) continue;
    const edit = state.processors?.[pid];
    if (!edit) { procs.set(pid, p); continue; }
    const shown: Processor = { ...p, ...edit.fields };
    for (const slot of SLOTS) {
      const e = edit.slots[slot];
      if (!e) continue;
      if ('cleared' in e) { shown[SLOT_FIELD[slot]] = null; continue; }
      shown[SLOT_FIELD[slot]] = e.copy.id;
      schemas.set(e.copy.id, { ...e.copy, audit: NO_AUDIT });
    }
    procs.set(pid, shown);
  }
  const wires = wiresOf(stepIds, steps);
  const roles = stepRoles(stepIds, wires);
  const derived = derivedEntrySteps(roles);
  const stored = base && !state.isNew ? base.graph.workflow.entryStepIds : derived;
  const caches = new Map<Id, Cache>();
  for (const c of Object.values(state.caches)) {
    caches.set(c.id, {
      id: c.id, name: c.name, version: c.version, description: c.description, root: c.root, items: c.items,
      audit: base?.graph.caches.get(c.id)?.audit ?? NO_AUDIT,
    });
  }
  const assignments: Assignment[] = Object.values(state.assignments).map((a) => ({
    id: a.id, stepId: a.stepId, payload: a.payload, updatedAt: a.updatedAt ?? '',
    name: a.name, version: a.version, description: a.description,
  }));
  const workflow: Workflow = {
    id: state.workflowId, ...state.fields, entryStepIds: [...stored],
    assignmentIds: assignments.map((a) => a.id), cacheIds: Object.keys(state.caches),
    updatedAt: state.updatedAt ?? '', audit: base?.graph.workflow.audit ?? NO_AUDIT,
  };
  const graph: Graph = {
    workflow, steps, processors: procs, schemas, assignments, caches,
    layout: base?.graph.layout ?? null, design: base?.graph.design ?? null,
  };
  const size = minFrameSize(stepAt, caches.size);
  return {
    graph, stepIds, stepAt, roles, wires,
    frame: { x: state.frame.x, y: state.frame.y, w: Math.max(state.frame.w, size.w), h: Math.max(state.frame.h, size.h) },
    entryDiff: state.isNew ? { stops: [], starts: [] } : entryDiff(stored, derived),
  };
}

export function moveStep(s: WorkflowState, stepId: Id, at: Point): WorkflowState {
  const st = s.steps[stepId];
  if (!st || (st.at.x === at.x && st.at.y === at.y)) return s;
  return { ...s, steps: { ...s.steps, [stepId]: { ...st, at: { ...at } } } };
}

export function moveFrame(s: WorkflowState, at: Point): WorkflowState {
  if (s.frame.x === at.x && s.frame.y === at.y) return s;
  return { ...s, frame: { ...s.frame, x: at.x, y: at.y } };
}

/** What one drag moved in a workflow: the frame and/or steps, as one new state (so one history step). */
export function moveMany(s: WorkflowState, m: { steps: { id: Id; at: Point }[]; frame?: Point }): WorkflowState {
  let next = m.frame ? moveFrame(s, m.frame) : s;
  for (const x of m.steps) next = moveStep(next, x.id, x.at);
  return next;
}

export function resizeFrame(s: WorkflowState, size: { w: number; h: number }): WorkflowState {
  const min = minFrameSize(stepAtOf(s), Object.keys(s.caches).length);
  const w = Math.max(size.w, min.w);
  const h = Math.max(size.h, min.h);
  if (s.frame.w === w && s.frame.h === h) return s;
  return { ...s, frame: { ...s.frame, w, h } };
}

export function uniqueName(s: WorkflowState, base: string): string {
  const taken = new Set(Object.values(s.steps).map((x) => x.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

export function addStep(s: WorkflowState, processor: Processor, at: Point, id: Id): WorkflowState {
  const step: StepState = {
    id, name: uniqueName(s, processor.name), version: '1.0.0', description: null, entryCondition: 1,
    processorId: processor.id, nextStepIds: [], at: { ...at }, updatedAt: null, isNew: true,
  };
  return { ...s, steps: { ...s.steps, [id]: step } };
}

/** Drops the edits of processors no step uses any more (undo brings them back: states are immutable). */
function pruneProcessors(s: WorkflowState): WorkflowState {
  if (!s.processors) return s;
  const used = new Set(Object.values(s.steps).map((x) => x.processorId));
  const keep = Object.entries(s.processors).filter(([id]) => used.has(id));
  return keep.length === Object.keys(s.processors).length ? s : { ...s, processors: Object.fromEntries(keep) };
}

export function swapProcessor(s: WorkflowState, stepId: Id, processor: Processor): WorkflowState {
  const st = s.steps[stepId];
  if (!st || st.processorId === processor.id) return s;
  return pruneProcessors({ ...s, steps: { ...s.steps, [stepId]: { ...st, processorId: processor.id } } });
}

export function removeStep(s: WorkflowState, stepId: Id): WorkflowState {
  const st = s.steps[stepId];
  if (!st) return s;
  const steps: Record<Id, StepState> = {};
  for (const [id, x] of Object.entries(s.steps)) {
    if (id === stepId) continue;
    steps[id] = x.nextStepIds.includes(stepId) ? { ...x, nextStepIds: x.nextStepIds.filter((n) => n !== stepId) } : x;
  }
  const assignments = { ...s.assignments };
  delete assignments[stepId];
  const deletedSteps = st.isNew ? s.deletedSteps : { ...s.deletedSteps, [stepId]: st.updatedAt };
  return pruneProcessors({ ...s, steps, assignments, deletedSteps });
}

/** Several steps and wires at once, as one state (each step goes as `removeStep` does). */
export function deleteParts(s: WorkflowState, stepIds: Id[], wires: [Id, Id][]): WorkflowState {
  let out = s;
  for (const [from, to] of wires) out = removeWire(out, from, to);
  for (const id of stepIds) out = removeStep(out, id);
  return out;
}

export function addWire(s: WorkflowState, from: Id, to: Id): { state: WorkflowState } | { refused: string } {
  if (from === to) return { refused: 'A step cannot wire to itself' };
  const src = s.steps[from];
  if (!src || !s.steps[to]) return { refused: 'A wire stays inside its workflow' };
  if (src.nextStepIds.includes(to)) return { refused: 'That wire already exists' };
  return { state: { ...s, steps: { ...s.steps, [from]: { ...src, nextStepIds: [...src.nextStepIds, to] } } } };
}

export function removeWire(s: WorkflowState, from: Id, to: Id): WorkflowState {
  const src = s.steps[from];
  if (!src || !src.nextStepIds.includes(to)) return s;
  return { ...s, steps: { ...s.steps, [from]: { ...src, nextStepIds: src.nextStepIds.filter((n) => n !== to) } } };
}

export function setWorkflowField(
  s: WorkflowState, key: 'name' | 'version' | 'description' | 'cronExpression', v: string | null,
): WorkflowState {
  if (s.fields[key] === v) return s;
  return { ...s, fields: { ...s.fields, [key]: v } };
}

export function setStepField(
  s: WorkflowState, stepId: Id, key: 'name' | 'version' | 'description' | 'entryCondition', v: string | number | null,
): WorkflowState {
  const st = s.steps[stepId];
  if (!st || st[key] === v) return s;
  return { ...s, steps: { ...s.steps, [stepId]: { ...st, [key]: v } } };
}

export function setPayload(s: WorkflowState, stepId: Id, payload: string, newId: () => Id): WorkflowState {
  const st = s.steps[stepId];
  if (!st) return s;
  const a = s.assignments[stepId];
  if (a) {
    if (a.payload === payload) return s;
    return { ...s, assignments: { ...s.assignments, [stepId]: { ...a, payload } } };
  }
  const made: AssignmentState = {
    id: newId(), stepId, name: `${st.name}-assignment`, version: '1.0.0', description: null, payload,
    updatedAt: null, isNew: true,
  };
  return { ...s, assignments: { ...s.assignments, [stepId]: made } };
}

export function removeAssignment(s: WorkflowState, stepId: Id): WorkflowState {
  if (!s.assignments[stepId]) return s;
  const assignments = { ...s.assignments };
  delete assignments[stepId];
  return { ...s, assignments };
}

export function addCache(s: WorkflowState, cache: CacheState): WorkflowState {
  return { ...s, caches: { ...s.caches, [cache.id]: cache } };
}

export function linkCache(s: WorkflowState, cache: Cache): WorkflowState {
  if (s.caches[cache.id]) return s;
  const fields: CacheFields = { name: cache.name, version: cache.version, description: cache.description, root: cache.root, items: cache.items };
  const c: CacheState = { id: cache.id, ...fields, isNew: false, linked: fields };
  return { ...s, caches: { ...s.caches, [cache.id]: c } };
}

export function unlinkCache(s: WorkflowState, cacheId: Id): WorkflowState {
  if (!s.caches[cacheId]) return s;
  const caches = { ...s.caches };
  delete caches[cacheId];
  return { ...s, caches };
}

export function setCacheField(
  s: WorkflowState, cacheId: Id, key: 'name' | 'version' | 'description' | 'root' | 'items', v: string | null,
): WorkflowState {
  const c = s.caches[cacheId];
  if (!c || c[key] === v) return s;
  return { ...s, caches: { ...s.caches, [cacheId]: { ...c, [key]: v } } };
}

function putEdit(s: WorkflowState, id: Id, e: ProcessorEdit): WorkflowState {
  const old = s.processors?.[id];
  const empty = Object.keys(e.fields).length === 0 && Object.keys(e.slots).length === 0;
  if (empty ? !old : old && deepEqual(old, e)) return s;
  const map = { ...s.processors };
  if (empty) delete map[id]; else map[id] = e;
  return { ...s, processors: map };
}
const editOf = (s: WorkflowState, id: Id): ProcessorEdit => s.processors?.[id] ?? { fields: {}, slots: {} };

export function setProcessorField(
  s: WorkflowState, base: Processor, key: 'name' | 'version' | 'description', v: string | null,
): WorkflowState {
  const e = editOf(s, base.id);
  const fields = { ...e.fields };
  if (v === base[key]) delete fields[key];
  else (fields as Record<string, string | null>)[key] = v;
  return putEdit(s, base.id, { ...e, fields });
}

/** The first edit of a slot makes a copy of the original (new id); the original is never rewritten. */
export function setSlotField(
  s: WorkflowState, base: Processor, slot: Slot, original: Schema | null,
  key: 'name' | 'version' | 'description' | 'definition', v: string | null, newId: () => Id,
): WorkflowState {
  const e = editOf(s, base.id);
  const cur = e.slots[slot];
  const was: SchemaCopy = cur && 'copy' in cur ? cur.copy : {
    id: newId(), name: original?.name ?? '', version: original?.version ?? '',
    description: original?.description ?? null, definition: original?.definition ?? '',
  };
  const changed: SchemaCopy = key === 'description' ? { ...was, description: v } : { ...was, [key]: v ?? '' };
  const slots = { ...e.slots };
  const typedBack = original !== null && changed.name === original.name && changed.version === original.version
    && (changed.description ?? null) === (original.description ?? null) && changed.definition === (original.definition ?? '');
  if (typedBack) delete slots[slot]; else slots[slot] = { copy: changed };
  return putEdit(s, base.id, { ...e, slots });
}

/** Leaves the slot with no schema: its copy goes and Save sends the processor's `<slot>SchemaId` as null. */
export function clearSlot(s: WorkflowState, base: Processor, slot: Slot): WorkflowState {
  const e = editOf(s, base.id);
  const slots = { ...e.slots };
  if (base[SLOT_FIELD[slot]] === null) delete slots[slot]; else slots[slot] = { cleared: true };
  return putEdit(s, base.id, { ...e, slots });
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => k in b && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export function sameState(a: WorkflowState, b: WorkflowState): boolean {
  return deepEqual({ ...a, processors: a.processors ?? {} }, { ...b, processors: b.processors ?? {} });
}
