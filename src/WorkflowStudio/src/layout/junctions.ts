import { GRID, snap } from './geometry';
import type { Pt } from './router';
import { JOG, type Ends } from './shape';

/** A contact and a split stay this far from a line's start and arrow tip (spec §5.3). */
export const CONTACT_MARGIN = 16;

type Pieces = readonly (readonly Pt[])[];

const runLength = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);

/** The summed length of every run; nothing is counted between two pieces. */
export function lengthOf(pieces: Pieces): number {
  let n = 0;
  for (const line of pieces) for (let i = 0; i < line.length - 1; i++) n += runLength(line[i]!, line[i + 1]!);
  return n;
}

/** The point `d` along the pieces (clamped), and whether the run it lies on is vertical. */
export function pointAt(pieces: Pieces, d: number): { p: Pt; vertical: boolean } {
  let left = Math.max(0, d);
  let last: { p: Pt; vertical: boolean } | null = null;
  for (const line of pieces) {
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i]!, b = line[i + 1]!, len = runLength(a, b);
      if (len === 0) continue;
      const vertical = a[0] === b[0];
      if (left <= len) {
        const t = left / len;
        return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], vertical };
      }
      left -= len;
      last = { p: b, vertical };
    }
  }
  return last ?? { p: pieces[0]?.[0] ?? [0, 0], vertical: false };
}

/** The point of the pieces nearest `q`, searched between `from` and `to` along them: where, how far along, how far off. */
export function nearestOn(pieces: Pieces, q: Pt, from = 0, to = Infinity): { p: Pt; at: number; gap: number } {
  let best = { p: pieces[0]?.[0] ?? q, at: 0, gap: Infinity };
  let run = 0;
  for (const line of pieces) {
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i]!, b = line[i + 1]!, len = runLength(a, b);
      if (len === 0) continue;
      const lo = Math.max(0, (from - run) / len), hi = Math.min(1, (to - run) / len);
      if (lo <= hi) {
        const raw = ((q[0] - a[0]) * (b[0] - a[0]) + (q[1] - a[1]) * (b[1] - a[1])) / (len * len);
        const t = Math.min(Math.max(raw, lo), hi);
        const p: Pt = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        const gap = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (gap < best.gap) best = { p, at: run + t * len, gap };
      }
      run += len;
    }
  }
  return best;
}

/** The part of a line between distances d0 and d1 along it. */
export function slice(line: readonly Pt[], d0: number, d1: number): Pt[] {
  const total = lengthOf([line]);
  const a = Math.max(0, Math.min(d0, total)), b = Math.max(a, Math.min(d1, total));
  const out: Pt[] = [pointAt([line], a).p];
  let run = 0;
  for (let i = 0; i < line.length - 1; i++) {
    run += runLength(line[i]!, line[i + 1]!);
    if (run > a && run < b) out.push(line[i + 1]!);
  }
  out.push(pointAt([line], b).p);
  return out.filter((p, i) => i === 0 || p[0] !== out[i - 1]![0] || p[1] !== out[i - 1]![1]);
}

/**
 * Where a joined wire's own line ends so it meets its host square-on (spec §5.3): onto a vertical run it
 * arrives heading right at the contact; onto a horizontal run it arrives heading right one jog off the
 * line, on its source's side, and a vertical `tail` takes it onto the contact.
 */
export function ownEnds(sx: number, sy: number, contact: Pt, hostVertical: boolean): { ends: Ends; tail: Pt[] } {
  const [cx, cy] = contact;
  if (hostVertical) return { ends: { sx, sy, tx: cx, ty: cy }, tail: [] };
  const ty = snap(sy <= cy ? cy - JOG : cy + JOG, GRID);
  return { ends: { sx, sy, tx: cx, ty }, tail: [contact] };
}

/** Following hosts from `id` comes back to `id`. */
export function inLoop(id: string, hostOf: (id: string) => string | undefined): boolean {
  const seen = new Set<string>();
  for (let h = hostOf(id); h !== undefined; h = hostOf(h)) {
    if (h === id) return true;
    if (seen.has(h)) return false;
    seen.add(h);
  }
  return false;
}
