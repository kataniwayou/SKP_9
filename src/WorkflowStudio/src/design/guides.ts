import type { StudioDocument } from '../app/document';
import { PMID } from '../layout/geometry';
import { cacheNodeId, SPHERE_NODE_ID } from '../layout/nodeIds';
import { nodeBox } from './hit';

/** A block for the guides, by React Flow node id; `mid` is a step's processor middle (absolute). */
export interface GuideBox { id: string; x: number; y: number; w: number; h: number; mid?: number }
export interface GuideLine { x1: number; y1: number; x2: number; y2: number }

export function guideBoxes(doc: StudioDocument): GuideBox[] {
  const ids = [SPHERE_NODE_ID, ...doc.placement.steps.keys(), ...[...doc.placement.caches.keys()].map(cacheNodeId)];
  const out: GuideBox[] = [];
  for (const id of ids) {
    const b = nodeBox(doc, id);
    if (b) out.push({ id, ...b, ...(doc.placement.steps.has(id) ? { mid: b.y + PMID } : {}) });
  }
  return out;
}

const xsOf = (b: GuideBox) => [b.x, b.x + b.w / 2, b.x + b.w];
const ysOf = (b: GuideBox) => [b.y, b.y + b.h / 2, b.y + b.h, ...(b.mid !== undefined ? [b.mid] : [])];

/**
 * An equal-gap mark (Visio's dimension arrow, plan 10): axis 'x' is a horizontal gap from x `from` to x `to`, drawn
 * below y `at` (the lower bottom edge of its pair); axis 'y' a vertical gap from y `from` to y `to`, drawn right of x
 * `at` (the farther right edge of its pair).
 */
export interface GapMark { axis: 'x' | 'y'; from: number; to: number; at: number }
/** What a drag shows: the alignment lines and the equal-gap marks. */
export interface Guides { lines: GuideLine[]; gaps: GapMark[] }
export const NO_GUIDES: Guides = { lines: [], gaps: [] };

/** How near (screen px, at any zoom) a block snaps to a guide: Visio snapped 3, 6 and 10 px off, not 16 (plan 10). */
export const SNAP_REACH_PX = 12;

/** The smallest offset within `reach` that lines one of `mine` up with one of `theirs`; null when none does. */
function best(mine: number[], theirs: number[], reach: number): number | null {
  let found: number | null = null;
  for (const m of mine) for (const t of theirs) {
    const d = t - m;
    if (Math.abs(d) <= reach && (found === null || Math.abs(d) < Math.abs(found))) found = d;
  }
  return found;
}

/** The distance between two spans [a0, a1] and [b0, b1] (0 when they overlap). */
const apart = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, b0 - a1, a0 - b1);

/**
 * Plan 10 (Visio's dynamic grid, the authority): the dragged block, at its unrounded position, snaps when an edge, its
 * centre or its processor middle is within `reach` (flow px) of another block's; `hit` says which axes a guide caught
 * (the caller rounds the others to the grid). Each matching coordinate draws one line, to the nearest block it matches
 * (Visio's). A guide on blocks that are on the 8 px grid keeps the block on it.
 */
export function snapToGuides(moving: GuideBox, others: readonly GuideBox[], reach: number): { dx: number; dy: number; hit: { x: boolean; y: boolean } } & Guides {
  const ax = best(xsOf(moving), others.flatMap(xsOf), reach);
  const ay = best(ysOf(moving), others.flatMap(ysOf), reach);
  const dx = ax ?? 0, dy = ay ?? 0;
  const m: GuideBox = { ...moving, x: moving.x + dx, y: moving.y + dy, ...(moving.mid !== undefined ? { mid: moving.mid + dy } : {}) };
  return { dx, dy, hit: { x: ax !== null, y: ay !== null }, lines: linesOf(m, others), gaps: [] };
}

/** One line per coordinate of `m` that some block matches exactly, spanning `m` and the nearest such block. */
function linesOf(m: GuideBox, others: readonly GuideBox[]): GuideLine[] {
  const lines: GuideLine[] = [];
  for (const x of new Set(xsOf(m))) {
    const near = nearest(others.filter((o) => xsOf(o).includes(x)), (o) => apart(m.y, m.y + m.h, o.y, o.y + o.h));
    if (near) lines.push({ x1: x, y1: Math.min(m.y, near.y), x2: x, y2: Math.max(m.y + m.h, near.y + near.h) });
  }
  for (const y of new Set(ysOf(m))) {
    const near = nearest(others.filter((o) => ysOf(o).includes(y)), (o) => apart(m.x, m.x + m.w, o.x, o.x + o.w));
    if (near) lines.push({ x1: Math.min(m.x, near.x), y1: y, x2: Math.max(m.x + m.w, near.x + near.w), y2: y });
  }
  return lines;
}

const nearest = <T>(xs: readonly T[], d: (x: T) => number): T | null =>
  xs.reduce<T | null>((b, x) => (b === null || d(x) < d(b) ? x : b), null);
