import { JUMP } from '../layout/geometry';
import type { Pt } from '../layout/router';

export const pathOf = (points: Pt[]): string => points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x} ${y}`).join(' ');

/**
 * A wire's path with its line jumps (plan 10 phase 3): at each jump on a level run, an arc `JUMP` wide bulging up, the
 * way Visio draws a crossing.
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
      for (const j of on) parts.push(`L${j[0] - dir * r} ${a[1]}`, `A${r} ${r} 0 0 ${dir > 0 ? 1 : 0} ${j[0] + dir * r} ${a[1]}`);
    }
    parts.push(`L${b[0]} ${b[1]}`);
  }
  return parts.join(' ');
}
