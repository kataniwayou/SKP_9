import type { StudioDocument } from '../app/document';
import { SPHERE_R, type Point } from '../layout/geometry';
import { CACHE_NODE_PREFIX, SPHERE_NODE_ID } from '../layout/nodeIds';
import { WORKFLOW_SOURCE, type SourceId } from '../layout/ports';
import type { Bends, Contact, WireShape } from '../layout/shape';
import { isLooseStart, type LooseEnd, type LooseStart, type LooseWire } from '../layout/wires';
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
  /** Loose wires by id (plan 8 §5): from a source to an open end, or from an open start to a target; never part of the wiring. */
  loose: Record<string, LooseWire>;
}

export const EMPTY_DRAFT: Draft = { sphere: null, steps: {}, caches: {}, next: {}, entries: null, routes: {}, loose: {} };

const empty = (r: Record<string, unknown>) => Object.keys(r).length === 0;

export function isEmptyDraft(d: Draft): boolean {
  return d.sphere === null && d.entries === null && empty(d.steps) && empty(d.caches) && empty(d.next) && empty(d.routes) && empty(d.loose);
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

/** A pick of a loose wire is `loose:{id}` (plan 8): it never collides with a wire id `source->target`. */
export const LOOSE_PREFIX = 'loose:';

export function addLoose(draft: Draft, id: string, source: SourceId, end: Point): Draft {
  const loose = copy(draft.loose);
  loose[id] = { source, end: { x: end.x, y: end.y } };
  return { ...draft, loose };
}

/** The loose wire open at its head with this id, if any. */
const looseEnd = (draft: Draft, id: string): LooseEnd | null => {
  const l = Object.hasOwn(draft.loose, id) ? draft.loose[id]! : null;
  return l && !isLooseStart(l) ? l : null;
};
/** The loose wire open at its start with this id, if any. */
const looseStart = (draft: Draft, id: string): LooseStart | null => {
  const l = Object.hasOwn(draft.loose, id) ? draft.loose[id]! : null;
  return l && isLooseStart(l) ? l : null;
};

function putLoose(draft: Draft, id: string, l: LooseWire): Draft {
  const loose = copy(draft.loose);
  loose[id] = l;
  return { ...draft, loose };
}

/** Its open end (or open start) moved: its bends stay, as a connected wire's do when an end moves but stays on the same block (spec §4.3). */
export function moveLoose(draft: Draft, id: string, to: Point): Draft {
  if (!Object.hasOwn(draft.loose, id)) return draft;
  const l = draft.loose[id]!;
  const at = { x: to.x, y: to.y };
  return putLoose(draft, id, isLooseStart(l) ? { ...l, start: at } : { ...l, end: at });
}

/** Reset route (spec §4.3) by pick id: a connected wire's shape goes; a loose wire (`loose:{id}`) loses its bends, keeping its ends (a start-loose wire its head). */
export function resetShape(draft: Draft, wireId: string): Draft {
  if (!wireId.startsWith(LOOSE_PREFIX)) return resetRoute(draft, wireId);
  const id = wireId.slice(LOOSE_PREFIX.length);
  const s = looseStart(draft, id);
  if (s) return shapeLooseStart(draft, id, { bends: null, landing: s.landing, contact: s.contact });
  const e = looseEnd(draft, id);
  return e ? shapeLoose(draft, id, null, e.end) : draft;
}

/** Its start moved to another source: automatic again, as a connected wire's re-attached tail is (spec §4.4). */
export function resourceLoose(draft: Draft, id: string, source: SourceId): Draft {
  const e = looseEnd(draft, id);
  return e ? addLoose(draft, id, source, e.end) : draft;
}

/**
 * A loose wire's own shape (a run dragged): its bends, as a connected wire's in `routes`, and its open end (its
 * last run slid moves the end up or down). Null bends: the router draws it again. Its source stays.
 */
export function shapeLoose(draft: Draft, id: string, bends: Bends | null, end: Point): Draft {
  const e = looseEnd(draft, id);
  if (!e) return draft;
  const d = addLoose(draft, id, e.source, end);
  if (bends && bends.xs.length > 0) d.loose[id] = { ...e, end: { x: end.x, y: end.y }, bends };
  return d;
}

/** A start-loose wire's own shape, as a connected wire's in `routes`: its bends (null: the router draws it), its landing and junction. Its start and target stay. */
export function shapeLooseStart(draft: Draft, id: string, shape: WireShape): Draft {
  const s = looseStart(draft, id);
  if (!s) return draft;
  const l: LooseStart = { open: 'start', target: s.target, start: s.start, landing: shape.landing, contact: shape.contact ?? null };
  return putLoose(draft, id, shape.bends && shape.bends.xs.length > 0 ? { ...l, bends: shape.bends } : l);
}

/** The bends a wire keeps in the draft, by its pick id: a connected wire's in `routes`, a loose one's (`loose:{id}`) its own. */
export function storedBends(draft: Draft, wireId: string): Bends | undefined {
  if (wireId.startsWith(LOOSE_PREFIX)) {
    const id = wireId.slice(LOOSE_PREFIX.length);
    return Object.hasOwn(draft.loose, id) ? draft.loose[id]!.bends : undefined;
  }
  return Object.hasOwn(draft.routes, wireId) ? draft.routes[wireId]!.bends ?? undefined : undefined;
}

export function removeLoose(draft: Draft, ids: readonly string[]): Draft {
  const loose = copy(draft.loose);
  for (const id of ids) delete loose[id];
  return { ...draft, loose };
}

/** A loose wire's open end dropped on a step it may wire to: it becomes an ordinary wire (spec §5). */
export function attachLoose(draft: Draft, saved: StudioDocument, id: string, target: Id): Draft {
  const e = looseEnd(draft, id);
  return e ? addWire(removeLoose(draft, [id]), saved, e.source, target) : draft;
}

/** A wire's head released where it attaches to nothing: it leaves the wiring and stays drawn, loose from its source (spec §5). */
export function loosen(draft: Draft, saved: StudioDocument, id: string, looseId: string, end: Point): Draft {
  return addLoose(removeWires(draft, saved, [id]), looseId, wireEnds(id).source, end);
}

/**
 * A wire's tail released where it attaches to nothing (an entry wire's off the hub too): it leaves the wiring and
 * stays drawn, loose at its start there, keeping its head (its target, `landing` and junction), so its colour.
 * Like a released head, it becomes automatic: its bends go.
 */
export function loosenStart(draft: Draft, saved: StudioDocument, id: string, looseId: string, start: Point, landing: number | null): Draft {
  const contact = Object.hasOwn(draft.routes, id) ? draft.routes[id]!.contact ?? null : null;
  const l: LooseStart = { open: 'start', target: wireEnds(id).target, start: { x: start.x, y: start.y }, landing, contact };
  return putLoose(removeWires(draft, saved, [id]), looseId, l);
}

/** A start-loose wire's open start dropped on a step or the hub it may start from: an ordinary wire again, its head (landing, junction) unchanged. */
export function attachLooseStart(draft: Draft, saved: StudioDocument, id: string, source: SourceId): Draft {
  const s = looseStart(draft, id);
  if (!s) return draft;
  const wired = addWire(removeLoose(draft, [id]), saved, source, s.target);
  return setShape(wired, wireId(source, s.target), { bends: null, landing: s.landing, contact: s.contact });
}

/**
 * A start-loose wire's head dropped on another step: it lands there, automatic and on no line (as a re-attached
 * head, spec §4.4); `keepJunction` (a joined wire's arrow re-attached, plan 7 §6.2): its junction and bends stay.
 */
export function retargetLooseStart(draft: Draft, id: string, target: Id, landing: number | null, keepJunction = false): Draft {
  const s = looseStart(draft, id);
  if (!s) return draft;
  return putLoose(draft, id, keepJunction ? { ...s, target, landing } : { open: 'start', target, start: s.start, landing, contact: null });
}

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

const toContact = (c: unknown): Contact | null => (isRecord(c) && typeof c.host === 'string' && c.host !== '' && isNum(c.at) ? { host: c.host, at: c.at } : null);

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
    const contact = toContact(raw.contact);
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
    loose: records(value.loose, (raw): LooseWire | null => {
      if (!isRecord(raw)) return null;
      const bends = toBends(raw.bends);
      // open at its start; anything else (every record stored before tails could be detached) is open at its head
      if (raw.open === 'start') {
        const start = toPoint(raw.start);
        if (typeof raw.target !== 'string' || raw.target === '' || !start) return null;
        const l: LooseStart = { open: 'start', target: raw.target, start, landing: isNum(raw.landing) ? raw.landing : null, contact: toContact(raw.contact) };
        return bends ? { ...l, bends } : l;
      }
      const end = toPoint(raw.end);
      if (typeof raw.source !== 'string' || raw.source === '' || !end) return null;
      return bends ? { source: raw.source, end, bends } : { source: raw.source, end };
    }),
  };
}
