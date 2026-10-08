import type { StudioDocument } from '../app/document';
import type { Circuit } from '../circuit/circuit';
import type { Point } from '../layout/geometry';
import type { Id } from '../model/graph';
import { circuitOf, type Draft } from './draft';

/** The canvas layout Save writes (plan 8 §4.2; plan 9 §7, decision 14): positions, every canvas step, and the whole circuit. */
export interface SavedLayout {
  v: 2;
  /** The hub's centre. */
  sphere: Point;
  steps: Record<Id, Point>;
  caches: Record<Id, Point>;
  /**
   * Every step on the canvas. GET /graph returns only the steps the real entry steps reach; after a stored
   * design wired steps in or out, the loader still finds each one here (it skips the reachable ones).
   */
  parked: Id[];
  /** Every wire by id with its ends (a terminal point, a junction's host and point, or an open point) and its bends. */
  wires: Circuit;
}

/** The layout of what the canvas shows: the draft's circuit, or the workflow's own wires when it has none. */
export function layoutOf(shown: StudioDocument, draft: Draft): SavedLayout {
  const points = (m: ReadonlyMap<Id, Point>) => Object.fromEntries([...m].map(([id, p]) => [id, { x: p.x, y: p.y }]));
  return {
    v: 2,
    sphere: { x: shown.placement.sphere.cx, y: shown.placement.sphere.cy },
    steps: points(shown.placement.steps),
    caches: points(shown.placement.caches),
    parked: [...shown.placement.steps.keys()],
    wires: { ...circuitOf(shown, draft) },
  };
}
