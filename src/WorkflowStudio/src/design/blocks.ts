import type { StudioDocument } from '../app/document';
import { routeWires } from '../layout/circuitRoute';
import { snap, type Point } from '../layout/geometry';
import { isNum } from '../layout/shape';
import type { Assignment, Cache, Graph, Id, Processor, Schema, Step } from '../model/graph';
import type { FieldValue } from './design';

/**
 * A step the design creates (copy and paste, 2026-10-10): a new id (its key), its original's processor (processors are
 * never copied), the fields it was copied with, and where it was pasted. Its Inspector edits are ordinary step edits.
 */
export interface NewStep {
  /** The step it is a copy of (for BaseApi's log); may itself be a step of this design. */
  copyOf: Id | null;
  name: string;
  version: string;
  description: string | null;
  /** null: it has none (copied from a step whose processor was removed, or removed since, 2026-10-10). */
  processorId: Id | null;
  entryCondition: number;
  /** Its top-left corner where it was pasted; a later move is the draft's, as for any step. */
  at: Point;
  /** Its assignment, a new row: the original's fields (payload included), `copyOf` the real row they come from. */
  assignment: NewAssignment | null;
}

export interface NewAssignment {
  id: Id;
  /** The real assignment it copies (BaseApi fills the fields not sent from it); null: none. */
  copyOf: Id | null;
  fields: Record<string, FieldValue>;
}

/** A cache the design creates (a pasted copy): its own id, the original's fields, where it was pasted. */
export interface NewCache {
  copyOf: Id | null;
  name: string;
  version: string;
  description: string | null;
  root: string;
  items: string;
  at: Point;
}

/**
 * An existing cache the design links to this workflow (the Toolbox, 2026-10-11): the SAME entity (its id is the key), never
 * a copy; a snapshot of its fields so the canvas and the Inspector can draw it, and where it was dropped. Save adds its id to
 * the workflow's cache list.
 */
export interface LinkedCache {
  name: string;
  version: string;
  description: string | null;
  root: string;
  items: string;
  at: Point;
}

/**
 * The blocks the design creates and removes (2026-10-10): part of the canvas draft, so undo, redo, the session and Save
 * cover them like any drawing. A removed step or cache is one the workflow had; a pasted one deleted again is simply
 * gone from `steps` / `caches`. `refs`: processors and schemas a step pasted from another workflow needs and this
 * workflow's graph does not carry (read-only, so its die and Inspector can name them).
 */
export interface Blocks {
  steps: Record<Id, NewStep>;
  caches: Record<Id, NewCache>;
  removed: { steps: Id[]; caches: Id[] };
  /**
   * The `updatedAt` each removed step was loaded with when it was deleted (review 2026-10-10): Save sends it, so a step
   * someone else changed since is a conflict, also after a refused Save, a reopen of the stored design or a refresh
   * (never the stamp of a later re-read).
   */
  stamps: Record<Id, string>;
  /**
   * Steps the workflow has whose processor the design removed (Delete on a picked processor, 2026-10-10): the step
   * stays, pointing at no processor; the processor entity is never touched. A pasted step's own `processorId` says it.
   */
  unassigned: Id[];
  /**
   * Steps the workflow has given another existing processor (a Toolbox processor dropped on the step, 2026-10-11): step id
   * to processor id, the same processor entity, never a copy. A pasted step's own `processorId` says it.
   */
  assigned: Record<Id, Id>;
  /** Existing caches linked to this workflow (the Toolbox, 2026-10-11), by cache id. */
  linked: Record<Id, LinkedCache>;
  refs: { processors: Record<Id, Processor>; schemas: Record<Id, Schema> };
}

export const EMPTY_BLOCKS: Blocks = {
  steps: {}, caches: {}, removed: { steps: [], caches: [] }, stamps: {}, unassigned: [], assigned: {}, linked: {}, refs: { processors: {}, schemas: {} },
};

const none = (r: object) => Object.keys(r).length === 0;

/** Nothing created or removed (refs alone change nothing). */
export const isEmptyBlocks = (b: Blocks): boolean =>
  none(b.steps) && none(b.caches) && b.removed.steps.length === 0 && b.removed.caches.length === 0 && b.unassigned.length === 0
  && none(b.assigned ?? {}) && none(b.linked ?? {});

const NO_AUDIT = { createdAt: '', createdBy: null, updatedAt: '', updatedBy: null };

const memo = new WeakMap<StudioDocument, WeakMap<Blocks, StudioDocument>>();

/**
 * The base with the design's blocks laid over it: removed steps and caches gone (with every link to them in the lists,
 * their assignments and their places), created ones added (no next steps of their own: the circuit gives them, as for
 * any step; placed where pasted; their assignments added), the processors and schemas they need added when missing.
 * Everything downstream (the entity edits, the circuit, Save) treats the result as the workflow. Pure and memoised:
 * the same base and blocks give the same document.
 */
export function applyBlocks(base: StudioDocument, blocks: Blocks): StudioDocument {
  if (isEmptyBlocks(blocks)) return base;
  let byBlocks = memo.get(base);
  const hit = byBlocks?.get(blocks);
  if (hit) return hit;

  const g = base.graph;
  const goneSteps = new Set(blocks.removed.steps.filter((id) => g.steps.has(id)));
  const goneCaches = new Set(blocks.removed.caches);
  const keep = (ids: readonly Id[]) => ids.filter((id) => !goneSteps.has(id));

  const unassigned = new Set(blocks.unassigned);
  const assigned = blocks.assigned ?? {};
  const linked = blocks.linked ?? {};
  const steps = new Map<Id, Step>();
  for (const [id, s] of g.steps) {
    if (goneSteps.has(id)) continue;
    let step = s.nextStepIds.some((n) => goneSteps.has(n)) ? { ...s, nextStepIds: keep(s.nextStepIds) } : s;
    // its processor removed in the design: the step points at none (the processor itself stays)
    if (unassigned.has(id)) step = { ...step, processorId: null };
    // another existing processor dropped on it (the Toolbox): it points at that one (the same entity)
    else if (Object.hasOwn(assigned, id)) step = { ...step, processorId: assigned[id]! };
    steps.set(id, step);
  }
  for (const [id, n] of Object.entries(blocks.steps)) {
    if (steps.has(id)) continue;
    steps.set(id, {
      id, name: n.name, version: n.version, description: n.description, processorId: n.processorId,
      nextStepIds: [], entryCondition: n.entryCondition, updatedAt: '', audit: NO_AUDIT,
    });
  }

  const processors = new Map(g.processors);
  for (const [id, p] of Object.entries(blocks.refs.processors)) if (!processors.has(id)) processors.set(id, p);
  const schemas = new Map(g.schemas);
  for (const [id, s] of Object.entries(blocks.refs.schemas)) if (!schemas.has(id)) schemas.set(id, s);

  const caches = new Map<Id, Cache>();
  for (const [id, c] of g.caches) if (!goneCaches.has(id)) caches.set(id, c);
  for (const [id, c] of Object.entries(blocks.caches)) {
    if (!caches.has(id)) caches.set(id, { id, name: c.name, version: c.version, description: c.description, root: c.root, items: c.items, audit: NO_AUDIT });
  }
  // an existing cache linked here (the Toolbox): the same entity, drawn from its snapshot
  for (const [id, c] of Object.entries(linked)) {
    if (!caches.has(id) && !goneCaches.has(id)) caches.set(id, { id, name: c.name, version: c.version, description: c.description, root: c.root, items: c.items, audit: NO_AUDIT });
  }

  const assignments: Assignment[] = g.assignments.filter((a) => !goneSteps.has(a.stepId));
  for (const [stepId, n] of Object.entries(blocks.steps)) {
    if (!n.assignment || assignments.some((a) => a.stepId === stepId)) continue;
    const f = n.assignment.fields;
    assignments.push({
      id: n.assignment.id, stepId, payload: typeof f.payload === 'string' ? f.payload : '{}', updatedAt: '',
      ...(typeof f.name === 'string' ? { name: f.name } : {}), ...(typeof f.version === 'string' ? { version: f.version } : {}),
      ...(f.description === null || typeof f.description === 'string' ? { description: f.description } : {}),
    });
  }

  const cacheIds = [
    ...g.workflow.cacheIds.filter((id) => !goneCaches.has(id)),
    ...[...Object.keys(blocks.caches), ...Object.keys(linked)].filter((id) => !g.workflow.cacheIds.includes(id) && !goneCaches.has(id)),
  ];
  const workflow = { ...g.workflow, entryStepIds: keep(g.workflow.entryStepIds), cacheIds };
  const graph: Graph = { ...g, workflow, steps, processors, schemas, caches, assignments };

  const placedSteps = new Map<Id, Point>();
  for (const [id, p] of base.placement.steps) if (!goneSteps.has(id)) placedSteps.set(id, p);
  for (const [id, n] of Object.entries(blocks.steps)) if (!placedSteps.has(id)) placedSteps.set(id, { x: snap(n.at.x), y: snap(n.at.y) });
  const placedCaches = new Map<Id, Point>();
  for (const [id, p] of base.placement.caches) if (!goneCaches.has(id)) placedCaches.set(id, p);
  for (const [id, c] of Object.entries(blocks.caches)) if (!placedCaches.has(id)) placedCaches.set(id, { x: snap(c.at.x), y: snap(c.at.y) });
  for (const [id, c] of Object.entries(linked)) if (!placedCaches.has(id) && !goneCaches.has(id)) placedCaches.set(id, { x: snap(c.at.x), y: snap(c.at.y) });
  const placement = { sphere: base.placement.sphere, steps: placedSteps, caches: placedCaches };

  const parkedIds = [...base.parkedIds.filter((id) => !goneSteps.has(id)), ...Object.keys(blocks.steps).filter((id) => !base.parkedIds.includes(id))];
  const wires = routeWires({ entryStepIds: workflow.entryStepIds, steps }, placement);
  const out: StudioDocument = { graph, parkedIds, placement, wires };
  if (!byBlocks) { byBlocks = new WeakMap(); memo.set(base, byBlocks); }
  byBlocks.set(blocks, out);
  return out;
}

// ---- reading back (a session's draft); anything malformed is dropped ----

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const id = (v: unknown): Id | null => (typeof v === 'string' && v !== '' ? v : null);
const point = (v: unknown): Point => (isRecord(v) && isNum(v.x) && isNum(v.y) ? { x: v.x, y: v.y } : { x: 0, y: 0 });
const copy = <T>(r: Record<string, T> = {}): Record<string, T> => Object.assign(Object.create(null) as Record<string, T>, r);

export function parseFields(v: unknown): Record<string, FieldValue> {
  const out = copy<FieldValue>();
  if (!isRecord(v)) return out;
  for (const [k, raw] of Object.entries(v)) {
    if (raw === null || typeof raw === 'string' || (typeof raw === 'number' && Number.isFinite(raw))) out[k] = raw;
  }
  return out;
}

function parseAssignment(v: unknown): NewAssignment | null {
  if (!isRecord(v)) return null;
  const aid = id(v.id);
  return aid === null ? null : { id: aid, copyOf: id(v.copyOf), fields: parseFields(v.fields) };
}

function parseStep(v: unknown): NewStep | null {
  if (!isRecord(v)) return null;
  const name = text(v.name), version = text(v.version), processorId = id(v.processorId);
  // a processor id, or null for a step with none (2026-10-10); anything else is not a step
  if (name === null || version === null || (processorId === null && v.processorId !== null) || !isNum(v.entryCondition)) return null;
  return {
    copyOf: id(v.copyOf), name, version, description: text(v.description), processorId, entryCondition: v.entryCondition,
    at: point(v.at), assignment: parseAssignment(v.assignment),
  };
}

function parseCache(v: unknown): NewCache | null {
  if (!isRecord(v)) return null;
  const name = text(v.name), version = text(v.version), root = text(v.root), items = text(v.items);
  if (name === null || version === null || root === null || items === null) return null;
  return { copyOf: id(v.copyOf), name, version, description: text(v.description), root, items, at: point(v.at) };
}

function parseLinked(v: unknown): LinkedCache | null {
  if (!isRecord(v)) return null;
  const name = text(v.name), version = text(v.version), root = text(v.root), items = text(v.items);
  if (name === null || version === null || root === null || items === null) return null;
  return { name, version, description: text(v.description), root, items, at: point(v.at) };
}

function records<T>(v: unknown, parse: (x: unknown) => T | null): Record<string, T> {
  const out = copy<T>();
  if (!isRecord(v)) return out;
  for (const [k, raw] of Object.entries(v)) {
    const value = parse(raw);
    if (value !== null && k !== '') out[k] = value;
  }
  return out;
}

const ids = (v: unknown): Id[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x !== ''))] : []);

/** A processor or schema snapshot as the session keeps it (the model's own shape); anything else is dropped. */
const ref = <T extends { id: Id }>(v: unknown): T | null => (isRecord(v) && id(v.id) !== null && typeof v.name === 'string' ? (v as unknown as T) : null);

/** The blocks a session's draft held; anything not of their shape is dropped (none at all: empty). */
export function parseBlocks(v: unknown): Blocks {
  if (!isRecord(v)) return EMPTY_BLOCKS;
  const removed = isRecord(v.removed) ? v.removed : {};
  const refs = isRecord(v.refs) ? v.refs : {};
  return {
    steps: records(v.steps, parseStep),
    caches: records(v.caches, parseCache),
    removed: { steps: ids(removed.steps), caches: ids(removed.caches) },
    stamps: records(v.stamps, (x) => (typeof x === 'string' && x !== '' ? x : null)),
    unassigned: ids(v.unassigned),
    assigned: records(v.assigned, (x) => id(x)),
    linked: records(v.linked, parseLinked),
    refs: { processors: records(refs.processors, ref<Processor>), schemas: records(refs.schemas, ref<Schema>) },
  };
}
