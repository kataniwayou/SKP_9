import ELK from 'elkjs/lib/elk.bundled.js';
import type { Id } from '../model/graph';
import { CACHE_PITCH, CACHE_W, CELL, COLUMN_PITCH, PMID, SPHERE_R, STEP_H, STEP_W, snap, type Point } from './geometry';
import type { LayoutDoc } from './layoutDoc';

export interface Sphere {
  cx: number;
  cy: number;
}

export interface Placement {
  sphere: Sphere;
  /** Top-left corners of every step on the canvas, parked ones included. */
  steps: Map<Id, Point>;
  /** Top-left corners of cache tags. */
  caches: Map<Id, Point>;
}

export interface PlacementInput {
  entryStepIds: Id[];
  /** The workflow's steps (reachable from the entry steps), with their wires. */
  reachable: { id: Id; nextStepIds: Id[] }[];
  /** Parked steps the layout lists and the server still has. */
  parkedIds: Id[];
  cacheIds: Id[];
  layout: LayoutDoc;
}

const elk = new ELK();
const SPHERE_NODE = '__sphere__';
const MARGIN = 32;                 // the canvas origin is a whole cell; blocks start one cell in
const FIRST_COLUMN_X = 288;        // the sphere spans 32..224, one column pitch left of the steps
const GAP = 64;                    // two cells between blocks
const DEFAULT_SPHERE: Sphere = { cx: MARGIN + SPHERE_R, cy: MARGIN + SPHERE_R };

/**
 * Where every block sits. Stored positions win (snapped to 8 px). Wired steps with no stored position
 * are laid out by elkjs (layered, left to right) and then put on the cell grid: elk's layers become
 * columns 288 apart and its y values are snapped to 32, so every step border lies on a 32 px line
 * (spec §9). When some blocks are stored, the newly placed group goes below them so nothing overlaps.
 * Parked steps with no position go in a row below everything; caches stack under the sphere.
 */
export async function place(input: PlacementInput): Promise<Placement> {
  const onCanvas = new Set([...input.reachable.map((s) => s.id), ...input.parkedIds]);
  const steps = new Map<Id, Point>();
  for (const [id, p] of Object.entries(input.layout.steps)) {
    if (onCanvas.has(id)) steps.set(id, { x: snap(p.x), y: snap(p.y) });
  }

  let sphere: Sphere | null = input.layout.sphere
    ? { cx: snap(input.layout.sphere.x), cy: snap(input.layout.sphere.y) }
    : null;

  const missingWired = input.reachable.filter((s) => !steps.has(s.id));
  if (missingWired.length > 0) {
    const placed = await layoutWithElk(input.entryStepIds, missingWired, sphere === null);
    const storedBottom = maxBottom(steps.values());
    const dy = storedBottom === null ? 0 : snap(storedBottom + GAP - placed.minY, CELL);
    for (const [id, p] of placed.steps) steps.set(id, { x: p.x, y: p.y + dy });
    if (sphere === null && placed.sphereTop !== null) {
      sphere = { cx: MARGIN + SPHERE_R, cy: placed.sphereTop + dy + SPHERE_R };
    }
  }

  if (sphere === null) sphere = sphereFor(input.entryStepIds, steps);
  else if (!input.layout.sphere) sphere = sphereFor(input.entryStepIds, steps, sphere);

  const missingParked = input.parkedIds.filter((id) => !steps.has(id));
  if (missingParked.length > 0) {
    const bottom = Math.max(maxBottom(steps.values()) ?? 0, sphere.cy + SPHERE_R);
    const y = snap(bottom + GAP, CELL);
    missingParked.forEach((id, k) => steps.set(id, { x: FIRST_COLUMN_X + k * COLUMN_PITCH, y }));
  }

  const caches = new Map<Id, Point>();
  let k = 0;
  for (const id of input.cacheIds) {
    const stored = Object.hasOwn(input.layout.caches, id) ? input.layout.caches[id] : undefined;
    if (stored) caches.set(id, { x: snap(stored.x), y: snap(stored.y) });
    else caches.set(id, { x: sphere.cx - CACHE_W / 2, y: sphere.cy + SPHERE_R + GAP + k++ * CACHE_PITCH });
  }

  return { sphere, steps, caches };
}

/** Centre the sphere on its entry steps' processor middles, so one entry wire runs straight. */
function sphereFor(entryStepIds: Id[], steps: Map<Id, Point>, fallback: Sphere = DEFAULT_SPHERE): Sphere {
  const middles = entryStepIds.map((id) => steps.get(id)).filter((p): p is Point => !!p).map((p) => p.y + PMID);
  if (middles.length === 0) return fallback;
  const firstColumn = Math.min(...[...steps.values()].map((p) => p.x));
  return {
    cx: Math.min(MARGIN + SPHERE_R, snap(firstColumn - COLUMN_PITCH + SPHERE_R + MARGIN)),
    cy: snap(middles.reduce((a, b) => a + b, 0) / middles.length),
  };
}

function maxBottom(points: Iterable<Point>): number | null {
  let bottom: number | null = null;
  for (const p of points) bottom = Math.max(bottom ?? -Infinity, p.y + STEP_H);
  return bottom;
}

interface ElkPlaced {
  steps: Map<Id, Point>;
  sphereTop: number | null;
  minY: number;
}

async function layoutWithElk(entryStepIds: Id[], wired: { id: Id; nextStepIds: Id[] }[], withSphere: boolean): Promise<ElkPlaced> {
  const ids = new Set(wired.map((s) => s.id));
  const edges: { id: string; sources: string[]; targets: string[] }[] = [];
  for (const s of wired) {
    for (const t of s.nextStepIds) if (ids.has(t) && t !== s.id) edges.push({ id: `${s.id}->${t}`, sources: [s.id], targets: [t] });
  }
  const children = wired.map((s) => ({ id: s.id, width: STEP_W, height: STEP_H }));
  if (withSphere) {
    children.unshift({ id: SPHERE_NODE, width: 2 * SPHERE_R, height: 2 * SPHERE_R });
    for (const e of entryStepIds) if (ids.has(e)) edges.push({ id: `${SPHERE_NODE}->${e}`, sources: [SPHERE_NODE], targets: [e] });
  }

  const result = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': String(GAP),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(GAP),
      'elk.layered.spacing.edgeNodeBetweenLayers': String(GAP),
      'elk.edgeRouting': 'ORTHOGONAL',
    },
    children,
    edges,
  });

  // elk's x values become column indices: a new column starts where x jumps by more than half a step.
  const laid = (result.children ?? []).map((c) => ({ id: c.id, x: c.x ?? 0, y: c.y ?? 0 }));
  const stepNodes = laid.filter((c) => c.id !== SPHERE_NODE).sort((a, b) => a.x - b.x);
  const column = new Map<string, number>();
  let index = -1, columnStart = -Infinity;
  for (const n of stepNodes) {
    if (n.x - columnStart > STEP_W / 2) { index++; columnStart = n.x; }
    column.set(n.id, index);
  }

  const minY = Math.min(...laid.map((c) => c.y));
  const steps = new Map<Id, Point>();
  for (const n of stepNodes) {
    steps.set(n.id, { x: FIRST_COLUMN_X + column.get(n.id)! * COLUMN_PITCH, y: MARGIN + snap(n.y - minY, CELL) });
  }
  const sphereNode = laid.find((c) => c.id === SPHERE_NODE);
  return {
    steps,
    sphereTop: sphereNode ? MARGIN + snap(sphereNode.y - minY, CELL) : null,
    minY: Math.min(...[...steps.values()].map((p) => p.y)),
  };
}
