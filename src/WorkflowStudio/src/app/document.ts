import type { Id, Graph } from '../model/graph';
import type { Placement } from '../layout/placement';
import type { LooseRoute, WireRoute } from '../layout/wires';

/**
 * One opened workflow, ready to draw: the graph (unwired steps included), where every block sits, every
 * wire's route, and the loose wires (plan 8 §5). Opening reads with GETs only: nothing is judged on load.
 */
export interface StudioDocument {
  graph: Graph;
  /** Steps on the canvas that the entry steps do not reach. They look like every other step (plan 8). */
  parkedIds: Id[];
  placement: Placement;
  wires: WireRoute[];
  loose: LooseRoute[];
}
