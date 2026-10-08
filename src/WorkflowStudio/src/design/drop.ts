import type { StudioDocument } from '../app/document';
import { isFree, reverseBends, reverseWire, setBends, setEnd, snapAngle, type Circuit, type End, type Side } from '../circuit/circuit';
import { netsOf } from '../circuit/families';
import { loopWires, trace } from '../circuit/trace';
import { contactOn } from '../layout/circuitRoute';
import { clampLanding, snap, SPHERE_R, STEP_W, type Point } from '../layout/geometry';
import { CACHE_NODE_PREFIX, SPHERE_NODE_ID } from '../layout/nodeIds';
import type { Bends } from '../layout/shape';
import type { Id } from '../model/graph';

/** What a dragged end is over (plan 9 §6): a step's input or output side, the hub's ring, a wire's line, or nothing. */
export type DropTarget =
  | { on: 'step'; step: Id; side: 'in' | 'out'; y: number }
  | { on: 'hub'; angle: number }
  | { on: 'wire'; host: string; at: number }
  | { on: 'open'; x: number; y: number };

/** `needsStep`: a direction-less wire already joined on one wire's line, its other end onto another line (rule D). */
export type Refusal = 'wrongSide' | 'sameStep' | 'sameWire' | 'short' | 'hubTail' | 'needsStep';
/** `connect`: onto a terminal; `join`: onto a wire; `move`: the end is or stays open there (decision 12). */
export type Verdict = 'connect' | 'join' | 'move' | Refusal;

/** The end a drop makes. */
export function endOf(t: DropTarget): End {
  switch (t.on) {
    case 'step': return { on: 'step', step: t.step, y: t.y };
    case 'hub': return { on: 'hub', angle: t.angle };
    case 'wire': return { on: 'wire', host: t.host, at: t.at };
    case 'open': return { on: 'open', x: t.x, y: t.y };
  }
}

/** The circuit as it is before a drop: its loop wires, its links, and each wire's families (on first use). */
export interface BeforeDrop {
  looped: ReadonlySet<string>;
  links: ReadonlyMap<string, readonly string[]>;
  families: () => ReadonlyMap<string, readonly number[]>;
}

const befores = new WeakMap<Readonly<Circuit>, { shown: StudioDocument; before: BeforeDrop }>();

/**
 * The state before the drop (final review M2): the dragged wire's circuit stays the same for the whole drag, so it is
 * worked out once per circuit and document and every pointer move of the drag reuses it.
 */
export function beforeDrop(shown: StudioDocument, circuit: Readonly<Circuit>): BeforeDrop {
  const hit = befores.get(circuit);
  if (hit && hit.shown === shown) return hit.before;
  let had: Map<string, readonly number[]> | null = null;
  const before: BeforeDrop = {
    looped: loopWires(circuit),
    links: trace(circuit).links,
    families: () => {
      if (had === null) {
        had = new Map();
        for (const n of netsOf(circuit, (s: Id) => shown.graph.steps.get(s)?.entryCondition)) for (const x of n.wires) had.set(x, n.families);
      }
      return had;
    },
  };
  befores.set(circuit, { shown, before });
  return before;
}

/**
 * What dropping wire `id`'s `side` end on `t` does (plan 9 §3, §4, §6; decision 7). Open anywhere ('move'); a step
 * side or the hub ('connect'); a wire ('join'). Refused: a head on a step's output or a tail on its input
 * ('wrongSide'), a head on the hub ('hubTail'), both ends on one step ('sameStep'), an end on its own wire or both
 * ends on one wire ('sameWire'); then a wire brought onto a closed loop of wires ('short'; a loop already there
 * elsewhere does not hide a new one), a step fed its own input through junctions ('sameStep'), and a family
 * brought into a net that then holds two or more ('short'). A loop, a
 * self-feed or a short circuit already there before the drop does not refuse it: in a net already shorted (an
 * Inspector edit) an end may still slide along its side or its host, as long as no wire of the net gains a family.
 * A direction-less wire (rule D, 2026-10-09) is never told the wrong side or "only a tail": the step side or the hub
 * makes this end its head or its tail, and the drop is judged on the wire turned that way; joined on one line, its
 * other end onto another line is "needs a step first".
 */
export function judgeDrop(shown: StudioDocument, circuit: Readonly<Circuit>, id: string, side: Side, t: DropTarget): Verdict {
  if (!Object.hasOwn(circuit, id) || t.on === 'open') return 'move';
  const w = circuit[id]!;
  const other = side === 'tail' ? w.head : w.tail;
  // a direction-less wire (rule D): the step side or the hub decides which end this is, and the rest is judged on the
  // wire turned that way; a second line to join it on needs a step first
  if (isFree(w)) {
    if (t.on === 'wire' && other.on === 'wire' && other.host !== t.host && t.host !== id) return 'needsStep';
    const role = roleOf(t);
    if (role !== null && role !== side) return judgeDrop(shown, reversed(circuit, id), id, role, t);
  }
  if (t.on === 'hub') {
    if (side === 'head') return 'hubTail';
  } else if (t.on === 'step') {
    if ((side === 'head') !== (t.side === 'in')) return 'wrongSide';
    if (other.on === 'step' && other.step === t.step) return 'sameStep';
  } else {
    if (t.host === id || (other.on === 'wire' && other.host === t.host)) return 'sameWire';
    if (!Object.hasOwn(circuit, t.host)) return 'move';
  }
  const after = setEnd(circuit, id, side, endOf(t));
  const before = beforeDrop(shown, circuit);
  for (const x of loopWires(after)) if (!before.looped.has(x)) return 'short';
  for (const [s, ts] of trace(after).links) if (ts.includes(s) && !before.links.get(s)?.includes(s)) return 'sameStep';
  const net = netsOf(after, (s: Id) => shown.graph.steps.get(s)?.entryCondition).find((n) => n.wires.includes(id));
  if (net && net.families.length > 1) {
    const had = before.families();
    if (net.wires.some((x) => net.families.some((f) => !(had.get(x) ?? []).includes(f)))) return 'short';
  }
  return t.on === 'wire' ? 'join' : 'connect';
}

/**
 * What end a drop on `t` makes of a direction-less wire's end (rule D): on a step's input its head, on a step's output
 * or the hub its tail; null on a line or nothing (no direction yet).
 */
export function roleOf(t: DropTarget): Side | null {
  if (t.on === 'step') return t.side === 'in' ? 'head' : 'tail';
  return t.on === 'hub' ? 'tail' : null;
}

const turned = new WeakMap<Readonly<Circuit>, Map<string, Circuit>>();
/** `reverseWire`, the same circuit object for the same circuit and wire, so a drag's judging reuses `beforeDrop`. */
function reversed(circuit: Readonly<Circuit>, id: string): Circuit {
  let byId = turned.get(circuit);
  if (!byId) { byId = new Map(); turned.set(circuit, byId); }
  let c = byId.get(id);
  if (!c) { c = reverseWire(circuit, id); byId.set(id, c); }
  return c;
}

/**
 * The circuit with wire `id`'s `side` end dropped on `t` (any verdict but a refusal), and which end it is now: a
 * direction-less wire is turned round first when the drop makes this end the other one (rule D; `side` the new name).
 * `keep`: the shape drawn from the tail before the drop, kept (turned with the wire); undefined: `setEnd`'s rule.
 */
export function applyDrop(circuit: Readonly<Circuit>, id: string, side: Side, t: DropTarget, keep?: Bends | null): { circuit: Circuit; side: Side } {
  if (!Object.hasOwn(circuit, id)) return { circuit: circuit as Circuit, side };
  const role = isFree(circuit[id]!) ? roleOf(t) : null;
  const turn = role !== null && role !== side;
  const c = turn ? reverseWire(circuit, id) : (circuit as Circuit);
  const s: Side = turn ? role : side;
  let next = setEnd(c, id, s, endOf(t));
  if (keep !== undefined) next = setBends(next, id, keep && turn ? reverseBends(keep) : keep);
  return { circuit: next, side: s };
}

/** The label next to the pointer while an end is dragged (plan 9 §6). */
export function dropLabel(v: Verdict): string {
  switch (v) {
    case 'connect': return 'connect here';
    case 'join': return 'join here';
    case 'move': return 'move here';
    case 'wrongSide': return 'wrong side';
    case 'sameStep': return 'same step';
    case 'sameWire': return 'same wire';
    case 'short': return 'short circuit';
    case 'hubTail': return 'only a tail on the workflow';
    case 'needsStep': return 'needs a step first';
  }
}

/** Green when the drop connects or joins, grey when the end is or stays open, red when it snaps back. */
export const toneOf = (v: Verdict): 'ok' | 'move' | 'no' => (v === 'connect' || v === 'join' ? 'ok' : v === 'move' ? 'move' : 'no');

/**
 * What the pointer at `p` is over (decision 5): `over` is the block `blockAt` found (node id), `line` the wire `wireAt`
 * found when there is no block; a line whose wire is not in `circuit` counts as none, so a drop never makes a
 * junction on a missing host. A step's left half is its input side, its right half its output side, the height
 * along it clamped and snapped (`clampLanding`); the hub gives the angle round its ring (snapped to 15°); a junction's
 * distance along its host is snapped to 8 px; a cache or nothing leaves the end open there, snapped.
 */
export function targetOf(
  doc: StudioDocument,
  circuit: Readonly<Circuit>,
  p: Point,
  over: string | null,
  line: { id: string; at: number } | null,
): DropTarget {
  if (over === SPHERE_NODE_ID) {
    const { cx, cy } = doc.placement.sphere;
    return { on: 'hub', angle: snapAngle((Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI) };
  }
  const at = over !== null && !over.startsWith(CACHE_NODE_PREFIX) ? doc.placement.steps.get(over) : undefined;
  if (over !== null && at) return { on: 'step', step: over, side: p.x < at.x + STEP_W / 2 ? 'in' : 'out', y: clampLanding(p.y - at.y) };
  if (over === null && line && Object.hasOwn(circuit, line.id)) return { on: 'wire', host: line.id, at: snap(line.at) };
  return { on: 'open', x: snap(p.x), y: snap(p.y) };
}

/** Where a dragged end is drawn over its target: on the step's side, on the hub's ring, on the host's line, or where it is. */
export function pointOfTarget(doc: StudioDocument, t: DropTarget): Point {
  switch (t.on) {
    case 'step': {
      const at = doc.placement.steps.get(t.step);
      return at ? { x: t.side === 'in' ? at.x : at.x + STEP_W, y: at.y + t.y } : { x: 0, y: 0 };
    }
    case 'hub': {
      const r = (t.angle * Math.PI) / 180;
      const { cx, cy } = doc.placement.sphere;
      return { x: cx + SPHERE_R * Math.cos(r), y: cy + SPHERE_R * Math.sin(r) };
    }
    case 'wire': {
      const host = doc.wires.find((w) => w.id === t.host);
      if (!host) return { x: 0, y: 0 };
      const [x, y] = contactOn(host.points, t.at).p;
      return { x, y };
    }
    case 'open': return { x: t.x, y: t.y };
  }
}
