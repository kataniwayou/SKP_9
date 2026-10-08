import type { StudioDocument } from '../app/document';
import type { Point } from '../layout/geometry';
import { WORKFLOW_SOURCE } from '../layout/ports';
import type { WireShape } from '../layout/shape';
import { isLooseStart, type LooseWire } from '../layout/wires';
import type { Id } from '../model/graph';
import type { Draft } from './draft';

/** The canvas layout Save writes (plan 8 §4.2): positions, every canvas step, wire shapes, loose wires. */
export interface SavedLayout {
  v: 1;
  /** The hub's centre. */
  sphere: Point;
  steps: Record<Id, Point>;
  caches: Record<Id, Point>;
  /**
   * Every step on the canvas. GET /graph returns only the steps the real entry steps reach; after a stored
   * design wired steps in or out, the loader still finds each one here (it skips the reachable ones).
   */
  parked: Id[];
  routes: Record<string, WireShape>;
  loose: Record<string, LooseWire>;
}

/** The layout of what the canvas shows: shapes only of wires that exist, loose wires only from sources (or, open at the start, to targets) on the canvas. */
export function layoutOf(shown: StudioDocument, draft: Draft): SavedLayout {
  const wires = new Set(shown.wires.map((w) => w.id));
  const onCanvas = (source: string) => source === WORKFLOW_SOURCE || shown.placement.steps.has(source);
  const points = (m: ReadonlyMap<Id, Point>) => Object.fromEntries([...m].map(([id, p]) => [id, { x: p.x, y: p.y }]));
  return {
    v: 1,
    sphere: { x: shown.placement.sphere.cx, y: shown.placement.sphere.cy },
    steps: points(shown.placement.steps),
    caches: points(shown.placement.caches),
    parked: [...shown.placement.steps.keys()],
    routes: Object.fromEntries(Object.entries(draft.routes).filter(([id]) => wires.has(id))),
    loose: Object.fromEntries(Object.entries(draft.loose).filter(([, l]) => (isLooseStart(l) ? shown.placement.steps.has(l.target) : onCanvas(l.source)))),
  };
}
