import type { StudioDocument } from '../app/document';
import { blockBoxes } from '../layout/wires';

/** An alignment guide a dragged run or end snapped to: the line at `v` across `axis` (x: a vertical line). */
export interface RunGuide { axis: 'x' | 'y'; v: number }

/**
 * Visio's alignment for a dragged run (plan 10 phase 2): `v` is the run's coordinate across its own axis (x for a
 * vertical run, y for a horizontal one). It snaps to the nearest within `reach` of: every block's edges and centre on
 * that axis, the `landings` the caller gives (a step side's landing heights, for the run that slides an end), and the
 * parallel runs of the other wires as `shown` draws them, any net's (the user's, 2026-10-23: the caller drops a snap that
 * would lie on a wire it may not share a line with). `at` is the matched coordinate, for the guide line, or null when
 * nothing is in reach.
 */
export function snapRun(
  v: number,
  axis: 'x' | 'y',
  shown: StudioDocument,
  own: string,
  reach: number,
  landings: readonly number[] = [],
): { v: number; at: number | null } {
  const candidates: number[] = [...landings];
  for (const b of blockBoxes(shown.placement)) {
    const [lo, size] = axis === 'x' ? [b.x, b.w] : [b.y, b.h];
    candidates.push(lo, lo + size / 2, lo + size);
  }
  const i = axis === 'x' ? 0 : 1;
  for (const w of shown.wires) {
    if (w.id === own) continue;
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

/**
 * Whether a dragged run keeps its snap to `at` (null: nothing snapped): it does when the shape snapped there still lies
 * on that line (`keeps`: a run pushed off a block side it would lie along does not) and is no short circuit the drag
 * without the snap would not be (a block line can lie on another net's wire). Otherwise the drag is as without the snap
 * (`raw`), with no guide.
 */
export function heldSnap<T>(at: number | null, snapped: T, raw: () => T, keeps: (s: T) => boolean, shorts: (s: T) => boolean): { shape: T; guide: number | null } {
  if (at === null) return { shape: snapped, guide: null };
  if (keeps(snapped) && !shorts(snapped)) return { shape: snapped, guide: at };
  const plain = raw();
  if (keeps(snapped) && shorts(plain)) return { shape: snapped, guide: at };
  return { shape: plain, guide: null };
}
