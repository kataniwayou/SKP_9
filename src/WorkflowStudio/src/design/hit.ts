import type { StudioDocument } from '../app/document';
import { CACHE_H, CACHE_W, SPHERE_R, STEP_H, STEP_W, type Point } from '../layout/geometry';
import { CACHE_NODE_PREFIX, cacheNodeId, SPHERE_NODE_ID } from '../layout/nodeIds';
import { lengthOf, nearestOn } from '../layout/junctions';
import type { Side } from '../circuit/circuit';
import type { Pick } from '../store/picks';

/** A rectangle in flow coordinates, x0 ≤ x1 and y0 ≤ y1. */
export interface FlowRect { x0: number; y0: number; x1: number; y1: number }

export const rectOf = (a: Point, b: Point): FlowRect => ({ x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) });

/** A block's box by React Flow node id, or null when the document has no such block. */
export function nodeBox(doc: StudioDocument, id: string): { x: number; y: number; w: number; h: number } | null {
  if (id === SPHERE_NODE_ID) {
    const { cx, cy } = doc.placement.sphere;
    return { x: cx - SPHERE_R, y: cy - SPHERE_R, w: 2 * SPHERE_R, h: 2 * SPHERE_R };
  }
  if (id.startsWith(CACHE_NODE_PREFIX)) {
    const p = doc.placement.caches.get(id.slice(CACHE_NODE_PREFIX.length));
    return p ? { x: p.x, y: p.y, w: CACHE_W, h: CACHE_H } : null;
  }
  const p = doc.placement.steps.get(id);
  return p ? { x: p.x, y: p.y, w: STEP_W, h: STEP_H } : null;
}

/** A block's top-left corner by node id; the origin when the document has no such block. */
export function topLeftOf(doc: StudioDocument, id: string): Point {
  const b = nodeBox(doc, id);
  return b ? { x: b.x, y: b.y } : { x: 0, y: 0 };
}

const inside = (r: FlowRect, x: number, y: number) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;

/** Every block and wire lying wholly inside the rectangle (spec §3.2). */
export function itemsInRect(doc: StudioDocument, r: FlowRect): Pick[] {
  const ids = [SPHERE_NODE_ID, ...doc.placement.steps.keys(), ...[...doc.placement.caches.keys()].map(cacheNodeId)];
  const picks: Pick[] = [];
  for (const id of ids) {
    const b = nodeBox(doc, id);
    if (b && inside(r, b.x, b.y) && inside(r, b.x + b.w, b.y + b.h)) picks.push({ kind: 'node', id });
  }
  for (const w of doc.wires) if (w.points.every(([x, y]) => inside(r, x, y))) picks.push({ kind: 'wire', id: w.id });
  return picks;
}

/**
 * The block under a point by node id: a step, the hub or a cache (a dragged wire end is judged over each:
 * the rules refuse a cache as "not a step"), or null; `reach` grows each block on every side.
 */
export function blockAt(doc: StudioDocument, p: Point, reach = 0): string | null {
  const within = (x: number, y: number, w: number, h: number) => p.x >= x - reach && p.x <= x + w + reach && p.y >= y - reach && p.y <= y + h + reach;
  for (const [id, at] of doc.placement.steps) if (within(at.x, at.y, STEP_W, STEP_H)) return id;
  const { cx, cy } = doc.placement.sphere;
  if (Math.hypot(p.x - cx, p.y - cy) <= SPHERE_R + reach) return SPHERE_NODE_ID;
  for (const [id, at] of doc.placement.caches) if (within(at.x, at.y, CACHE_W, CACHE_H)) return cacheNodeId(id);
  return null;
}

/**
 * The wire line nearest `p` within `tolerance` (flow units), and how far along it (plan 7). The wire whose end `own`
 * is dragged counts too (an end on its own wire is refused out loud, plan 9 §3), except its run at that end, where
 * the drag starts (Review Focus 5); a wire of one run is all that run.
 */
export function wireAt(doc: StudioDocument, p: Point, tolerance: number, own: { id: string; side: Side } | null = null, skip: string | null = null): { id: string; at: number } | null {
  let best: { id: string; at: number; gap: number } | null = null;
  for (const w of doc.wires) {
    // a wire moved whole (`skip`) is never under its own ends
    if (w.id === skip) continue;
    let from = 0, to = Infinity;
    if (own && w.id === own.id) {
      if (w.points.length < 3) continue;
      if (own.side === 'head') to = lengthOf([w.points]) - lengthOf([w.points.slice(-2)]);
      else from = lengthOf([w.points.slice(0, 2)]);
    }
    const n = nearestOn([w.points], [p.x, p.y], from, to);
    if (n.gap <= tolerance && (best === null || n.gap < best.gap)) best = { id: w.id, at: n.at, gap: n.gap };
  }
  return best && { id: best.id, at: best.at };
}
