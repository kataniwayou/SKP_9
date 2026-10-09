import type { Point } from '../layout/geometry';
import { WORKFLOW_SOURCE, type SourceId } from '../layout/ports';
import type { Pt } from '../layout/router';
import { isNum, parseBends, shapeFromPoints, type Bends } from '../layout/shape';
import type { Id, Step } from '../model/graph';

/**
 * Where one end of a wire is (plan 9 §3). A tail on a step is on its right side (its output), a head on its left
 * side (its input); `y` is the step-local height along that side, null: automatic. The hub takes tails only, at
 * `angle` degrees round its ring (0 right, 90 down; null: automatic, its right side; `dy`: an automatic tail held at
 * its drawn height, that far below the hub's centre, review 2026-10-09). On a wire: a junction `at` px along the
 * host's drawn line. Open: connected to nothing, at a flow point.
 */
export type End =
  | { on: 'step'; step: Id; y: number | null }
  | { on: 'hub'; angle: number | null; dy?: number }
  | { on: 'wire'; host: string; at: number }
  | { on: 'open'; x: number; y: number };

export type Side = 'tail' | 'head';

/**
 * A one-way conductor from its tail to its head (plan 9 §3); `bends`: its own manual route (absent: automatic).
 * `held`: that end (on a step or the hub) was automatic and is held where it was drawn because the other end was
 * dropped open (the user's end drag, 2026-10-08); it goes back to automatic when the other end connects again.
 */
export interface CircuitWire {
  tail: End;
  head: End;
  bends?: Bends;
  held?: Side;
}

/** Every wire on the canvas by its id; a wire keeps its id for its whole life. */
export type Circuit = Record<string, CircuitWire>;

/** A wire made from the workflow's own lists: `source->target`. */
export const plainWireId = (source: SourceId, target: Id): string => `${source}->${target}`;
/** A wire drawn in the designer: `w:{guid}`. */
export const NEW_WIRE_PREFIX = 'w:';

/** The hub's ring takes a tail every 15 degrees. */
export const HUB_ANGLE_STEP = 15;
export function snapAngle(deg: number): number {
  const a = Math.round(deg / HUB_ANGLE_STEP) * HUB_ANGLE_STEP;
  return ((a % 360) + 360) % 360;
}

/** A null-prototype copy, so an id such as `__proto__` is an ordinary key. */
const copy = (c: Readonly<Circuit>): Circuit => Object.assign(Object.create(null) as Circuit, c);
const has = (c: Readonly<Circuit>, id: string): boolean => Object.hasOwn(c, id);

/** The workflow's own wiring: an automatic wire per entry step and per next step, both ends on the canvas. */
export function plainCircuit(entryStepIds: readonly Id[], steps: ReadonlyMap<Id, Step>, onCanvas: (id: Id) => boolean): Circuit {
  const c = copy({});
  const placed = (id: Id) => steps.has(id) && onCanvas(id);
  for (const id of new Set(entryStepIds)) {
    if (placed(id)) c[plainWireId(WORKFLOW_SOURCE, id)] = { tail: { on: 'hub', angle: null }, head: { on: 'step', step: id, y: null } };
  }
  for (const [id, step] of steps) {
    if (!placed(id)) continue;
    for (const next of step.nextStepIds) {
      if (placed(next)) c[plainWireId(id, next)] = { tail: { on: 'step', step: id, y: null }, head: { on: 'step', step: next, y: null } };
    }
  }
  return c;
}

export function sameEnd(a: End, b: End): boolean {
  switch (a.on) {
    case 'step': return b.on === 'step' && a.step === b.step && a.y === b.y;
    case 'hub': return b.on === 'hub' && a.angle === b.angle && (a.dy ?? null) === (b.dy ?? null);
    case 'wire': return b.on === 'wire' && a.host === b.host && a.at === b.at;
    case 'open': return b.on === 'open' && a.x === b.x && a.y === b.y;
  }
}

/** On the same thing: one step, the hub, one host wire, or open (anywhere). */
function sameFooting(a: End, b: End): boolean {
  if (a.on === 'step') return b.on === 'step' && a.step === b.step;
  if (a.on === 'wire') return b.on === 'wire' && a.host === b.host;
  return a.on === b.on;
}

const withBends = (tail: End, head: End, bends: Bends | null | undefined, held?: Side): CircuitWire => {
  const w: CircuitWire = bends && bends.xs.length > 0 ? { tail, head, bends } : { tail, head };
  if (held !== undefined) w.held = held;
  return w;
};

/** An end on a step or the hub back to automatic (its height or angle chosen by the router). */
const automatic = (e: End): End => (e.on === 'step' ? { on: 'step', step: e.step, y: null } : e.on === 'hub' ? { on: 'hub', angle: null } : e);
const otherSide = (side: Side): Side => (side === 'tail' ? 'head' : 'tail');

/**
 * One end moved (plan 9 §6). The bends stay while the end stays on what it was on (slid along its side, round the
 * hub, along its host, or an open end moved); onto anything else the wire is automatic again (plan 4 §4.4). A held
 * other end (`held`) stays held while this end is open; once this end connects again it goes back to automatic. The
 * held end moved itself is the user's from then on: no longer held.
 */
export function setEnd(c: Readonly<Circuit>, id: string, side: Side, end: End): Circuit {
  if (!has(c, id)) return c as Circuit;
  const w = c[id]!;
  const out = copy(c);
  const keep = sameFooting(w[side], end) ? w.bends : undefined;
  const other = otherSide(side);
  let far = w[other], held: Side | undefined;
  if (w.held === other) {
    if (end.on === 'open') held = other;
    else far = automatic(far);
  }
  out[id] = side === 'tail' ? withBends(end, far, keep, held) : withBends(far, end, keep, held);
  return out;
}

/** End `side` of wire `id` held where it is drawn (`end`: its step and height, or the hub and an angle), bends kept. */
export function holdEnd(c: Readonly<Circuit>, id: string, side: Side, end: End): Circuit {
  if (!has(c, id)) return c as Circuit;
  const w = c[id]!;
  const out = copy(c);
  out[id] = side === 'tail' ? withBends(end, w.head, w.bends, side) : withBends(w.tail, end, w.bends, side);
  return out;
}

/** A wire's own route; null or none: the router draws it. */
export function setBends(c: Readonly<Circuit>, id: string, bends: Bends | null): Circuit {
  if (!has(c, id)) return c as Circuit;
  const w = c[id]!;
  const out = copy(c);
  out[id] = withBends(w.tail, w.head, bends, w.held);
  return out;
}

export function addCircuitWire(c: Readonly<Circuit>, id: string, w: CircuitWire): Circuit {
  const out = copy(c);
  out[id] = w;
  return out;
}

/**
 * The circuit without the wires `gone`, every end on a wire of `hosts` open where it is drawn (`pointOf`), its wire
 * keeping its bends. `c` itself when nothing changes.
 */
function opening(
  c: Readonly<Circuit>, hosts: ReadonlySet<string>, gone: ReadonlySet<string>, pointOf: (id: string, side: Side) => Point | null,
): Circuit {
  const out = copy({});
  let changed = false;
  for (const [id, w] of Object.entries(c)) {
    if (gone.has(id)) { changed = true; continue; }
    const opened = (side: Side): End => {
      const e = w[side];
      if (e.on !== 'wire' || !hosts.has(e.host)) return e;
      const p = pointOf(id, side) ?? { x: 0, y: 0 };
      return { on: 'open', x: p.x, y: p.y };
    };
    const tail = opened('tail'), head = opened('head');
    if (tail === w.tail && head === w.head) out[id] = w;
    else { out[id] = withBends(tail, head, w.bends, w.held); changed = true; }
  }
  return changed ? out : (c as Circuit);
}

/**
 * Wires removed (Delete, plan 9 §2.2-6): a wire joined on a removed one keeps its place, that end open where it is
 * drawn (`pointOf`), its bends kept.
 */
export function removeCircuitWires(c: Readonly<Circuit>, ids: readonly string[], pointOf: (id: string, side: Side) => Point | null): Circuit {
  const gone = new Set(ids.filter((id) => has(c, id)));
  if (gone.size === 0) return c as Circuit;
  return opening(c, gone, gone, pointOf);
}

/**
 * Hosts detached (plan 9 §2.2-6: an end of each dropped open): the wires joined on them keep their place, those ends
 * open where they are drawn (`pointOf`), their bends kept; the hosts themselves stay as they are. `c` itself when
 * nothing is joined on them.
 */
export function openJoinedOn(c: Readonly<Circuit>, hostIds: readonly string[], pointOf: (id: string, side: Side) => Point | null): Circuit {
  const hosts = new Set(hostIds.filter((id) => has(c, id)));
  if (hosts.size === 0) return c as Circuit;
  return opening(c, hosts, new Set(), pointOf);
}

/**
 * A wire moved whole (the user's body drag, 2026-10-08): `points` is its drawn path already moved. It detaches from
 * everything: its tail and head open where that path starts and ends (a junction end of its own too), its shape kept
 * as its bends; the ends joined on it open where they are drawn (`pointOf`, spec §2.2-6). `c` itself when it is gone.
 */
export function moveWire(c: Readonly<Circuit>, id: string, points: readonly Pt[], pointOf: (id: string, side: Side) => Point | null): Circuit {
  if (!has(c, id) || points.length < 2) return c as Circuit;
  const [x0, y0] = points[0]!, [x1, y1] = points[points.length - 1]!;
  const out = copy(c);
  // a straight wire keeps a one-run shape too (one vertical run of no length at its tail), so it stays where it is
  // put instead of being routed around a block
  const shape = shapeFromPoints(points);
  out[id] = withBends({ on: 'open', x: x0, y: y0 }, { on: 'open', x: x1, y: y1 }, shape.xs.length > 0 ? shape : { xs: [x0], ys: [] });
  return openJoinedOn(out, [id], pointOf);
}

/** On a step or the hub: an end that gives its wire a direction (the user's rule D, 2026-10-09). */
export const isTerminalEnd = (e: End): boolean => e.on === 'step' || e.on === 'hub';

/**
 * A direction-less wire (the user's rule D, 2026-10-09): neither end on a step or the hub (open, or joined on another
 * wire's line). It has no head and no tail yet: its two ends are only named `tail` and `head` for storage; the first
 * end that lands on a step or the hub decides which is which.
 */
export const isFree = (w: CircuitWire): boolean => !isTerminalEnd(w.tail) && !isTerminalEnd(w.head);

/** The same shape drawn the other way round: its verticals and the runs between them in reverse order. */
export const reverseBends = (b: Bends): Bends => ({ xs: [...b.xs].reverse(), ys: [...b.ys].reverse() });

/**
 * Lifted by its `side` end, wire `w` is direction-less (rule D, review 2026-10-09): its other end is on no step or hub.
 * Dropping that end decides the wire's direction afresh, as for a wire with no direction at all.
 */
export const freeWithout = (w: CircuitWire, side: Side): boolean => !isTerminalEnd(w[otherSide(side)]);

/**
 * Wire `id` turned round (rule D: a direction-less wire's end that lands on a step's input is its head, on an output
 * or the hub its tail): tail and head swapped, its bends reversed, a held end still the same end. Same id. `length`
 * is its drawn length: the ends joined on it keep their point on that line, a junction's distance being measured from
 * the host's tail (`length - at`). A drop that also re-draws the wire places them again (`applyDrop`).
 */
export function reverseWire(c: Readonly<Circuit>, id: string, length: number): Circuit {
  if (!has(c, id)) return c as Circuit;
  const w = c[id]!;
  const out = copy(c);
  out[id] = withBends(w.head, w.tail, w.bends ? reverseBends(w.bends) : null, w.held === undefined ? undefined : otherSide(w.held));
  const remap = (e: End): End => (e.on === 'wire' && e.host === id ? { on: 'wire', host: id, at: Math.max(0, length - e.at) } : e);
  for (const [k, x] of Object.entries(out)) {
    if (k === id) continue;
    const tail = remap(x.tail), head = remap(x.head);
    if (tail !== x.tail || head !== x.head) out[k] = withBends(tail, head, x.bends, x.held);
  }
  return out;
}

/** Shaped by hand: its own bends, an end slid along a step's side, or a hub tail held at its height (Reset route has something to undo). */
export const shapedByHand = (w: CircuitWire): boolean =>
  (w.bends?.xs.length ?? 0) > 0 || (w.tail.on === 'step' && w.tail.y !== null) || (w.head.on === 'step' && w.head.y !== null)
  // a hub tail held at its drawn height (review 2026-10-09)
  || (w.tail.on === 'hub' && w.tail.dy !== undefined);

// ---- reading back: a session's or a stored layout's circuit, or a plan 7 / plan 8 one; anything malformed is dropped ----

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === 'string' && v !== '';

function toEnd(v: unknown): End | null {
  if (!isRecord(v)) return null;
  switch (v.on) {
    case 'step': return isId(v.step) ? { on: 'step', step: v.step, y: isNum(v.y) ? v.y : null } : null;
    case 'hub': return isNum(v.angle) ? { on: 'hub', angle: snapAngle(v.angle) } : isNum(v.dy) ? { on: 'hub', angle: null, dy: v.dy } : { on: 'hub', angle: null };
    case 'wire': return isId(v.host) && isNum(v.at) ? { on: 'wire', host: v.host, at: v.at } : null;
    case 'open': return isNum(v.x) && isNum(v.y) ? { on: 'open', x: v.x, y: v.y } : null;
    default: return null;
  }
}

/** A circuit as it serializes; null when the value is not a record at all. A head on the hub is no wire. */
export function parseCircuit(v: unknown): Circuit | null {
  if (!isRecord(v)) return null;
  const out = copy({});
  for (const [id, raw] of Object.entries(v)) {
    if (!isRecord(raw)) continue;
    const tail = toEnd(raw.tail), head = toEnd(raw.head);
    if (!tail || !head || head.on === 'hub') continue;
    const held = raw.held === 'tail' || raw.held === 'head' ? raw.held : undefined;
    out[id] = withBends(tail, head, parseBends(raw.bends), held);
  }
  return out;
}

const terminal = (source: SourceId): End => (source === WORKFLOW_SOURCE ? { on: 'hub', angle: null } : { on: 'step', step: source, y: null });
const contactOf = (v: unknown): End | null => (isRecord(v) && isId(v.host) && isNum(v.at) ? { on: 'wire', host: v.host, at: v.at } : null);
const pointOf = (v: unknown): End | null => (isRecord(v) && isNum(v.x) && isNum(v.y) ? { on: 'open', x: v.x, y: v.y } : null);

function legacyLoose(raw: Record<string, unknown>): CircuitWire | null {
  const bends = parseBends(raw.bends);
  if (raw.open === 'start') {
    const tail = pointOf(raw.start);
    if (!tail || !isId(raw.target)) return null;
    return withBends(tail, contactOf(raw.contact) ?? { on: 'step', step: raw.target, y: isNum(raw.landing) ? raw.landing : null }, bends);
  }
  if (raw.open === 'both') {
    const tail = pointOf(raw.start), head = pointOf(raw.end);
    return tail && head ? withBends(tail, head, bends) : null;
  }
  const head = pointOf(raw.end);
  return head && isId(raw.source) ? withBends(terminal(raw.source), head, bends) : null;
}

/**
 * A plan 7 / plan 8 draft's or layout's wires (spec §8): a shaped wire `s->t` keeps its id, its bends, its slid
 * landing (its head's height) and its junction (a head junction); loose wire `k` becomes `w:k`: its source a tail on
 * that terminal, an open end open, a start-loose wire's target or junction its head. Null when there is none.
 */
export function legacyCircuit(routes: unknown, loose: unknown): Circuit | null {
  const out = copy({});
  let any = false;
  if (isRecord(routes)) {
    for (const [id, raw] of Object.entries(routes)) {
      const at = id.indexOf('->');
      if (at <= 0 || at + 2 >= id.length || !isRecord(raw)) continue;
      const head = contactOf(raw.contact) ?? { on: 'step', step: id.slice(at + 2), y: isNum(raw.landing) ? raw.landing : null };
      out[id] = withBends(terminal(id.slice(0, at)), head, parseBends(raw.bends));
      any = true;
    }
  }
  if (isRecord(loose)) {
    for (const [k, raw] of Object.entries(loose)) {
      const w = isRecord(raw) ? legacyLoose(raw) : null;
      if (w) { out[`${NEW_WIRE_PREFIX}${k}`] = w; any = true; }
    }
  }
  return any ? out : null;
}
