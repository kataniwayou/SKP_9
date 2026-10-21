import type { Id } from '../model/graph';
import { GRID, BAND_BOTTOM, BAND_TOP, CAP_H, PMID, STEP_H, STRAIGHT_MIN_GAP, TRACK } from './geometry';

/** How far apart the wires arriving on one step land: a track (plan 10 phase 3, spec §4.2). */
const SLOT = TRACK;
import type { Placement } from './placement';

/** The sphere as a wire source. */
export const WORKFLOW_SOURCE = 'wf';
export type SourceId = string;

/** One wire arriving on a step's input (plan 9): by its own key, from where it leaves (`y`, and `x`: Infinity when it cannot run straight). */
export interface Arrival {
  key: string;
  target: Id;
  y: number;
  x: number;
}

/**
 * The landing rule (spec §5.2). A wire keeps the height it left at when that height is inside the
 * target processor's band and the source sits at least 16 px to the left, so it runs straight. Any
 * other wire bends and lands near the processor middle, on the nearest free 8 px slot (the side it
 * comes from first), skipping slots outside the step's landing extent. If that walk cannot keep
 * every bent arrival in the extent, the bent arrivals are packed into the extent's free slots
 * instead (so any fan-in that can fit, fits). Arrivals into one step stay at least 32 apart (a track).
 *
 * Landing extent: step-local 40 (just below the title cap) to 160 inclusive; the bottom edge
 * (step-local 160, the bottom corner) counts as on the step. It holds 4 slots 32 apart; a larger
 * fan-in spills past the extent rather than break the spacing.
 *
 * Arrival by arrival (plan 9): two wires from one source into one step each land.
 */
export function landingsOf(arrivals: readonly Arrival[], placement: Placement): Map<string, number> {
  const byTarget = new Map<Id, Arrival[]>();
  for (const a of arrivals) byTarget.set(a.target, [...(byTarget.get(a.target) ?? []), a]);
  const result = new Map<string, number>();
  for (const [target, list] of byTarget) {
    const p = placement.steps.get(target)!;
    const top = p.y + BAND_TOP, bottom = p.y + BAND_BOTTOM, middle = p.y + PMID;
    const used: number[] = [];
    const free = (y: number) => !used.some((u) => Math.abs(u - y) < SLOT);
    const landed = new Map<string, number>();
    for (const a of list) {
      if (a.y < top || a.y > bottom || a.x > p.x - STRAIGHT_MIN_GAP) continue;
      const y = nearestFreeInBand(a.y, top, bottom, free);
      if (y === null) continue;
      used.push(y);
      landed.set(a.key, y);
    }
    const lo = p.y + CAP_H, hi = p.y + STEP_H;
    const bent = list.filter((a) => !landed.has(a.key)).sort((a, b) => a.y - b.y);
    if (bent.length > 0) {
      const walkUsed = [...used];
      const walkFree = (y: number) => !walkUsed.some((u) => Math.abs(u - y) < SLOT);
      const walked = new Map<string, number>();
      for (const a of bent) {
        const y = nearestFreeSlot(middle, a.y < middle ? -1 : 1, lo, hi, walkFree);
        walkUsed.push(y);
        walked.set(a.key, y);
      }
      let chosen = walked;
      if ([...walked.values()].some((y) => y < lo || y > hi)) {
        const packed = packSlots(lo, hi, used);
        if (packed.length >= bent.length) chosen = new Map(bent.map((a, i) => [a.key, packed[i]!]));
      }
      for (const [k, y] of chosen) { used.push(y); landed.set(k, y); }
    }
    for (const [k, y] of landed) result.set(k, y);
  }
  return result;
}

/** The free slot nearest `d` in steps of a slot inside the band, or null when the band is full. */
function nearestFreeInBand(d: number, top: number, bottom: number, free: (y: number) => boolean): number | null {
  for (let k = 0; ; k++) {
    const down = d + k * SLOT, up = d - k * SLOT;
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

/** Greedy leftmost packing of the 8 px slots in [lo, hi] that are a slot apart from `used` and from each other (maximal count). */
function packSlots(lo: number, hi: number, used: number[]): number[] {
  const slots: number[] = [];
  for (let y = lo; y <= hi; y += GRID) {
    if (used.some((u) => Math.abs(u - y) < SLOT)) continue;
    if (slots.length === 0 || y - slots[slots.length - 1]! >= SLOT) slots.push(y);
  }
  return slots;
}
