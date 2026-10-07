import type { Id, Step } from '../model/graph';
import { clearPath } from './detour';
import { CACHE_H, CACHE_W, GRID, PORT_GAP, clampLanding, SPHERE_R, STEP_H, STEP_W, offset, snap, type Point } from './geometry';
import { CONTACT_MARGIN, inLoop, lengthOf, nearestOn, ownEnds, pointAt, slice } from './junctions';
import type { Placement, Sphere } from './placement';
import { computeDepartures, computeLandings, departureX, WORKFLOW_SOURCE, type SourceId, type WireEnd } from './ports';
import { route, simplify, type Box, type Pt } from './router';
import { pointsOfShape, type Ends, type WireShape } from './shape';

export interface WireRoute {
  /** `${source}->${target}`; unique because a step's nextStepIds are unique. */
  id: string;
  source: SourceId;
  target: Id;
  points: Pt[];
  /** The target step's entry condition: the wire's colour. */
  condition: number;
  broken: boolean;
  /** Set when the wire ends on another wire's line (plan 7); `points` is then its own line. */
  joint?: Joint;
}

export interface Joint {
  host: string;
  /** The filled dot on the host's line where the own line ends. */
  contact: Pt;
  /** The filled dot where the branch leaves the shared line; null when the wire goes into its host's step. */
  split: Pt | null;
  /** From the split to the wire's landing, ending in its arrow head; empty when `split` is null. */
  branch: Pt[];
  /** The own line without its tail: what the own line's bends are measured on. */
  own: Pt[];
  ownEnds: Ends;
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

  const routed = wires.map((w): WireRoute => {
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
  return joinWires(routed, input, boxes);
}

/** Second pass (spec §5.2): each joined wire after its host; a contact that is not valid leaves the wire plain. */
function joinWires(routed: WireRoute[], input: WiringInput, boxes: Box[]): WireRoute[] {
  const shapes = input.shapes;
  if (!shapes) return routed;
  const byId = new Map(routed.map((r) => [r.id, r]));
  const hostOf = (id: string) => (Object.hasOwn(shapes, id) ? shapes[id]!.contact?.host ?? undefined : undefined);
  const travel = new Map<string, Pt[]>();
  const done = new Set<string>();
  const resolve = (id: string): void => {
    if (done.has(id)) return;
    done.add(id);
    const r = byId.get(id)!;
    const c = Object.hasOwn(shapes, id) ? shapes[id]!.contact ?? null : null;
    const host = c ? byId.get(c.host) : undefined;
    if (c && host && host.id !== id && host.condition === r.condition && !inLoop(id, hostOf)) {
      resolve(host.id);
      const joined = joinOne(byId.get(id)!, byId.get(host.id)!, travel.get(host.id)!, c.at, shapes[id]!, boxes);
      if (joined) { byId.set(id, joined.route); travel.set(id, joined.travel); return; }
    }
    travel.set(id, r.points);
  };
  for (const r of routed) resolve(r.id);
  return routed.map((r) => byId.get(r.id)!);
}

/** A on host B (spec §5.3); null when B's line is too short to hold a contact. */
function joinOne(r: WireRoute, host: WireRoute, hostTravel: Pt[], at: number, shape: WireShape, boxes: Box[]): { route: WireRoute; travel: Pt[] } | null {
  const drawn = host.joint && host.joint.branch.length > 0 ? [host.points, host.joint.branch] : [host.points];
  const total = lengthOf(drawn);
  if (total < 2 * CONTACT_MARGIN) return null;
  const atC = Math.min(Math.max(snap(at, GRID), CONTACT_MARGIN), total - CONTACT_MARGIN);
  const { p: contact, vertical } = pointAt(drawn, atC);
  const [sx, sy] = r.points[0]!;
  const { ends, tail } = ownEnds(sx, sy, contact, vertical);
  const own = shape.bends && shape.bends.xs.length > 0
    ? simplify(pointsOfShape(ends, shape.bends))
    : clearPath(route(ends.sx, ends.sy, ends.tx, ends.ty, boxIdOf(r.source), '', 0, boxes), boxes);
  const points = simplify([...own, ...tail]);
  // the contact's place on the host's travelled line: on the host's own line it is the same distance; on its branch, from the end
  const ownLen = lengthOf([host.points]), travelLen = lengthOf([hostTravel]);
  const onTravel = !host.joint || atC <= ownLen ? atC : travelLen - lengthOf([host.joint.branch]) + (atC - ownLen);
  const landing = r.points[r.points.length - 1]!;
  if (r.target === host.target) {
    const joint: Joint = { host: host.id, contact, split: null, branch: [], own, ownEnds: ends };
    return { route: { ...r, points, joint }, travel: [...points, ...slice(hostTravel, onTravel, travelLen).slice(1)] };
  }
  const s = nearestOn([hostTravel], landing, onTravel, travelLen - CONTACT_MARGIN);
  const split: Pt = [snap(s.p[0], GRID), snap(s.p[1], GRID)];
  const branch = clearPath(route(split[0], split[1], landing[0], landing[1], '', stepBoxId(r.target), 0, boxes), boxes);
  const joint: Joint = { host: host.id, contact, split, branch, own, ownEnds: ends };
  return { route: { ...r, points, joint }, travel: [...points, ...slice(hostTravel, onTravel, s.at).slice(1), ...branch.slice(1)] };
}

/** The dashed tether from the sphere's bottom to a cache's top centre, right-angled. */
export function tetherPoints(sphere: Sphere, cache: Point): Pt[] {
  const from: Pt = [sphere.cx, sphere.cy + SPHERE_R];
  const to: Pt = [cache.x + CACHE_W / 2, cache.y];
  if (from[0] === to[0]) return [from, to];
  const midY = Math.round((from[1] + to[1]) / 2 / 8) * 8;
  return [from, [from[0], midY], [to[0], midY], to];
}
