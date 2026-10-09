import { parseSlotKey, type EntityEdits } from '../design/design';
import type { DesignError, Graph, Id } from '../model/graph';
import type { Pick } from './picks';
import type { Selection } from './selection';

/**
 * The entity a Save error names, as a canvas selection (plan 8 §4.1: clicking a pinned problem in Output selects it),
 * or null when it names nothing on this canvas. An assignment selects its step (a created one's step is
 * found in the design); a processor, and a schema copy through its processor, select the processor on the
 * first step that uses it.
 */
export function errorTarget(error: DesignError, graph: Graph, edits: EntityEdits): Selection | null {
  switch (error.kind) {
    case 'workflow': return { kind: 'workflow' };
    case 'step': return graph.steps.has(error.id) ? { kind: 'step', stepId: error.id } : null;
    case 'cache': return graph.caches.has(error.id) ? { kind: 'cache', cacheId: error.id } : null;
    case 'processor': return processorOn(graph, error.id);
    case 'assignment': {
      const stepId = graph.assignments.find((a) => a.id === error.id)?.stepId
        ?? Object.entries(edits.assignments).find(([, op]) => op.id === error.id)?.[0];
      return stepId !== undefined && graph.steps.has(stepId) ? { kind: 'step', stepId } : null;
    }
    case 'schema': {
      const key = Object.entries(edits.schemas).find(([, c]) => c.id === error.id)?.[0];
      const parsed = key === undefined ? null : parseSlotKey(key);
      return parsed === null ? null : processorOn(graph, parsed.processorId);
    }
    default: return null;
  }
}

/** The wires a Save error names, to pick on the canvas (an overlap short circuit: both wires); null for any other error. */
export function errorPicks(error: DesignError): Pick[] | null {
  if (error.kind !== 'wire') return null;
  return [{ kind: 'wire', id: error.id }, ...(error.other !== undefined ? [{ kind: 'wire' as const, id: error.other }] : [])];
}

function processorOn(graph: Graph, id: Id): Selection | null {
  for (const step of graph.steps.values()) if (step.processorId === id) return { kind: 'processor', processorId: id, stepId: step.id };
  return null;
}
