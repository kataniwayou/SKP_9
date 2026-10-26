import type { StudioDocument } from '../app/document';
import type { Circuit, CircuitWire, End, Side } from '../circuit/circuit';
import { contactDistance, routeCircuit } from '../layout/circuitRoute';
import { lengthOf, nearestOn, pointAt } from '../layout/junctions';
import type { Pt } from '../layout/router';
import { applyDraft, placementOf } from './apply';
import { circuitOf, withCircuit, type Draft } from './draft';

/** How many wires deep a junction on a junction is carried (a wire joined on a wire joined on a wire …). */
const DEPTH = 8;

/** The drawn length of each run of `pts`, first to last. */
const runs = (pts: readonly Pt[]): number[] => pts.slice(1).map((b, i) => Math.abs(b[0] - pts[i]![0]) + Math.abs(b[1] - pts[i]![1]));

/**
 * Where a junction `at` px along its host drawn as `was` lies on the host drawn as `now` (the user's rule 3, 2026-10-26):
 * on the same run of the host. A run moved across takes it with it; a run stretched or shortened at an end (its run
 * beside it moved) leaves it where it is, along the run, kept on the run; a run moved along itself whole (the host
 * moved whole) takes it as far. A host whose runs changed in number or way (a run added or gone) keeps it at the point
 * of its new line nearest where it was.
 */
export function carriedAt(was: readonly Pt[], now: readonly Pt[], at: number): number {
  const d = contactDistance(was, at);
  const a = runs(was), b = runs(now);
  const upright = (pts: readonly Pt[], i: number) => pts[i]![0] === pts[i + 1]![0];
  if (a.length !== b.length || a.some((_, i) => upright(was, i) !== upright(now, i))) return nearestOn([now], pointAt([was], d).p).at;
  // the run it lies on: the first that reaches it (a run of no length never holds it)
  let start = 0, i = a.findIndex((v) => v > 0);
  for (let j = 0, from = 0; j < a.length; from += a[j]!, j++) {
    if (a[j]! > 0 && d <= from + a[j]!) { i = j; start = from; break; }
  }
  // along the run's own axis (x on a level run, y on an upright one): where it was, or moved as far as both its ends
  const k = upright(was, i) ? 1 : 0;
  const p0 = was[i]![k]!, p1 = was[i + 1]![k]!, q0 = now[i]![k]!, q1 = now[i + 1]![k]!;
  const dir = Math.sign(p1 - p0) || 1;
  const was0 = p0 + dir * (d - start);
  const along = q0 - p0 === q1 - p1 ? was0 + (q0 - p0) : Math.min(Math.max(was0, Math.min(q0, q1)), Math.max(q0, q1));
  const startNow = b.slice(0, i).reduce((s, v) => s + v, 0);
  return Math.min(Math.max(startNow + Math.abs(along - q0), 0), lengthOf([now]));
}

/**
 * Rule 3 (the user's, 2026-10-26): an end follows whatever it sits on. After a change (`before` to `after`), every end
 * joined on a wire whose drawn line moved is carried with it (`carriedAt`): the junction stays on its run, the joined
 * wire's run that reaches it stretching, its other runs kept. An end the change placed, moved or opened itself is left
 * as the change put it; a junction on a junction is carried in turn. `after` itself when nothing joined moved.
 */
export function carryJoined(saved: StudioDocument, before: Draft, after: Draft): Draft {
  const c0 = circuitOf(saved, before), c1 = circuitOf(saved, after);
  if (!Object.values(c1).some((w) => w.tail.on === 'wire' || w.head.on === 'wire')) return after;
  const lines = (c: Circuit, d: Draft) => new Map(routeCircuit(c, { placement: placementOf(saved, d), steps: saved.graph.steps }).map((w) => [w.id, w.points]));
  // the ends to carry: on the same host before and after, at the same place (so the change did not put them there)
  const carried = (id: string, side: Side): (End & { on: 'wire' }) | null => {
    const e0 = c0[id]?.[side], e1 = c1[id]?.[side];
    return e0?.on === 'wire' && e1?.on === 'wire' && e0.host === e1.host && e0.at === e1.at ? e0 : null;
  };
  const was = lines(c0, before);
  let c = c1;
  for (let pass = 0; pass < DEPTH; pass++) {
    const now = lines(c, after);
    const out: Circuit = Object.assign(Object.create(null) as Circuit, c);
    let changed = false;
    for (const [id, w] of Object.entries(c)) {
      const moved = (side: Side): End => {
        const e0 = carried(id, side), p0 = e0 && was.get(e0.host), p1 = e0 && now.get(e0.host);
        if (!e0 || !p0 || !p1) return w[side];
        const at = carriedAt(p0, p1, e0.at);
        const e = w[side];
        return e.on === 'wire' && e.at === at ? e : { on: 'wire', host: e0.host, at };
      };
      const tail = moved('tail'), head = moved('head');
      if (tail !== w.tail || head !== w.head) { out[id] = { ...w, tail, head } as CircuitWire; changed = true; }
    }
    if (!changed) break;
    c = out;
  }
  return c === c1 ? after : withCircuit(after, saved, c);
}

/**
 * Whether carrying shorted a wire (the user's, 2026-10-26: a change is judged whole, what rule 3 carried with it too): a
 * wire the carry moved (`plain`: the change as made, `carried`: with its joined ends carried) that lies on a wire of
 * another net after the change and did not `before` it.
 */
export function carriedShort(saved: StudioDocument, before: Draft, plain: Draft, carried: Draft): boolean {
  if (carried === plain) return false;
  const p = circuitOf(saved, plain), c = circuitOf(saved, carried);
  const moved = new Set(Object.keys(c).filter((id) => JSON.stringify(c[id]) !== JSON.stringify(p[id])));
  if (moved.size === 0) return false;
  const was = new Set(applyDraft(saved, before).wires.filter((w) => w.short).map((w) => w.id));
  return applyDraft(saved, carried).wires.some((w) => moved.has(w.id) && w.short && !was.has(w.id));
}

/** Whether any wire is joined on wire `id` (what a change to it may carry). */
export const hostsJoined = (c: Readonly<Circuit>, id: string): boolean =>
  Object.values(c).some((w) => (w.tail.on === 'wire' && w.tail.host === id) || (w.head.on === 'wire' && w.head.host === id));
