import type { StudioDocument } from '../app/document';
import { legacyCircuit, parseCircuit, plainCircuit, removeCircuitWires, shapedByHand, type Circuit, type CircuitWire, type End, type Side } from '../circuit/circuit';
import { circuitTrace } from '../circuit/families';
import { SPHERE_R, type Point } from '../layout/geometry';
import { CACHE_NODE_PREFIX, SPHERE_NODE_ID } from '../layout/nodeIds';
import { WORKFLOW_SOURCE } from '../layout/ports';
import { isNum, type Bends } from '../layout/shape';
import type { Id } from '../model/graph';

export type { Bends } from '../layout/shape';

/**
 * What the user changed relative to the saved workflow (spec §5.1; plan 9 §3). Positions apart from the circuit;
 * the lists are what the circuit's current gives, kept where they differ from the saved workflow's. Never sent as is.
 */
export interface Draft {
  /** The hub's centre, when moved. */
  sphere: Point | null;
  /** Top-left corners of moved steps. */
  steps: Record<Id, Point>;
  /** Top-left corners of moved cache tags. */
  caches: Record<Id, Point>;
  /** A step's whole next-step list where the circuit gives another one than the saved workflow (derived, plan 9 §7). */
  next: Record<Id, Id[]>;
  /** The hub's entry list, when the circuit gives another one (derived). */
  entries: Id[] | null;
  /** The whole circuit by wire id (plan 9 §3); null: the saved workflow's own wires, automatic. */
  wires: Circuit | null;
}

export const EMPTY_DRAFT: Draft = { sphere: null, steps: {}, caches: {}, next: {}, entries: null, wires: null };

const empty = (r: Record<string, unknown>) => Object.keys(r).length === 0;

export function isEmptyDraft(d: Draft): boolean {
  return d.sphere === null && d.entries === null && d.wires === null && empty(d.steps) && empty(d.caches) && empty(d.next);
}

/** A copy with a null prototype, so an id such as `__proto__` is an ordinary key. */
function copy<T>(r: Record<string, T>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, r);
}

/** Two id lists with the same ids in the same order. */
export const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
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

/** The circuit the canvas shows: the draft's own, else the saved workflow's wires (plan 9 decision 2). */
export function circuitOf(saved: StudioDocument, draft: Draft): Circuit {
  return draft.wires ?? plainCircuit(saved.graph.workflow.entryStepIds, saved.graph.steps, (id) => saved.placement.steps.has(id));
}

/**
 * The saved list's order first, then what is new: an unchanged list compares equal. A saved id the circuit cannot
 * draw (a step the workflow does not have, or one not on the canvas) stays where it was: no wire can say otherwise.
 */
function ordered(saved: readonly Id[], derived: readonly Id[], drawable: (id: Id) => boolean): Id[] {
  const set = new Set(derived);
  return [...saved.filter((id) => set.has(id) || !drawable(id)), ...derived.filter((id) => !saved.includes(id))];
}

/**
 * The next-step lists and the entry list the circuit's current gives (plan 9 §7), for every step of the saved
 * workflow, in its order; links through a short-circuited net are left out (§2.2-7), and so is a step it does not have.
 */
export function listsOf(saved: StudioDocument, circuit: Readonly<Circuit>): { next: Map<Id, Id[]>; entries: Id[] } {
  const { links } = circuitTrace(circuit, (id) => saved.graph.steps.get(id)?.entryCondition);
  const known = (ids: readonly Id[]) => ids.filter((id) => saved.graph.steps.has(id));
  const drawable = (id: Id) => saved.graph.steps.has(id) && saved.placement.steps.has(id);
  const next = new Map<Id, Id[]>();
  for (const [id, step] of saved.graph.steps) {
    // a step off the canvas has no wires: its list stays the saved one; a step's own id in its list is not drawn
    // (the current never feeds a step itself, §2.2-4), so a saved self-link stays where it was and is never added
    next.set(id, drawable(id) ? ordered(step.nextStepIds, known(links.get(id) ?? []), (t) => t !== id && drawable(t)) : step.nextStepIds);
  }
  return { next, entries: ordered(saved.graph.workflow.entryStepIds, known(links.get(WORKFLOW_SOURCE) ?? []), drawable) };
}

/** A circuit as text that does not depend on key order: two circuits that draw the same compare equal. */
function circuitKey(c: Readonly<Circuit>): string {
  const sorted = (v: unknown): unknown => (v !== null && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]))
    : v);
  return JSON.stringify(sorted(c));
}

/** The circuit is the saved workflow's own wires, automatic: the draft has no circuit of its own. */
export const isPlainCircuit = (saved: StudioDocument, c: Readonly<Circuit>): boolean => circuitKey(c) === circuitKey(circuitOf(saved, EMPTY_DRAFT));

/**
 * The draft with this circuit, its lists derived again (decision 2): a list equal to the saved one is left out, and
 * a circuit equal to the saved workflow's own wires is none of the draft's (null), so a change undone by hand, such as
 * Reset route, leaves nothing to save.
 */
export function withCircuit(draft: Draft, saved: StudioDocument, wires: Circuit): Draft {
  const lists = listsOf(saved, wires);
  const next = copy<Id[]>({});
  for (const [id, list] of lists.next) if (!sameList(list, saved.graph.steps.get(id)?.nextStepIds ?? [])) next[id] = list;
  const entries = sameList(lists.entries, saved.graph.workflow.entryStepIds) ? null : lists.entries;
  const plain = entries === null && Object.keys(next).length === 0 && isPlainCircuit(saved, wires);
  return { ...draft, wires: plain ? null : wires, next, entries };
}

/** Wires removed (Delete, plan 9 §6): a wire joined on one keeps its place, that end open where it is drawn (§2.2-6). */
export function removeWires(draft: Draft, saved: StudioDocument, ids: readonly string[], pointOf: (id: string, side: Side) => Point | null): Draft {
  const c = circuitOf(saved, draft);
  const next = removeCircuitWires(c, ids, pointOf);
  return next === c ? draft : withCircuit(draft, saved, next);
}

/** A wire's own route and its head's height on its step (plan 4's shape); null bends: the router draws it. */
export function setShape(draft: Draft, saved: StudioDocument, id: string, shape: { bends: Bends | null; landing: number | null }): Draft {
  const c = circuitOf(saved, draft);
  if (!Object.hasOwn(c, id)) return draft;
  const w = c[id]!;
  const head: End = w.head.on === 'step' ? { on: 'step', step: w.head.step, y: shape.landing } : w.head;
  const out = copy<CircuitWire>(c);
  out[id] = shape.bends && shape.bends.xs.length > 0 ? { tail: w.tail, head, bends: shape.bends } : { tail: w.tail, head };
  return withCircuit(draft, saved, out);
}

/**
 * Reset route (decision 11): its bends go and its ends on steps go back to automatic heights, a hub tail held at its
 * height too (and nothing is held any more); what it is connected to stays.
 */
export function resetShape(draft: Draft, saved: StudioDocument, id: string): Draft {
  const c = circuitOf(saved, draft);
  if (!Object.hasOwn(c, id) || !shapedByHand(c[id]!)) return draft;
  const w = c[id]!;
  const auto = (e: End): End => (e.on === 'step' ? { on: 'step', step: e.step, y: null } : e.on === 'hub' && e.dy !== undefined ? { on: 'hub', angle: null } : e);
  const out = copy<CircuitWire>(c);
  out[id] = { tail: auto(w.tail), head: auto(w.head) };
  return withCircuit(draft, saved, out);
}

// ---- session parsing: anything not of the draft's shape is dropped, never an error ----

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const toPoint = (v: unknown): Point | null => (isRecord(v) && isNum(v.x) && isNum(v.y) ? { x: v.x, y: v.y } : null);
const toIds = (v: unknown): Id[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : null);

function records<T>(v: unknown, parse: (x: unknown) => T | null): Record<string, T> {
  const out = copy<T>({});
  if (!isRecord(v)) return out;
  for (const [k, raw] of Object.entries(v)) {
    const value = parse(raw);
    if (value !== null) out[k] = value;
  }
  return out;
}

/**
 * The draft a session held, or null when it is not one at all. A plan 9 draft brings its circuit; a plan 7 / plan 8
 * one its shapes and loose wires as wires (spec §8), and one that rewired steps but shaped nothing an empty circuit:
 * settling makes either whole when the workflow loads (decision 6).
 */
export function parseDraft(value: unknown): Draft | null {
  if (!isRecord(value)) return null;
  const next = records(value.next, toIds);
  const entries = toIds(value.entries);
  const wires = Object.hasOwn(value, 'wires') ? parseCircuit(value.wires) : legacyCircuit(value.routes, value.loose);
  const rewired = Object.keys(next).length > 0 || entries !== null;
  return {
    sphere: toPoint(value.sphere),
    steps: records(value.steps, toPoint),
    caches: records(value.caches, toPoint),
    next,
    entries,
    wires: wires ?? (rewired ? copy<CircuitWire>({}) : null),
  };
}
