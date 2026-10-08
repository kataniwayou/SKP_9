import type { StudioDocument } from '../app/document';
import { setEnd, snapAngle, type Circuit, type End, type Side } from '../circuit/circuit';
import { netsOf } from '../circuit/families';
import { loopWires, trace } from '../circuit/trace';
import { contactOn } from '../layout/circuitRoute';
import { clampLanding, snap, SPHERE_R, STEP_W, type Point } from '../layout/geometry';
import { CACHE_NODE_PREFIX, SPHERE_NODE_ID } from '../layout/nodeIds';
import type { Id } from '../model/graph';

/** What a dragged end is over (plan 9 §6): a step's input or output side, the hub's ring, a wire's line, or nothing. */
export type DropTarget =
  | { on: 'step'; step: Id; side: 'in' | 'out'; y: number }
  | { on: 'hub'; angle: number }
  | { on: 'wire'; host: string; at: number }
  | { on: 'open'; x: number; y: number };

export type Refusal = 'wrongSide' | 'sameStep' | 'sameWire' | 'short' | 'hubTail';
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

/**
 * What dropping wire `id`'s `side` end on `t` does (plan 9 §3, §4, §6; decision 7). Open anywhere ('move'); a step
 * side or the hub ('connect'); a wire ('join'). Refused: a head on a step's output or a tail on its input
 * ('wrongSide'), a head on the hub ('hubTail'), both ends on one step ('sameStep'), an end on its own wire or both
 * ends on one wire ('sameWire'); then a wire brought onto a closed loop of wires ('short'; a loop already there
 * elsewhere does not hide a new one), a step fed its own input through junctions ('sameStep'), and a family
 * brought into a net that then holds two or more ('short'). A loop, a
 * self-feed or a short circuit already there before the drop does not refuse it: in a net already shorted (an
 * Inspector edit) an end may still slide along its side or its host, as long as no wire of the net gains a family.
 */
export function judgeDrop(shown: StudioDocument, circuit: Readonly<Circuit>, id: string, side: Side, t: DropTarget): Verdict {
  if (!Object.hasOwn(circuit, id) || t.on === 'open') return 'move';
  const w = circuit[id]!;
  const other = side === 'tail' ? w.head : w.tail;
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
  const looped = loopWires(circuit);
  for (const x of loopWires(after)) if (!looped.has(x)) return 'short';
  const before = trace(circuit).links;
  for (const [s, ts] of trace(after).links) if (ts.includes(s) && !before.get(s)?.includes(s)) return 'sameStep';
  const conditionOf = (s: Id) => shown.graph.steps.get(s)?.entryCondition;
  const net = netsOf(after, conditionOf).find((n) => n.wires.includes(id));
  if (net && net.families.length > 1) {
    const had = new Map<string, readonly number[]>();
    for (const n of netsOf(circuit, conditionOf)) for (const x of n.wires) had.set(x, n.families);
    if (net.wires.some((x) => net.families.some((f) => !(had.get(x) ?? []).includes(f)))) return 'short';
  }
  return t.on === 'wire' ? 'join' : 'connect';
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
