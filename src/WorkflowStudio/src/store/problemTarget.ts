import type { Graph, Id, WorkflowProblem } from '../model/graph';
import type { Selection } from './selection';

/** BaseApi names a missing *entry* step with an all-zero parent (the workflow is the parent). */
const ZERO_GUID = '00000000-0000-0000-0000-000000000000';

/**
 * The entity a validate problem names, as a canvas selection, or null when it names nothing on this
 * canvas (spec §7.3). `offending` is typed `unknown` and read defensively: a field that is missing,
 * of the wrong type or naming an id this document does not hold gives null, never a throw.
 *
 * - cycle `{ stepChain }`: the first step of the chain this document holds;
 * - missingStep `{ parentStepId, missingChildId }`: the parent step; an all-zero parent is the workflow;
 * - schemaEdge `{ parentStepId, childStepId }`: the child (whose input does not match), else the parent;
 * - payloadConfigSchema `{ assignmentId, errors }`: the step the assignment belongs to;
 * - processorLiveness `{ procId, reason }`: the processor, on the first step that uses it.
 */
export function problemTarget(problem: WorkflowProblem, graph: Graph): Selection | null {
  const offending = problem.offending;
  if (typeof offending !== 'object' || offending === null) return null;
  const field = (name: string): unknown => (offending as Record<string, unknown>)[name];
  const step = (id: unknown): Selection | null =>
    typeof id === 'string' && graph.steps.has(id) ? { kind: 'step', stepId: id } : null;

  switch (problem.gate) {
    case 'cycle': {
      const chain = field('stepChain');
      if (!Array.isArray(chain)) return null;
      for (const id of chain) {
        const hit = step(id);
        if (hit) return hit;
      }
      return null;
    }
    case 'missingStep': {
      const parent = field('parentStepId');
      if (typeof parent === 'string' && parent.toLowerCase() === ZERO_GUID) return { kind: 'workflow' };
      return step(parent);
    }
    case 'schemaEdge':
      return step(field('childStepId')) ?? step(field('parentStepId'));
    case 'payloadConfigSchema': {
      const id = field('assignmentId');
      const assignment = graph.assignments.find((a) => a.id === id);
      return assignment ? step(assignment.stepId) : null;
    }
    case 'processorLiveness': {
      const id = field('procId');
      if (typeof id !== 'string' || !graph.processors.has(id)) return null;
      const user = firstStepUsing(graph, id);
      return user === null ? null : { kind: 'processor', processorId: id, stepId: user };
    }
    default:
      return null;
  }
}

function firstStepUsing(graph: Graph, processorId: Id): Id | null {
  for (const step of graph.steps.values()) if (step.processorId === processorId) return step.id;
  return null;
}
