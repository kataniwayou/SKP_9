import type { Pt } from '../layout/router';

export const pathOf = (points: Pt[]): string => points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x} ${y}`).join(' ');

/** The middle of the longest segment: where a broken wire's "!" sits. */
export function longestSegmentMiddle(points: Pt[]): Pt {
  let best = 0, index = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0] = points[i]!, [x1, y1] = points[i + 1]!;
    const length = Math.abs(x0 - x1) + Math.abs(y0 - y1);
    if (length > best) { best = length; index = i; }
  }
  const [x0, y0] = points[index]!, [x1, y1] = points[index + 1] ?? points[index]!;
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}
