import type { StudioDocument } from '../app/document';
import { isFree, setEnd, splitWire, type Circuit, type End } from '../circuit/circuit';
import { netsOf } from '../circuit/families';
import { loopWires } from '../circuit/trace';
import { contactOn, routeCircuit } from '../layout/circuitRoute';
import { snap } from '../layout/geometry';
import { nearestOn } from '../layout/junctions';
import type { Pt } from '../layout/router';
import type { Id, Step } from '../model/graph';
import { applyDraft } from './apply';
import { circuitOf, withCircuit, type Draft } from './draft';
import { beforeDrop } from './drop';

/**
 * What dropping an empty step on a wire does (Visio, plan 10 §4.6): `insert` splits it through the step; refused on a
 * direction-less wire (`noDirection`), and where a short circuit would follow (`short`): the new step brings a second
 * family into a net (a junction joins wires of one family only: the user's ruling, 2026-10-22), closes a loop of wires,
 * or a half is drawn on a wire of another net (rule 2).
 */
export type SplitWhy = 'insert' | 'noDirection' | 'short';

/** A held step over a wire: the wire it covers, what the drop does, and how far along the wire (drawn) it goes in. */
export interface Split {
  wire: string;
  why: SplitWhy;
  at: number;
}

export function splitLabel(why: SplitWhy): string {
  switch (why) {
    case 'insert': return 'insert here';

    case 'noDirection': return 'wire has no direction';
    case 'short': return 'short circuit';
  }
}

export const splitTone = (why: SplitWhy): 'ok' | 'no' => (why === 'insert' ? 'ok' : 'no');

/** The run from `a` to `b` passes through the box (Liang–Barsky clipping). */
function crosses(a: Pt, b: Pt, r: Box): boolean {
  const [x0, y0] = a, dx = b[0] - x0, dy = b[1] - y0;
  let t0 = 0, t1 = 1;
  for (const [p, q] of [[-dx, x0 - r.x], [dx, r.x + r.w - x0], [-dy, y0 - r.y], [dy, r.y + r.h - y0]] as const) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return true;
}

/**
 * The wire whose drawn run a step's box covers (plan 10 §4.6), the one passing nearest the box's centre when several do;
 * null when none does. A wire with an end on step `skip` (the step held itself) never counts.
 */
export function wireUnder(shown: StudioDocument, circuit: Readonly<Circuit>, box: Box, skip: Id | null = null): string | null {
  const centre: Pt = [box.x + box.w / 2, box.y + box.h / 2];
  let best: { id: string; gap: number } | null = null;
  for (const r of shown.wires) {
    if (!Object.hasOwn(circuit, r.id)) continue;
    const w = circuit[r.id]!;
    if (skip !== null && [w.tail, w.head].some((e) => e.on === 'step' && e.step === skip)) continue;
    if (!r.points.some((p, i) => i > 0 && crosses(r.points[i - 1]!, p, box))) continue;
    const gap = nearestOn([r.points], centre).gap;
    if (best === null || gap < best.gap) best = { id: r.id, gap };
  }
  return best?.id ?? null;
}

/**
 * Wire `id` split through step `step` `at` along its drawn line (`splitWire`): the ends joined on it before that point
 * stay on it (the half into the step), those past it go to `newId` (the half out of the step), as far past the point
 * as they were. `pinSplit` puts them back on the halves as drawn.
 */
export function splitCircuit(c: Readonly<Circuit>, id: string, step: Id, newId: string, at: number): Circuit {
  const out = splitWire(c, id, step, newId);
  if (out === c) return out;
  const moved = (e: End): End => (e.on === 'wire' && e.host === id && e.at > at ? { on: 'wire', host: newId, at: e.at - at } : e);
  for (const [k, x] of Object.entries(out)) {
    if (k === id || k === newId) continue;
    const tail = moved(x.tail), head = moved(x.head);
    if (tail !== x.tail || head !== x.head) out[k] = { ...x, tail, head };
  }
  return out;
}

/** The id the split's new wire is judged under (it gets its own when dropped). */
const PROBE = 'w:split';

type Box = { x: number; y: number; w: number; h: number };

/**
 * The routing context with `step` (family `condition`) at `box`, for a step the drawing may not have yet (a Toolbox
 * drop) or has elsewhere (one dragged).
 */
function contextWith(shown: StudioDocument, step: Id, condition: number, box: Box) {
  const steps = new Map(shown.graph.steps);
  const own = shown.graph.steps.get(step);
  steps.set(step, { ...(own ?? { id: step, name: '', version: '', description: null, processorId: null, nextStepIds: [] }), entryCondition: condition } as Step);
  const placed = new Map(shown.placement.steps);
  placed.set(step, { x: box.x, y: box.y });
  return { placement: { ...shown.placement, steps: placed }, steps };
}

/**
 * Wire `id` split through step `step`, whose family (entry condition) is `condition`, `where.at` along its drawn line
 * (which half each junction on it goes with): judged as any connection is (`judgeDrop`'s rules): a loop of wires, or a
 * net gaining a family it did not have, refuses it. With `where.box` (where the step lands), the halves are drawn there
 * too: one that lies on a wire of another net it did not lie on before is a short circuit (rule 2).
 */
export function judgeSplit(
  shown: StudioDocument, circuit: Readonly<Circuit>, id: string, step: Id, condition: number, where: { at: number; box?: Box } = { at: Infinity },
): SplitWhy {
  const w = circuit[id];
  if (w === undefined || isFree(w)) return 'noDirection';
  const after = splitCircuit(circuit, id, step, PROBE, where.at);
  const before = beforeDrop(shown, circuit);
  for (const x of loopWires(after)) if (!before.looped.has(x)) return 'short';
  const conditionOf = (s: Id) => (s === step ? condition : shown.graph.steps.get(s)?.entryCondition);
  const families = before.families();
  // the new wire is the old wire's head half: it had what the old wire had (a net shorted already stays judged as judgeDrop does)
  const had = (x: string) => families.get(x === PROBE ? id : x) ?? [];
  for (const net of netsOf(after, conditionOf)) {
    if (net.families.length < 2 || !(net.wires.includes(id) || net.wires.includes(PROBE))) continue;
    if (net.wires.some((x) => net.families.some((f) => !had(x).includes(f)))) return 'short';
  }
  if (where.box) {
    // the halves as the router draws them with the step in place; a short circuit the old wire was in already is no new one
    const was = new Set(shown.wires.find((r) => r.id === id)?.shortWith ?? []);
    for (const r of routeCircuit(after, contextWith(shown, step, condition, where.box))) {
      if (r.id !== id && r.id !== PROBE) continue;
      if ((r.shortWith ?? []).some((x) => x !== id && x !== PROBE && !was.has(x))) return 'short';
    }
  }
  return 'insert';
}

/**
 * A step's box held at `box`: the wire it covers, the verdict there (its halves drawn with the step at `box`), and how far
 * along the wire the box's centre is; null over no wire. The last answer is kept: a drag asks again for every pointer
 * move, mostly with the step still on the same grid point.
 */
let last: { key: unknown[]; split: Split | null } | null = null;
export function splitAt(shown: StudioDocument, circuit: Readonly<Circuit>, box: Box, step: Id, condition: number, skip: Id | null = null): Split | null {
  const key = [shown, circuit, box.x, box.y, box.w, box.h, step, condition, skip];
  if (last && last.key.length === key.length && last.key.every((k, i) => k === key[i])) return last.split;
  const wire = wireUnder(shown, circuit, box, skip);
  const route = wire === null ? undefined : shown.wires.find((r) => r.id === wire);
  const at = route ? nearestOn([route.points], [box.x + box.w / 2, box.y + box.h / 2]).at : 0;
  const split = wire === null ? null : { wire, why: judgeSplit(shown, circuit, wire, step, condition, { at, box }), at };
  last = { key, split };
  return split;
}

/**
 * The release of a split (plan 10 §4.6): `draft` (the step already where it lands, over `saved`) with wire `split.wire`
 * split through `step`, the new half `newId`. Every end that was joined on the wire stays with its half and is put at
 * the point of that half, as now drawn, nearest where it was drawn in `shown` (junctions keep their place, the user's
 * ruling 2026-10-20).
 */
export function commitSplit(saved: StudioDocument, shown: StudioDocument, draft: Draft, split: Split, step: Id, newId: string): Draft {
  const was = circuitOf(saved, draft);
  const next = withCircuit(draft, saved, splitCircuit(was, split.wire, step, newId, split.at));
  const line = shown.wires.find((r) => r.id === split.wire)?.points;
  const joined = Object.entries(was).flatMap(([k, x]) => (['tail', 'head'] as const)
    .flatMap((side) => (x[side].on === 'wire' && x[side].host === split.wire ? [{ k, side, at: x[side].at }] : [])));
  if (!line || joined.length === 0) return next;
  const drawn = new Map(applyDraft(saved, next).wires.map((r) => [r.id, r.points]));
  let c = circuitOf(saved, next);
  for (const j of joined) {
    const host = (c[j.k]![j.side] as Extract<End, { on: 'wire' }>).host;
    const half = drawn.get(host);
    if (half) c = setEnd(c, j.k, j.side, { on: 'wire', host, at: snap(nearestOn([half], contactOn(line, j.at).p).at) });
  }
  return withCircuit(next, saved, c);
}