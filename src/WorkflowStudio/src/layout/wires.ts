import type { Id, Step } from '../model/graph';
import { CACHE_H, CACHE_W, PMID, SPHERE_R, STEP_H, STEP_W, type Point } from './geometry';
import type { Placement, Sphere } from './placement';
import { WORKFLOW_SOURCE } from './ports';
import type { Box, Pt } from './router';

export interface WiringInput {
  entryStepIds: Id[];
  /** Every step on the canvas, parked ones included. */
  steps: ReadonlyMap<Id, Step>;
}

export const SPHERE_BOX_ID = 'wf';
export const stepBoxId = (id: Id) => `step:${id}`;
export const cacheBoxId = (id: Id) => `cache:${id}`;

/** Where a wire from `source` leaves: a step's output port or the hub's right edge; null for a step not on the canvas. */
export function portOf(placement: Placement, source: Id): Point | null {
  if (source === WORKFLOW_SOURCE) return { x: placement.sphere.cx + SPHERE_R, y: placement.sphere.cy };
  const at = placement.steps.get(source);
  return at ? { x: at.x + STEP_W, y: at.y + PMID } : null;
}

export function blockBoxes(placement: Placement): Box[] {
  const boxes: Box[] = [];
  for (const [id, p] of placement.steps) boxes.push({ id: stepBoxId(id), x: p.x, y: p.y, w: STEP_W, h: STEP_H });
  const { cx, cy } = placement.sphere;
  boxes.push({ id: SPHERE_BOX_ID, x: cx - SPHERE_R, y: cy - SPHERE_R, w: 2 * SPHERE_R, h: 2 * SPHERE_R });
  for (const [id, p] of placement.caches) boxes.push({ id: cacheBoxId(id), x: p.x, y: p.y, w: CACHE_W, h: CACHE_H });
  return boxes;
}

/** The dashed tether from the sphere's bottom to a cache's top centre, right-angled. */
export function tetherPoints(sphere: Sphere, cache: Point): Pt[] {
  const from: Pt = [sphere.cx, sphere.cy + SPHERE_R];
  const to: Pt = [cache.x + CACHE_W / 2, cache.y];
  if (from[0] === to[0]) return [from, to];
  const midY = Math.round((from[1] + to[1]) / 2 / 8) * 8;
  return [from, [from[0], midY], [to[0], midY], to];
}
