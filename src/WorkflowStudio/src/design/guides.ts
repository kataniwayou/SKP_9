import type { StudioDocument } from '../app/document';
import { GRID, PMID } from '../layout/geometry';
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

/** The smallest offset (at most one grid step) that lines one of `mine` up with one of `theirs`. */
function best(mine: number[], theirs: number[]): number {
  let found: number | null = null;
  for (const m of mine) for (const t of theirs) {
    const d = t - m;
    if (Math.abs(d) <= GRID && (found === null || Math.abs(d) < Math.abs(found))) found = d;
  }
  return found ?? 0;
}

/**
 * Spec §3.4 (Visio's dynamic grid): the dragged block snaps when an edge, its centre or its processor
 * middle is within one grid step of another block's, and a line is drawn for every exact match. Every
 * line is a multiple of 8 on blocks that are, so a guide never takes a block off the grid.
 */
export function snapToGuides(moving: GuideBox, others: readonly GuideBox[]): { dx: number; dy: number; lines: GuideLine[] } {
  const dx = best(xsOf(moving), others.flatMap(xsOf));
  const dy = best(ysOf(moving), others.flatMap(ysOf));
  const m: GuideBox = { ...moving, x: moving.x + dx, y: moving.y + dy, ...(moving.mid !== undefined ? { mid: moving.mid + dy } : {}) };
  const lines: GuideLine[] = [];
  const seen = new Set<string>();
  const add = (l: GuideLine) => { const k = `${l.x1},${l.y1},${l.x2},${l.y2}`; if (!seen.has(k)) { seen.add(k); lines.push(l); } };
  for (const o of others) {
    const top = Math.min(m.y, o.y), bottom = Math.max(m.y + m.h, o.y + o.h);
    const left = Math.min(m.x, o.x), right = Math.max(m.x + m.w, o.x + o.w);
    for (const x of xsOf(m)) if (xsOf(o).includes(x)) add({ x1: x, y1: top, x2: x, y2: bottom });
    for (const y of ysOf(m)) if (ysOf(o).includes(y)) add({ x1: left, y1: y, x2: right, y2: y });
  }
  return { dx, dy, lines };
}
