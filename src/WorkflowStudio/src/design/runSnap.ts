import type { StudioDocument } from '../app/document';
import { PMID, STEP_W } from '../layout/geometry';
import { blockBoxes } from '../layout/wires';
import { equalGapMarks, equalGapMoves, guideBoxes, type GapMark, type GuideBox } from './guides';

/**
 * An alignment guide a dragged run or end snapped to: the line at `v` across `axis` (x: a vertical line), drawn as a
 * block's is (the user's, 2026-10-23), from `from` to `to` along it: over the dragged run or wire and what it lines up with.
 */
export interface RunGuide { axis: 'x' | 'y'; v: number; from: number; to: number }

/**
 * The guide at `v` across `axis` for what is dragged (spanning `along` the other way): drawn to the nearest of the
 * things lying at `v`, a block's edge, centre or processor middle, or another wire's parallel run, as a block's guide
 * runs to the nearest block it matches.
 */
export function guideAt(v: number, axis: 'x' | 'y', shown: StudioDocument, own: string, along: readonly [number, number]): RunGuide {
  const lo = Math.min(...along), hi = Math.max(...along);
  const spans: [number, number][] = [];
  for (const b of blockBoxes(shown.placement)) {
    const [c, size, a0, alen] = axis === 'x' ? [b.x, b.w, b.y, b.h] : [b.y, b.h, b.x, b.w];
    if (c === v || c + size / 2 === v || c + size === v) spans.push([a0, a0 + alen]);
  }
  if (axis === 'y') for (const st of shown.placement.steps.values()) if (st.y + PMID === v) spans.push([st.x, st.x + STEP_W]);
  const i = axis === 'x' ? 0 : 1;
  for (const w of shown.wires) {
    if (w.id === own) continue;
    for (let j = 1; j < w.points.length; j++) {
      const a = w.points[j - 1]!, b = w.points[j]!;
      if (a[i] === v && b[i] === v && a[1 - i] !== b[1 - i]) spans.push([Math.min(a[1 - i]!, b[1 - i]!), Math.max(a[1 - i]!, b[1 - i]!)]);
    }
  }
  const apart = ([s0, s1]: [number, number]) => Math.max(0, s0 - hi, lo - s1);
  const near = spans.reduce<[number, number] | null>((best, x) => (best === null || apart(x) < apart(best) ? x : best), null);
  return { axis, v, from: near ? Math.min(lo, near[0]) : lo, to: near ? Math.max(hi, near[1]) : hi };
}

/**
 * Visio's alignment for a dragged run (plan 10 phase 2): `v` is the run's coordinate across its own axis (x for a
 * vertical run, y for a horizontal one). It snaps to the nearest within `reach` of: every block's edges and centre on
 * that axis, the `landings` the caller gives (a step side's landing heights, for the run that slides an end), and the
 * parallel runs of the other wires as `shown` draws them, any net's (the user's, 2026-10-23: the caller drops a snap that
 * would lie on a wire it may not share a line with). `at` is the matched coordinate, for the guide line, or null when
 * nothing is in reach; `all`, every one in reach, nearest first (the caller takes the first that holds).
 */
export function snapRun(
  v: number,
  axis: 'x' | 'y',
  shown: StudioDocument,
  own: string,
  reach: number,
  landings: readonly number[] = [],
): { v: number; at: number | null; all: number[] } {
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
  // every one in reach, nearest first (the one found first on a tie), each once
  const all = [...new Set(candidates.filter((c) => Math.abs(c - v) <= reach))].sort((a, b) => Math.abs(a - v) - Math.abs(b - v));
  const at = all[0] ?? null;
  return { v: at ?? v, at, all };
}

/** A run at `v` across `axis` (x: a vertical run), from `lo` to `hi` along it, as a box with no width. */
const runBox = (v: number, lo: number, hi: number, axis: 'x' | 'y'): GuideBox =>
  axis === 'x' ? { id: '', x: v, y: Math.min(lo, hi), w: 0, h: Math.abs(hi - lo) } : { id: '', x: Math.min(lo, hi), y: v, w: Math.abs(hi - lo), h: 0 };

/** What a run keeps equal gaps to (the user's, 2026-10-23): every block, and every run of the other wires parallel to it. */
function spacers(shown: StudioDocument, axis: 'x' | 'y', own: string): GuideBox[] {
  const out = guideBoxes(shown);
  const i = axis === 'x' ? 0 : 1;
  for (const w of shown.wires) {
    if (w.id === own) continue;
    for (let j = 1; j < w.points.length; j++) {
      const a = w.points[j - 1]!, b = w.points[j]!;
      if (a[i] === b[i] && a[1 - i] !== b[1 - i]) out.push(runBox(a[i]!, a[1 - i]!, b[1 - i]!, axis));
    }
  }
  return out;
}

/**
 * Visio's equal spacing for a dragged run (the user's, 2026-10-23, as blocks have it): `v`, the run's coordinate across
 * `axis`, from `lo` to `hi` along it. Every place within `reach`, nearest first, where its gap to the neighbouring block
 * or parallel run equals one between two neighbours in its row, and the middle between its two neighbours (equal gaps on
 * both sides).
 */
export function spaceRuns(v: number, lo: number, hi: number, axis: 'x' | 'y', shown: StudioDocument, own: string, reach: number): number[] {
  const m = runBox(v, lo, hi, axis);
  const all = spacers(shown, axis, own);
  const at = (b: GuideBox) => (axis === 'x' ? b.x : b.y), len = (b: GuideBox) => (axis === 'x' ? b.w : b.h);
  const span = (b: GuideBox) => (axis === 'x' ? [b.y, b.y + b.h] : [b.x, b.x + b.w]) as [number, number];
  // its neighbours: the nearest on each side among those alongside it
  const [m0, m1] = span(m);
  const row = all.filter((b) => { const [b0, b1] = span(b); return Math.min(b1, m1) - Math.max(b0, m0) > 0; });
  const before = Math.max(...row.map((b) => at(b) + len(b)).filter((e) => e <= v));
  const after = Math.min(...row.map(at).filter((s) => s >= v));
  const mid = Number.isFinite(before) && Number.isFinite(after) && after > before ? (before + after) / 2 : null;
  const cands = [...equalGapMoves(m, all, reach, axis).map((d) => v + d), ...(mid !== null && Math.abs(mid - v) <= reach ? [mid] : [])];
  return [...new Set(cands.map((c) => Math.round(c * 1e6) / 1e6))].sort((a, b) => Math.abs(a - v) - Math.abs(b - v));
}

/** The nearest equal-spacing place of `spaceRuns`; null when none is in reach. */
export const spaceRun = (v: number, lo: number, hi: number, axis: 'x' | 'y', shown: StudioDocument, own: string, reach: number): number | null =>
  spaceRuns(v, lo, hi, axis, shown, own, reach)[0] ?? null;

/** The equal-gap marks for a run at `v` (as `spaceRun`): every neighbouring pair in its row whose gap equals one of the run's own. */
export function runGapMarks(v: number, lo: number, hi: number, axis: 'x' | 'y', shown: StudioDocument, own: string): GapMark[] {
  return equalGapMarks(runBox(v, lo, hi, axis), spacers(shown, axis, own), axis);
}

/** A place a dragged run or end may snap to: an alignment, or an equal gap (`spaced`). */
export interface Candidate { at: number; spaced: boolean }

/** The alignments and equal gaps for a run at `v`, nearest first; an alignment before a gap as near, and each place once. */
export function ranked(v: number, aligned: readonly number[], spaced: readonly number[]): Candidate[] {
  const out: Candidate[] = [];
  for (const c of [...aligned.map((at) => ({ at, spaced: false })), ...spaced.map((at) => ({ at, spaced: true }))]) {
    if (!out.some((o) => o.at === c.at)) out.push(c);
  }
  // a stable sort: an alignment stays before a gap as near
  return out.sort((a, b) => Math.abs(a.at - v) - Math.abs(b.at - v));
}

/**
 * The snap a dragged run takes (the user's, 2026-10-23): the nearest candidate whose shape (`shapeOf`) still lies on its
 * line (`holds`: a run pushed off a block side it would lie along does not) and is no short circuit (`shorts`); the next
 * when it is not, so a tie with a line it may not take never hides one it may. But a candidate the pointer is on
 * (`on`, within half a grid step of it) that does not hold is where the run goes as dragged: it is not pulled off a line
 * it was put on (a short circuit shows as one). None holds: the drag as without a snap (`raw`), with no guide.
 */
export function pickSnap<T>(cands: readonly Candidate[], shapeOf: (at: number) => T, holds: (s: T, at: number) => boolean, shorts: (s: T) => boolean, raw: () => T, on: (at: number) => boolean = () => false): { shape: T; at: number | null; spaced: boolean } {
  for (const c of cands) {
    const s = shapeOf(c.at);
    if (holds(s, c.at) && !shorts(s)) return { shape: s, at: c.at, spaced: c.spaced };
    if (on(c.at)) break;
  }
  return { shape: raw(), at: null, spaced: false };
}
