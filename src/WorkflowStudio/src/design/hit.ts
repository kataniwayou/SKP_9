import type { StudioDocument } from '../app/document';
import { CACHE_H, CACHE_W, SPHERE_R, STEP_H, STEP_W, type Point } from '../layout/geometry';
import { CACHE_NODE_PREFIX, cacheNodeId, SPHERE_NODE_ID } from '../layout/nodeIds';
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

/** The step or the hub under a point (a wire end may be dropped on them), or null. */
export function blockAt(doc: StudioDocument, p: Point): string | null {
  for (const [id, at] of doc.placement.steps) {
    if (p.x >= at.x && p.x <= at.x + STEP_W && p.y >= at.y && p.y <= at.y + STEP_H) return id;
  }
  const { cx, cy } = doc.placement.sphere;
  return Math.hypot(p.x - cx, p.y - cy) <= SPHERE_R ? SPHERE_NODE_ID : null;
}
