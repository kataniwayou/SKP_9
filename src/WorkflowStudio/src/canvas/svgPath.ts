import { JUMP } from '../layout/geometry';
import type { Pt } from '../layout/router';

export const pathOf = (points: Pt[]): string => points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x} ${y}`).join(' ');

/**
 * A wire's path with its line jumps (plan 10 phase 3): at each jump on a level run, an arc `JUMP` wide bulging up, the
 * way Visio draws a crossing. Jumps nearer than that share one arc, spanning them all and as high as one, so none
 * reads as a plain crossing (phase 3's deferred list).
 */
export function pathWithJumps(points: Pt[], jumps: readonly Pt[]): string {
  if (jumps.length === 0) return pathOf(points);
  const r = JUMP / 2;
  const parts = [`M${points[0]![0]} ${points[0]![1]}`];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    if (a[1] === b[1] && a[0] !== b[0]) {
      const dir = b[0] > a[0] ? 1 : -1;
      const on = jumps.filter((j) => j[1] === a[1] && (j[0] - a[0]) * dir > 0 && (b[0] - j[0]) * dir > 0)
        .sort((p, q) => (p[0] - q[0]) * dir);
      // left to right the arc turns clockwise to bulge up; right to left, anticlockwise
      for (let k = 0; k < on.length; ) {
        let m = k;
        while (m + 1 < on.length && Math.abs(on[m + 1]![0] - on[m]![0]) < JUMP) m++;
        const from = on[k]![0] - dir * r, to = on[m]![0] + dir * r;
        parts.push(`L${from} ${a[1]}`, `A${Math.abs(to - from) / 2} ${r} 0 0 ${dir > 0 ? 1 : 0} ${to} ${a[1]}`);
        k = m + 1;
      }
    }
    parts.push(`L${b[0]} ${b[1]}`);
  }
  return parts.join(' ');
}
