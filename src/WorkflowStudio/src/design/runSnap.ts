import type { StudioDocument } from '../app/document';
import { blockBoxes } from '../layout/wires';

/**
 * Visio's alignment for a dragged run (plan 10 phase 2): `v` is the run's coordinate across its own axis (x for a
 * vertical run, y for a horizontal one). It snaps to the nearest within `reach` of: every block's edges and centre on
 * that axis, the `landings` the caller gives (a step side's landing heights, for the run that slides an end), and the
 * parallel runs of the other wires as `shown` draws them that `allowed` says it may share a line with (another net's is a
 * short circuit, never a target). `at` is the matched coordinate, for the guide line, or null when nothing is in reach.
 */
export function snapRun(
  v: number,
  axis: 'x' | 'y',
  shown: StudioDocument,
  own: string,
  reach: number,
  allowed: (wireId: string) => boolean,
  landings: readonly number[] = [],
): { v: number; at: number | null } {
  const candidates: number[] = [...landings];
  for (const b of blockBoxes(shown.placement)) {
    const [lo, size] = axis === 'x' ? [b.x, b.w] : [b.y, b.h];
    candidates.push(lo, lo + size / 2, lo + size);
  }
  const i = axis === 'x' ? 0 : 1;
  for (const w of shown.wires) {
    if (w.id === own || !allowed(w.id)) continue;
    for (let j = 1; j < w.points.length; j++) {
      const a = w.points[j - 1]!, b = w.points[j]!;
      // a run parallel to the dragged one lies at one coordinate on this axis
      if (a[i] === b[i] && a[1 - i] !== b[1 - i]) candidates.push(a[i]!);
    }
  }
  let at: number | null = null;
  for (const c of candidates) if (Math.abs(c - v) <= reach && (at === null || Math.abs(c - v) < Math.abs(at - v))) at = c;
  return { v: at ?? v, at };
}
