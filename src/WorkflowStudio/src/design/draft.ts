import type { StudioDocument } from '../app/document';
import { SPHERE_R, type Point } from '../layout/geometry';
import { CACHE_NODE_PREFIX, SPHERE_NODE_ID } from '../layout/nodeIds';
import { WORKFLOW_SOURCE, type SourceId } from '../layout/ports';
import type { Bends, WireShape } from '../layout/shape';
import type { Id } from '../model/graph';

export type { Bends, WireShape } from '../layout/shape';

/**
 * What the user changed relative to the saved workflow (spec §5.1). Positions and shapes are kept apart
 * from the wiring, so a later Save can write the layout and the graph separately. Never sent anywhere.
 */
export interface Draft {
  /** The hub's centre, when moved. */
  sphere: Point | null;
  /** Top-left corners of moved steps. */
  steps: Record<Id, Point>;
  /** Top-left corners of moved cache tags. */
  caches: Record<Id, Point>;
  /** A step's whole next-step list, when its wires changed. */
  next: Record<Id, Id[]>;
  /** The hub's whole entry list, when it changed. */
  entries: Id[] | null;
  /** By wire id (`source->target`). */
  routes: Record<string, WireShape>;
}

export const EMPTY_DRAFT: Draft = { sphere: null, steps: {}, caches: {}, next: {}, entries: null, routes: {} };

const empty = (r: Record<string, unknown>) => Object.keys(r).length === 0;

export function isEmptyDraft(d: Draft): boolean {
  return d.sphere === null && d.entries === null && empty(d.steps) && empty(d.caches) && empty(d.next) && empty(d.routes);
}

export const wireId = (source: SourceId, target: Id): string => `${source}->${target}`;

export function wireEnds(id: string): { source: SourceId; target: Id } {
  const at = id.indexOf('->');
  return { source: id.slice(0, at), target: id.slice(at + 2) };
}

/** A copy with a null prototype, so an id such as `__proto__` is an ordinary key. */
function copy<T>(r: Record<string, T>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, r);
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const samePoint = (a: Point | undefined, b: Point) => a !== undefined && a.x === b.x && a.y === b.y;

export function entriesOf(saved: StudioDocument, draft: Draft): Id[] {
  return draft.entries ?? saved.graph.workflow.entryStepIds;
}

export function nextOf(saved: StudioDocument, draft: Draft, stepId: Id): Id[] {
  return Object.hasOwn(draft.next, stepId) ? draft.next[stepId]! : saved.graph.steps.get(stepId)?.nextStepIds ?? [];
}

/**
 * Moves blocks to new top-left corners, by React Flow node id (`wf`, `cache:{id}`, a step id). A block
 * moved back to where the saved workflow has it is dropped from the draft.
 */
export function moveBlocks(draft: Draft, saved: StudioDocument, moved: ReadonlyMap<string, Point>): Draft {
  let sphere = draft.sphere;
  const steps = copy(draft.steps), caches = copy(draft.caches);
  for (const [id, p] of moved) {
    const at = { x: p.x, y: p.y };
    if (id === SPHERE_NODE_ID) {
      const centre = { x: p.x + SPHERE_R, y: p.y + SPHERE_R };
      const s = saved.placement.sphere;
      sphere = centre.x === s.cx && centre.y === s.cy ? null : centre;
    } else if (id.startsWith(CACHE_NODE_PREFIX)) {
      const cacheId = id.slice(CACHE_NODE_PREFIX.length);
      if (samePoint(saved.placement.caches.get(cacheId), at)) delete caches[cacheId];
      else caches[cacheId] = at;
    } else if (samePoint(saved.placement.steps.get(id), at)) delete steps[id];
    else steps[id] = at;
  }
  return { ...draft, sphere, steps, caches };
}

/** Changes one source's target list; a list equal to the saved one is dropped from the draft. */
function setTargets(draft: Draft, saved: StudioDocument, source: SourceId, change: (ids: Id[]) => Id[]): Draft {
  if (source === WORKFLOW_SOURCE) {
    const entries = change(entriesOf(saved, draft));
    return { ...draft, entries: sameList(entries, saved.graph.workflow.entryStepIds) ? null : entries };
  }
  const list = change(nextOf(saved, draft, source));
  const next = copy(draft.next);
  if (sameList(list, saved.graph.steps.get(source)?.nextStepIds ?? [])) delete next[source];
  else next[source] = list;
  return { ...draft, next };
}

export function addWire(draft: Draft, saved: StudioDocument, source: SourceId, target: Id): Draft {
  return setTargets(draft, saved, source, (ids) => (ids.includes(target) ? ids : [...ids, target]));
}

export function removeWires(draft: Draft, saved: StudioDocument, ids: readonly string[]): Draft {
  let d = draft;
  for (const id of ids) {
    const { source, target } = wireEnds(id);
    d = resetRoute(setTargets(d, saved, source, (xs) => xs.filter((x) => x !== target)), id);
  }
  return d;
}

/** Moves one end of a wire to another block; the wire becomes automatic (spec §4.4). Wires joined onto it follow its new id (plan 7). */
export function reattach(draft: Draft, saved: StudioDocument, id: string, end: 'source' | 'target', to: SourceId): Draft {
  const { source, target } = wireEnds(id);
  const d = removeWires(draft, saved, [id]);
  const moved = end === 'target' ? addWire(d, saved, source, to) : addWire(d, saved, to, target);
  return renameHost(moved, id, end === 'target' ? wireId(source, to) : wireId(to, target));
}

function renameHost(draft: Draft, from: string, to: string): Draft {
  if (from === to) return draft;
  const routes = copy(draft.routes);
  for (const [k, s] of Object.entries(routes)) if (s.contact?.host === from) routes[k] = { ...s, contact: { ...s.contact, host: to } };
  return { ...draft, routes };
}

export function setShape(draft: Draft, id: string, shape: WireShape | null): Draft {
  const routes = copy(draft.routes);
  if (shape === null || (shape.bends === null && shape.landing === null && (shape.contact ?? null) === null)) delete routes[id];
  else routes[id] = shape;
  return { ...draft, routes };
}

export const resetRoute = (draft: Draft, id: string): Draft => setShape(draft, id, null);

// ---- session parsing: anything not of the draft's shape is dropped, never an error ----

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const toPoint = (v: unknown): Point | null => (isRecord(v) && isNum(v.x) && isNum(v.y) ? { x: v.x, y: v.y } : null);
const toIds = (v: unknown): Id[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : null);

function toBends(v: unknown): Bends | null {
  if (!isRecord(v) || !Array.isArray(v.xs) || !Array.isArray(v.ys)) return null;
  if (!v.xs.every(isNum) || !v.ys.every(isNum) || v.xs.length === 0 || v.ys.length !== v.xs.length - 1) return null;
  return { xs: [...v.xs], ys: [...v.ys] };
}

function records<T>(v: unknown, parse: (x: unknown) => T | null): Record<string, T> {
  const out = copy<T>({});
  if (!isRecord(v)) return out;
  for (const [k, raw] of Object.entries(v)) {
    const value = parse(raw);
    if (value !== null) out[k] = value;
  }
  return out;
}

/** The draft a session held, or null when it is not one at all. */
export function parseDraft(value: unknown): Draft | null {
  if (!isRecord(value)) return null;
  const routes = records(value.routes, (raw) => {
    if (!isRecord(raw)) return null;
    const c = raw.contact;
    const contact = isRecord(c) && typeof c.host === 'string' && c.host !== '' && isNum(c.at) ? { host: c.host, at: c.at } : null;
    const shape: WireShape = { bends: toBends(raw.bends), landing: isNum(raw.landing) ? raw.landing : null, contact };
    return shape.bends === null && shape.landing === null && contact === null ? null : shape;
  });
  return {
    sphere: toPoint(value.sphere),
    steps: records(value.steps, toPoint),
    caches: records(value.caches, toPoint),
    next: records(value.next, toIds),
    entries: toIds(value.entries),
    routes,
  };
}
