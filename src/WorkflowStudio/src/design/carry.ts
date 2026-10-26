import type { StudioDocument } from '../app/document';
import type { Circuit, CircuitWire, End, Side } from '../circuit/circuit';
import { contactDistance, routeCircuit } from '../layout/circuitRoute';
import { lengthOf, nearestOn, pointAt } from '../layout/junctions';
import type { Pt } from '../layout/router';
import { placementOf } from './apply';
import { circuitOf, withCircuit, type Draft } from './draft';

/** How many wires deep a junction on a junction is carried (a wire joined on a wire joined on a wire …). */
const DEPTH = 8;

/** The drawn length of each run of `pts`, first to last. */
const runs = (pts: readonly Pt[]): number[] => pts.slice(1).map((b, i) => Math.abs(b[0] - pts[i]![0]) + Math.abs(b[1] - pts[i]![1]));

/**
 * Where a junction `at` px along its host drawn as `was` lies on the host drawn as `now` (the user's rule 3, 2026-10-26):
 * on the same run of the host, as far along that run, so it moves with that run whatever moved it. A host whose runs
 * changed in number or way (a run added or gone) keeps it at the point of its new line nearest where it was.
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
  const startNow = b.slice(0, i).reduce((s, v) => s + v, 0);
  return Math.min(Math.max(startNow + Math.min(d - start, b[i]!), 0), lengthOf([now]));
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
