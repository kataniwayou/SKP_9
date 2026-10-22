import type { StudioDocument } from '../app/document';
import { isFree, splitWire, type Circuit } from '../circuit/circuit';
import { netsOf } from '../circuit/families';
import { loopWires } from '../circuit/trace';
import { nearestOn } from '../layout/junctions';
import type { Pt } from '../layout/router';
import type { Id } from '../model/graph';
import { beforeDrop } from './drop';

/**
 * What dropping an empty step on a wire does (Visio, plan 10 §4.6): `insert` splits it through the step; refused on a
 * wire with junctions on it (`junctionWire`: the step would sit among them), on a direction-less wire (`noDirection`),
 * and where the new step brings a second family into a net or closes a loop of wires (`short`).
 */
export type SplitWhy = 'insert' | 'junctionWire' | 'noDirection' | 'short';

/** A held step over a wire: the wire it covers and what the drop does. */
export interface Split {
  wire: string;
  why: SplitWhy;
}

export function splitLabel(why: SplitWhy): string {
  switch (why) {
    case 'insert': return 'insert here';
    case 'junctionWire': return 'wires join this wire';
    case 'noDirection': return 'wire has no direction';
    case 'short': return 'short circuit';
  }
}

export const splitTone = (why: SplitWhy): 'ok' | 'no' => (why === 'insert' ? 'ok' : 'no');

type Box = { x: number; y: number; w: number; h: number };

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

/** The id the split's new wire is judged under (it gets its own when dropped). */
const PROBE = 'w:split';

/**
 * Wire `id` split through step `step`, whose family (entry condition) is `condition`: judged as any connection is
 * (`judgeDrop`'s rules): a loop of wires or a net gaining a second family that was not there before refuses it.
 */
export function judgeSplit(shown: StudioDocument, circuit: Readonly<Circuit>, id: string, step: Id, condition: number): SplitWhy {
  const w = circuit[id];
  if (w === undefined || isFree(w)) return 'noDirection';
  const joined = Object.values(circuit).some((x) => (x.tail.on === 'wire' && x.tail.host === id) || (x.head.on === 'wire' && x.head.host === id));
  if (joined) return 'junctionWire';
  const after = splitWire(circuit, id, step, PROBE);
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
  return 'insert';
}

/** A step's box held at `box`: the wire it covers and the verdict there, or null over no wire. */
export function splitAt(shown: StudioDocument, circuit: Readonly<Circuit>, box: Box, step: Id, condition: number, skip: Id | null = null): Split | null {
  const wire = wireUnder(shown, circuit, box, skip);
  return wire === null ? null : { wire, why: judgeSplit(shown, circuit, wire, step, condition) };
}
