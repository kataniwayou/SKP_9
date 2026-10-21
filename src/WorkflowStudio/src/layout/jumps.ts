import { JUMP } from './geometry';
import type { Pt } from './router';

/**
 * Where each wire jumps another (plan 10 phase 3, spec §4.2: Visio's line jumps): on its level runs, at every point an
 * upright run of another wire crosses it, in order along the run. A crossing within half a jump of either run's end is
 * none (a junction, a bend or an end is there), nor is a wire crossing itself.
 */
export function jumpsOf(lines: readonly { id: string; points: readonly Pt[] }[]): Map<string, Pt[]> {
  const half = JUMP / 2;
  const uprights: { id: string; x: number; lo: number; hi: number }[] = [];
  for (const l of lines) {
    for (let i = 1; i < l.points.length; i++) {
      const a = l.points[i - 1]!, b = l.points[i]!;
      if (a[0] === b[0] && a[1] !== b[1]) uprights.push({ id: l.id, x: a[0], lo: Math.min(a[1], b[1]), hi: Math.max(a[1], b[1]) });
    }
  }
  const out = new Map<string, Pt[]>();
  for (const l of lines) {
    const found: Pt[] = [];
    for (let i = 1; i < l.points.length; i++) {
      const a = l.points[i - 1]!, b = l.points[i]!;
      if (a[1] !== b[1] || a[0] === b[0]) continue;
      const y = a[1], lo = Math.min(a[0], b[0]), hi = Math.max(a[0], b[0]);
      const xs = uprights
        .filter((u) => u.id !== l.id && u.x - lo >= half && hi - u.x >= half && y - u.lo >= half && u.hi - y >= half)
        .map((u) => u.x)
        .sort((p, q) => (b[0] > a[0] ? p - q : q - p));
      for (const x of xs) {
        const last = found[found.length - 1];
        // two uprights nearer than a jump share one arc
        if (!last || last[1] !== y || Math.abs(last[0] - x) >= JUMP) found.push([x, y]);
      }
    }
    if (found.length > 0) out.set(l.id, found);
  }
  return out;
}
