import type { EntityReadDto } from '../api/entities';
import type { Id } from '../model/graph';
import { savedText } from '../store/entityForms';
import type { SchemaSlot } from '../store/inspectorTarget';
import { EMPTY_DRAFT, parseDraft, type Draft } from './draft';
import { EMPTY_BLOCKS, isEmptyBlocks, type Blocks, type NewCache, type NewStep } from './blocks';

/** A field's value as the update DTO carries it: text, the entry condition's number, or null. */
export type FieldValue = string | number | null;

/** One entity's changed fields (only those that differ from the base), with the stamp it was loaded with. */
export interface EntityEdit {
  /** Owned entities (the workflow, steps): the `updatedAt` BaseApi checks; null for shared ones. */
  updatedAt: string | null;
  fields: Record<string, FieldValue>;
}

/** What happens to a step's assignment in this workflow (spec §3.2): one operation per step. */
export type AssignmentOp =
  | { op: 'create'; id: Id; fields: Record<string, FieldValue> }
  | { op: 'update'; id: Id; updatedAt: string | null; fields: Record<string, FieldValue> }
  | { op: 'delete'; id: Id; updatedAt: string | null };

/** A processor slot's background copy (spec §1.5): a new id, the original's name and version. */
export interface SchemaCopy {
  id: Id;
  name: string;
  version: string;
  description: string | null;
  definition: string;
}

/** The Inspector's part of the design: never in the canvas's undo history. */
export interface EntityEdits {
  workflow: EntityEdit | null;
  steps: Record<Id, EntityEdit>;
  processors: Record<Id, EntityEdit>;
  caches: Record<Id, EntityEdit>;
  /** By step id. */
  assignments: Record<Id, AssignmentOp>;
  /** By `${processorId}:${slot}`. */
  schemas: Record<string, SchemaCopy>;
}

export const EMPTY_EDITS: EntityEdits = { workflow: null, steps: {}, processors: {}, caches: {}, assignments: {}, schemas: {} };

/** One document's whole design (spec §3.2): the canvas draft and the entity edits. */
export interface Design {
  draft: Draft;
  edits: EntityEdits;
}

export const EMPTY_DESIGN: Design = { draft: EMPTY_DRAFT, edits: EMPTY_EDITS };

/** Which entity an edit is for. A schema is reached from its processor's slot, so it is named by both. */
export type EditTarget =
  | { kind: 'workflow' }
  | { kind: 'step'; id: Id }
  | { kind: 'processor'; id: Id }
  | { kind: 'cache'; id: Id }
  | { kind: 'assignment'; id: Id; stepId: Id }
  | { kind: 'schema'; processorId: Id; slot: SchemaSlot };

export const slotKey = (processorId: Id, slot: SchemaSlot): string => `${processorId}:${slot}`;

/** The inverse of `slotKey`: splits on the last ':'; null when there is none or the slot is not input, output or config. */
export function parseSlotKey(key: string): { processorId: Id; slot: SchemaSlot } | null {
  const at = key.lastIndexOf(':');
  if (at < 0) return null;
  const slot = key.slice(at + 1);
  return slot === 'input' || slot === 'output' || slot === 'config' ? { processorId: key.slice(0, at), slot } : null;
}

/** A field value as form text: null reads as '', a number as its digits. */
export const valueText = (v: FieldValue | undefined): string => (v === null || v === undefined ? '' : String(v));

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const copy = <T>(r: Readonly<Record<string, T>>): Record<string, T> => Object.assign(Object.create(null) as Record<string, T>, r);

function put<T>(r: Readonly<Record<string, T>>, key: string, value: NoInfer<T> | null): Record<string, T> {
  const out = copy(r);
  if (value === null) delete out[key];
  else out[key] = value;
  return out;
}

const stampOf = (dto: EntityReadDto): string | null => str((dto as { updatedAt?: unknown }).updatedAt);

/** The fields an entity's form overlays on its base (spec §3.3): a copy's whole text for a schema. */
export function fieldsOf(edits: EntityEdits, t: EditTarget): Record<string, FieldValue> {
  switch (t.kind) {
    case 'workflow': return edits.workflow?.fields ?? {};
    case 'step': return edits.steps[t.id]?.fields ?? {};
    case 'processor': return edits.processors[t.id]?.fields ?? {};
    case 'cache': return edits.caches[t.id]?.fields ?? {};
    case 'assignment': {
      const op = edits.assignments[t.stepId];
      return op && op.op !== 'delete' && op.id === t.id ? op.fields : {};
    }
    case 'schema': {
      const c = edits.schemas[slotKey(t.processorId, t.slot)];
      return c ? { name: c.name, version: c.version, description: c.description, definition: c.definition } : {};
    }
  }
}

/**
 * Sets one field of the design (spec §3.3). A field typed back to the base's value is dropped; an entity
 * left with no field and the base's own stamp goes. A stamp older than the base's (it came from the
 * stored design) is kept: it is what was loaded. A schema edit makes or changes the slot's copy, whose
 * new id comes from `newId` (spec §1.5).
 */
export function setField(edits: EntityEdits, t: EditTarget, base: EntityReadDto, key: string, value: FieldValue, newId: () => Id): EntityEdits {
  const same = valueText(value) === savedText(base, key);
  const stamp = stampOf(base);
  const next = (e: EntityEdit | null | undefined, owned: boolean): EntityEdit | null => {
    const fields = copy(e?.fields ?? {});
    if (same) delete fields[key];
    else fields[key] = value;
    const updatedAt = e ? e.updatedAt : owned ? stamp : null;
    return Object.keys(fields).length === 0 && (updatedAt === null || updatedAt === stamp) ? null : { updatedAt, fields };
  };
  switch (t.kind) {
    case 'workflow': return { ...edits, workflow: next(edits.workflow, true) };
    case 'step': return { ...edits, steps: put(edits.steps, t.id, next(edits.steps[t.id], true)) };
    case 'processor': return { ...edits, processors: put(edits.processors, t.id, next(edits.processors[t.id], false)) };
    case 'cache': return { ...edits, caches: put(edits.caches, t.id, next(edits.caches[t.id], false)) };
    case 'assignment': {
      const op = edits.assignments[t.stepId];
      if (op?.op === 'delete') return edits;
      if (op?.op === 'create') return { ...edits, assignments: put<AssignmentOp>(edits.assignments, t.stepId, { ...op, fields: { ...op.fields, [key]: value } }) };
      const e = next(op ? { updatedAt: op.updatedAt, fields: op.fields } : null, true);
      return { ...edits, assignments: put<AssignmentOp>(edits.assignments, t.stepId, e === null ? null : { op: 'update', id: t.id, updatedAt: e.updatedAt, fields: e.fields }) };
    }
    case 'schema': {
      const k = slotKey(t.processorId, t.slot);
      const was: SchemaCopy = edits.schemas[k] ?? {
        id: newId(), name: savedText(base, 'name'), version: savedText(base, 'version'),
        description: (base as { description?: string | null }).description ?? null, definition: savedText(base, 'definition'),
      };
      const text = valueText(value);
      const changed: SchemaCopy =
        key === 'description' ? { ...was, description: text === '' ? null : text }
        : key === 'name' ? { ...was, name: text }
        : key === 'version' ? { ...was, version: text }
        : key === 'definition' ? { ...was, definition: text }
        : was;
      return { ...edits, schemas: put(edits.schemas, k, changed) };
    }
  }
}

/**
 * Whether the design holds an edit entry for one entity: changed fields, or only a stamp (a wiring-only
 * step, the workflow of a stored design, a field typed back to its saved value). Such a stamp is still
 * sent on Save, so the Inspector marks it and Revert can drop it (spec §6.2).
 */
export function hasEdit(edits: EntityEdits, t: EditTarget): boolean {
  switch (t.kind) {
    case 'workflow': return edits.workflow !== null;
    case 'step': return Object.hasOwn(edits.steps, t.id);
    case 'processor': return Object.hasOwn(edits.processors, t.id);
    case 'cache': return Object.hasOwn(edits.caches, t.id);
    case 'assignment': return edits.assignments[t.stepId]?.id === t.id;
    case 'schema': return Object.hasOwn(edits.schemas, slotKey(t.processorId, t.slot));
  }
}

/** Drops everything the design holds for one entity (the Inspector's Revert). */
export function revertEntity(edits: EntityEdits, t: EditTarget): EntityEdits {
  switch (t.kind) {
    case 'workflow': return { ...edits, workflow: null };
    case 'step': return { ...edits, steps: put(edits.steps, t.id, null) };
    case 'processor': return { ...edits, processors: put(edits.processors, t.id, null) };
    case 'cache': return { ...edits, caches: put(edits.caches, t.id, null) };
    case 'assignment': return { ...edits, assignments: put(edits.assignments, t.stepId, null) };
    case 'schema': return { ...edits, schemas: put(edits.schemas, slotKey(t.processorId, t.slot), null) };
  }
}

/**
 * Creates a step's assignment in the design (spec §3.3): `{step}-assignment`, 1.0.0, payload `{}`. When
 * the step's own row was removed in this design, that row is updated to the new values instead: one
 * operation per step.
 */
export function createAssignment(edits: EntityEdits, stepId: Id, stepName: string, id: Id): EntityEdits {
  const fields: Record<string, FieldValue> = { name: `${stepName}-assignment`, version: '1.0.0', description: null, payload: '{}' };
  const op = edits.assignments[stepId];
  const made: AssignmentOp = op?.op === 'delete' ? { op: 'update', id: op.id, updatedAt: op.updatedAt, fields } : { op: 'create', id, fields };
  return { ...edits, assignments: put(edits.assignments, stepId, made) };
}

/** Removes a step's assignment in the design: a created one is forgotten, the base's row is deleted on Save. */
export function removeAssignment(edits: EntityEdits, stepId: Id, base: { id: Id; updatedAt: string } | undefined): EntityEdits {
  const op = edits.assignments[stepId];
  if (op?.op === 'create') return { ...edits, assignments: put(edits.assignments, stepId, null) };
  if (base === undefined || op?.op === 'delete') return edits;
  const updatedAt = op?.op === 'update' ? op.updatedAt : base.updatedAt;
  return { ...edits, assignments: put<AssignmentOp>(edits.assignments, stepId, { op: 'delete', id: base.id, updatedAt }) };
}

const anyFields = (r: Readonly<Record<string, EntityEdit>>) => Object.values(r).some((e) => Object.keys(e.fields).length > 0);

/** Whether the design changes the real entities (Save has something to apply): wiring or entity edits, not shapes or stamps. */
export function hasGraphChanges({ draft, edits }: Design): boolean {
  return Object.keys(draft.next).length > 0 || draft.entries !== null || !isEmptyBlocks(draft.blocks)
    || (edits.workflow !== null && Object.keys(edits.workflow.fields).length > 0)
    || anyFields(edits.steps) || anyFields(edits.processors) || anyFields(edits.caches)
    || Object.keys(edits.assignments).length > 0 || Object.keys(edits.schemas).length > 0;
}

export const isEmptyEdits = (edits: EntityEdits): boolean => !hasGraphChanges({ draft: EMPTY_DRAFT, edits });

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v !== null && typeof v === 'object') {
    const r = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(r).sort().map((k) => [k, canonical(r[k])]));
  }
  return v;
}

/** Equal designs, whatever the order their records were built in. */
export const sameDesign = (a: Design, b: Design): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** The blocks a stored design creates and deletes (its `newSteps`, `newCaches`, `deletedSteps`, `deletedCaches`). */
function storedBlocks(stored: Record<string, unknown>, layout: unknown): Blocks {
  const placed = (kind: 'steps' | 'caches', id: string) => {
    const at = isRecord(layout) && isRecord(layout[kind]) ? (layout[kind] as Record<string, unknown>)[id] : undefined;
    return isRecord(at) && typeof at.x === 'number' && typeof at.y === 'number' ? { x: at.x, y: at.y } : { x: 0, y: 0 };
  };
  const text = (f: Record<string, FieldValue>, k: string): string => (typeof f[k] === 'string' ? f[k] : '');
  const steps = copy<NewStep>({});
  for (const s of list(stored.newSteps)) {
    const id = str(s.id), processorId = str(s.processorId);
    if (id === null || processorId === null) continue;
    const f = toFields(s.fields);
    steps[id] = {
      copyOf: str(s.copyOf), name: text(f, 'name'), version: text(f, 'version'), description: typeof f.description === 'string' ? f.description : null,
      processorId, entryCondition: typeof f.entryCondition === 'number' ? f.entryCondition : 1, at: placed('steps', id), assignment: null,
    };
  }
  const caches = copy<NewCache>({});
  for (const c of list(stored.newCaches)) {
    const id = str(c.id);
    if (id === null) continue;
    const f = toFields(c.fields);
    caches[id] = {
      copyOf: str(c.copyOf), name: text(f, 'name'), version: text(f, 'version'), description: typeof f.description === 'string' ? f.description : null,
      root: text(f, 'root'), items: text(f, 'items'), at: placed('caches', id),
    };
  }
  const ids = (v: unknown) => list(v).flatMap((x) => { const id = str(x.id); return id === null ? [] : [id]; });
  // the stamps the steps were loaded with when deleted: a later re-read never replaces them (review 2026-10-10)
  const stamps = copy<string>({});
  for (const d of list(stored.deletedSteps)) {
    const id = str(d.id), at = str(d.updatedAt);
    if (id !== null && at !== null) stamps[id] = at;
  }
  return { ...EMPTY_BLOCKS, steps, caches, removed: { steps: ids(stored.deletedSteps), caches: ids(stored.deletedCaches) }, stamps };
}

// ---- reading back: the session's edits and the server's stored design; anything malformed is dropped ----

function toFields(v: unknown): Record<string, FieldValue> {
  const out = copy<FieldValue>({});
  if (!isRecord(v)) return out;
  for (const [k, raw] of Object.entries(v)) {
    if (raw === null || typeof raw === 'string' || (typeof raw === 'number' && Number.isFinite(raw))) out[k] = raw;
  }
  return out;
}

const toIds = (v: unknown): Id[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : null);

function toOp(v: unknown): AssignmentOp | null {
  if (!isRecord(v)) return null;
  const id = str(v.id);
  if (id === null) return null;
  switch (v.op) {
    case 'create': return { op: 'create', id, fields: toFields(v.fields) };
    case 'update': return { op: 'update', id, updatedAt: str(v.updatedAt), fields: toFields(v.fields) };
    case 'delete': return { op: 'delete', id, updatedAt: str(v.updatedAt) };
    default: return null;
  }
}

function toCopy(v: unknown): SchemaCopy | null {
  if (!isRecord(v)) return null;
  const id = str(v.id);
  if (id === null || typeof v.name !== 'string' || typeof v.version !== 'string' || typeof v.definition !== 'string') return null;
  return { id, name: v.name, version: v.version, description: typeof v.description === 'string' ? v.description : null, definition: v.definition };
}

const toEdit = (v: unknown): EntityEdit | null => (isRecord(v) ? { updatedAt: str(v.updatedAt), fields: toFields(v.fields) } : null);

function records<T>(v: unknown, parse: (x: unknown) => T | null): Record<string, T> {
  const out = copy<T>({});
  if (!isRecord(v)) return out;
  for (const [k, raw] of Object.entries(v)) {
    const value = parse(raw);
    if (value !== null) out[k] = value;
  }
  return out;
}

/** The edits a session held (the shape `EntityEdits` serializes to), or null when it is not that at all. */
export function parseEdits(value: unknown): EntityEdits | null {
  if (!isRecord(value)) return null;
  return {
    workflow: toEdit(value.workflow),
    steps: records(value.steps, toEdit),
    processors: records(value.processors, toEdit),
    caches: records(value.caches, toEdit),
    assignments: records(value.assignments, toOp),
    schemas: records(value.schemas, toCopy),
  };
}

const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);

/**
 * The last saved design (spec §3.1): the server's stored body (`graph.design`, the request without its
 * layout) read back into a design, with the circuit (or a plan 8 layout's shapes and loose wires) of the stored
 * layout. With nothing stored, only that circuit: the real entities hold the rest.
 */
export function storedDesignOf(stored: unknown, layout: unknown): Design {
  // a plan 9 layout holds the circuit; a plan 7 / plan 8 one its shapes and loose wires (spec §8)
  const shapes = parseDraft(isRecord(layout) ? (Object.hasOwn(layout, 'wires') ? { wires: layout.wires } : { routes: layout.routes, loose: layout.loose }) : {})!;
  const draft: Draft = { ...EMPTY_DRAFT, wires: shapes.wires, next: copy({}) };
  const edits: EntityEdits = { workflow: null, steps: copy({}), processors: copy({}), caches: copy({}), assignments: copy({}), schemas: copy({}) };
  if (!isRecord(stored)) return { draft, edits };

  if (isRecord(stored.workflow)) {
    edits.workflow = toEdit(stored.workflow);
    draft.entries = toIds(stored.workflow.entryStepIds);
  }
  for (const s of list(stored.steps)) {
    const id = str(s.id);
    if (id === null) continue;
    edits.steps[id] = toEdit(s)!;
    const next = toIds(s.nextStepIds);
    if (next !== null) draft.next[id] = next;
  }
  const copies = new Map(list(stored.schemas).flatMap((c) => { const x = toCopy(c); return x ? [[x.id, x] as const] : []; }));
  for (const p of list(stored.processors)) {
    const id = str(p.id);
    if (id === null) continue;
    const fields = toFields(p.fields);
    if (Object.keys(fields).length > 0) edits.processors[id] = { updatedAt: null, fields };
    const slots = isRecord(p.slots) ? p.slots : {};
    for (const slot of ['input', 'output', 'config'] as const) {
      const c = copies.get(str(slots[slot]) ?? '');
      if (c) edits.schemas[slotKey(id, slot)] = c;
    }
  }
  for (const c of list(stored.caches)) {
    const id = str(c.id);
    const fields = toFields(c.fields);
    if (id !== null && Object.keys(fields).length > 0) edits.caches[id] = { updatedAt: null, fields };
  }
  // pasted and deleted blocks (2026-10-10): placed where the stored layout has them
  const blocks = storedBlocks(stored, layout);
  for (const s of list(stored.newSteps)) {
    const id = str(s.id), next = toIds(s.nextStepIds);
    if (id !== null && Object.hasOwn(blocks.steps, id) && next !== null) draft.next[id] = next;
  }
  if (!isEmptyBlocks(blocks)) draft.blocks = blocks;
  for (const a of list(stored.assignments)) {
    const stepId = str(a.stepId);
    const op = toOp(a);
    if (stepId === null || op === null) continue;
    // a pasted step's assignment is its own (created with it)
    const pasted = blocks.steps[stepId];
    if (pasted && op.op === 'create') pasted.assignment = { id: op.id, copyOf: str(a.copyOf), fields: op.fields };
    else edits.assignments[stepId] = op;
  }
  // a stored body that rewired steps but whose layout holds no circuit (plan 8): settling makes the circuit whole
  if (draft.wires === null && (Object.keys(draft.next).length > 0 || draft.entries !== null)) draft.wires = copy({});
  return { draft, edits };
}
