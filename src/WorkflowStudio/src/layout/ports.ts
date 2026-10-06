import type { Id } from '../model/graph';
import { GRID, BAND_BOTTOM, BAND_TOP, CAP_H, PMID, PORT_GAP, SPHERE_R, STEP_H, STEP_W, offset } from './geometry';
import type { Placement } from './placement';

/** The sphere as a wire source. */
export const WORKFLOW_SOURCE = 'wf';
export type SourceId = string;

export interface WireEnd {
  source: SourceId;
  target: Id;
}

export function departureX(source: SourceId, placement: Placement): number {
  return source === WORKFLOW_SOURCE ? placement.sphere.cx + SPHERE_R : placement.steps.get(source)!.x + STEP_W;
}

/**
 * Fan-out (spec §5.2): a source's wires leave as one group 16 apart, centred on its processor
 * middle (the sphere's centre for entry wires), ordered by where their targets sit so neighbouring
 * wires never cross on the way out.
 */
export function computeDepartures(wires: WireEnd[], placement: Placement): Map<SourceId, Map<Id, number>> {
  const bySource = new Map<SourceId, Id[]>();
  for (const w of wires) bySource.set(w.source, [...(bySource.get(w.source) ?? []), w.target]);

  const out = new Map<SourceId, Map<Id, number>>();
  for (const [source, targets] of bySource) {
    const at = (id: Id) => placement.steps.get(id)!;
    const ordered = [...targets].sort((a, b) => at(a).y - at(b).y || at(a).x - at(b).x);
    const base = source === WORKFLOW_SOURCE ? placement.sphere.cy : placement.steps.get(source)!.y + PMID;
    out.set(source, new Map(ordered.map((t, k) => [t, base + offset(k, ordered.length, PORT_GAP)])));
  }
  return out;
}

/**
 * The landing rule (spec §5.2). A wire keeps the height it left at when that height is inside the
 * target processor's band and the source sits at least 16 px to the left, so it runs straight. Any
 * other wire bends and lands near the processor middle, on the nearest free 8 px slot (the side it
 * comes from first), skipping slots outside the step's landing extent. If that walk cannot keep
 * every bent arrival in the extent, the bent arrivals are packed into the extent's free slots
 * instead (so any fan-in that can fit, fits). Arrivals into one step stay at least 16 apart.
 *
 * Landing extent: step-local 40 (just below the title cap) to 160 inclusive; the bottom edge
 * (step-local 160, the bottom corner) counts as on the step. It holds 8 slots 16 apart; a larger
 * fan-in spills past the extent rather than break the spacing.
 */
export function computeLandings(
  wires: WireEnd[],
  placement: Placement,
  departures: Map<SourceId, Map<Id, number>>,
): Map<Id, Map<SourceId, number>> {
  const byTarget = new Map<Id, SourceId[]>();
  for (const w of wires) byTarget.set(w.target, [...(byTarget.get(w.target) ?? []), w.source]);

  const result = new Map<Id, Map<SourceId, number>>();
  for (const [target, sources] of byTarget) {
    const p = placement.steps.get(target)!;
    const top = p.y + BAND_TOP, bottom = p.y + BAND_BOTTOM, middle = p.y + PMID;
    const used: number[] = [];
    const free = (y: number) => !used.some((u) => Math.abs(u - y) < PORT_GAP);
    const landed = new Map<SourceId, number>();
    const departure = (s: SourceId) => departures.get(s)!.get(target)!;

    for (const s of sources) {
      const d = departure(s);
      if (d < top || d > bottom || departureX(s, placement) > p.x - 16) continue;
      const y = nearestFreeInBand(d, top, bottom, free);
      if (y === null) continue;
      used.push(y);
      landed.set(s, y);
    }

    const lo = p.y + CAP_H, hi = p.y + STEP_H;
    const bent = sources.filter((s) => !landed.has(s)).sort((x, y) => departure(x) - departure(y));
    if (bent.length > 0) {
      const walkUsed = [...used];
      const walkFree = (y: number) => !walkUsed.some((u) => Math.abs(u - y) < PORT_GAP);
      const walked = new Map<SourceId, number>();
      for (const s of bent) {
        const y = nearestFreeSlot(middle, departure(s) < middle ? -1 : 1, lo, hi, walkFree);
        walkUsed.push(y);
        walked.set(s, y);
      }
      let chosen = walked;
      if ([...walked.values()].some((y) => y < lo || y > hi)) {
        const packed = packSlots(lo, hi, used);
        if (packed.length >= bent.length) chosen = new Map(bent.map((s, i) => [s, packed[i]!]));
      }
      for (const [s, y] of chosen) { used.push(y); landed.set(s, y); }
    }

    result.set(target, landed);
  }
  return result;
}

/** The free slot nearest `d` in steps of 16 inside the band, or null when the band is full. */
function nearestFreeInBand(d: number, top: number, bottom: number, free: (y: number) => boolean): number | null {
  for (let k = 0; ; k++) {
    const down = d + k * PORT_GAP, up = d - k * PORT_GAP;
    const downIn = down <= bottom, upIn = up >= top;
    if (!downIn && !upIn) return null;
    if (downIn && free(down)) return down;
    if (upIn && free(up)) return up;
  }
}

/** The free slot nearest `middle` (preferring `direction` on ties) inside [lo, hi]; if the extent is full, the nearest free slot anywhere. */
function nearestFreeSlot(middle: number, direction: 1 | -1, lo: number, hi: number, free: (y: number) => boolean): number {
  for (const bounded of [true, false]) {
    for (let k = 0; k < 8192; k++) {
      for (const y of [middle + direction * k * GRID, middle - direction * k * GRID]) {
        if (bounded && (y < lo || y > hi)) continue;
        if (free(y)) return y;
      }
    }
  }
  throw new Error('no free landing slot');
}

/** Greedy leftmost packing of the 8 px slots in [lo, hi] that are 16 apart from `used` and from each other (maximal count). */
function packSlots(lo: number, hi: number, used: number[]): number[] {
  const slots: number[] = [];
  for (let y = lo; y <= hi; y += GRID) {
    if (used.some((u) => Math.abs(u - y) < PORT_GAP)) continue;
    if (slots.length === 0 || y - slots[slots.length - 1]! >= PORT_GAP) slots.push(y);
  }
  return slots;
}
