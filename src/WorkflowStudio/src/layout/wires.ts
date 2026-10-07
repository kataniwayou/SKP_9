import type { Id, Step } from '../model/graph';
import { CACHE_H, CACHE_W, PORT_GAP, clampLanding, SPHERE_R, STEP_H, STEP_W, offset, type Point } from './geometry';
import type { Placement, Sphere } from './placement';
import { computeDepartures, computeLandings, departureX, WORKFLOW_SOURCE, type SourceId, type WireEnd } from './ports';
import { route, simplify, type Box, type Pt } from './router';
import { pointsOfShape, type WireShape } from './shape';

export interface WireRoute {
  /** `${source}->${target}`; unique because a step's nextStepIds are unique. */
  id: string;
  source: SourceId;
  target: Id;
  points: Pt[];
  /** The target step's entry condition: the wire's colour. */
  condition: number;
  broken: boolean;
}

export interface WiringInput {
  entryStepIds: Id[];
  /** Every step on the canvas, parked ones included. */
  steps: ReadonlyMap<Id, Step>;
  /** `${parentStepId}->${childStepId}` for every wire BaseApi's validate reported as a schemaEdge problem. */
  brokenEdges: ReadonlySet<string>;
  /** The draft's wire shapes by wire id (plan 4); absent: every wire is automatic. */
  shapes?: Readonly<Record<string, WireShape>>;
}

export const SPHERE_BOX_ID = 'wf';
export const stepBoxId = (id: Id) => `step:${id}`;
export const cacheBoxId = (id: Id) => `cache:${id}`;
const boxIdOf = (source: SourceId) => (source === WORKFLOW_SOURCE ? SPHERE_BOX_ID : stepBoxId(source));

/** Every wire whose two ends are on the canvas: entry wires from the sphere, then step wires. */
export function collectWires(input: WiringInput, placement: Placement): WireEnd[] {
  const placed = (id: Id) => placement.steps.has(id) && input.steps.has(id);
  const wires: WireEnd[] = [];
  for (const id of new Set(input.entryStepIds)) if (placed(id)) wires.push({ source: WORKFLOW_SOURCE, target: id });
  for (const [id, step] of input.steps) {
    if (!placed(id)) continue;
    for (const next of step.nextStepIds) if (placed(next)) wires.push({ source: id, target: next });
  }
  return wires;
}

export function blockBoxes(placement: Placement): Box[] {
  const boxes: Box[] = [];
  for (const [id, p] of placement.steps) boxes.push({ id: stepBoxId(id), x: p.x, y: p.y, w: STEP_W, h: STEP_H });
  const { cx, cy } = placement.sphere;
  boxes.push({ id: SPHERE_BOX_ID, x: cx - SPHERE_R, y: cy - SPHERE_R, w: 2 * SPHERE_R, h: 2 * SPHERE_R });
  for (const [id, p] of placement.caches) boxes.push({ id: cacheBoxId(id), x: p.x, y: p.y, w: CACHE_W, h: CACHE_H });
  return boxes;
}

export function routeWires(input: WiringInput, placement: Placement): WireRoute[] {
  const wires = collectWires(input, placement);
  const departures = computeDepartures(wires, placement);
  const landings = computeLandings(wires, placement, departures);
  const boxes = blockBoxes(placement);

  return wires.map((w) => {
    const id = `${w.source}->${w.target}`;
    const shape = input.shapes && Object.hasOwn(input.shapes, id) ? input.shapes[id] : undefined;
    const targets = [...departures.get(w.source)!.keys()];
    const nudge = offset(targets.indexOf(w.target), targets.length, PORT_GAP);
    const sx = departureX(w.source, placement), sy = departures.get(w.source)!.get(w.target)!;
    const at = placement.steps.get(w.target)!;
    const tx = at.x;
    const ty = shape?.landing != null ? at.y + clampLanding(shape.landing) : landings.get(w.target)!.get(w.source)!;
    const target = input.steps.get(w.target)!;
    const points = shape?.bends && shape.bends.xs.length > 0
      ? simplify(pointsOfShape({ sx, sy, tx, ty }, shape.bends))
      : route(sx, sy, tx, ty, boxIdOf(w.source), stepBoxId(w.target), nudge, boxes);
    return {
      id,
      source: w.source,
      target: w.target,
      points,
      condition: target.entryCondition,
      broken: w.source !== WORKFLOW_SOURCE && input.brokenEdges.has(id),
    };
  });
}

/** The dashed tether from the sphere's bottom to a cache's top centre, right-angled. */
export function tetherPoints(sphere: Sphere, cache: Point): Pt[] {
  const from: Pt = [sphere.cx, sphere.cy + SPHERE_R];
  const to: Pt = [cache.x + CACHE_W / 2, cache.y];
  if (from[0] === to[0]) return [from, to];
  const midY = Math.round((from[1] + to[1]) / 2 / 8) * 8;
  return [from, [from[0], midY], [to[0], midY], to];
}
