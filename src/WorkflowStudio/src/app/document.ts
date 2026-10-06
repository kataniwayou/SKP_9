import type { Id, Graph, WorkflowProblem } from '../model/graph';
import type { Placement } from '../layout/placement';
import type { WireRoute } from '../layout/wires';

/** One opened workflow, ready to draw: the graph (parked steps included), where every block sits,
 *  every wire's route, and the problems BaseApi's validate reported (null when it could not be reached). */
export interface StudioDocument {
  graph: Graph;
  parkedIds: Id[];
  placement: Placement;
  wires: WireRoute[];
  /** What `POST /workflows/{id}/validate` returned; null when that call failed. Advisory: the graph draws either way. */
  problems: WorkflowProblem[] | null;
}
