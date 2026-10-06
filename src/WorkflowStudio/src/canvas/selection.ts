import type { Graph } from '../model/graph';
import type { Selection } from '../store/selection';
import { cacheNodeId, SPHERE_NODE_ID, type StudioNode } from './toFlow';

/** Classes on React Flow's node wrapper; canvas.css draws the mockup's selection from them. */
export const SELECTED_CLASS = 'studio-sel';
export const DIE_SELECTED_CLASS = 'studio-die-sel';

/** Which node wrapper carries which selection class. A processor is highlighted on one step's die. */
function selectedNode(selection: Selection): { id: string; className: string } {
  switch (selection.kind) {
    case 'workflow': return { id: SPHERE_NODE_ID, className: SELECTED_CLASS };
    case 'step': return { id: selection.stepId, className: SELECTED_CLASS };
    case 'processor': return { id: selection.stepId, className: DIE_SELECTED_CLASS };
    case 'cache': return { id: cacheNodeId(selection.cacheId), className: SELECTED_CLASS };
  }
}

/** The nodes with the selection marked. Pure; with nothing selected the same array comes back. */
export function withSelection(nodes: StudioNode[], selection: Selection | null): StudioNode[] {
  if (selection === null) return nodes;
  const { id, className } = selectedNode(selection);
  return nodes.map((n) => (n.id === id ? { ...n, className: n.className ? `${n.className} ${className}` : className } : n));
}

/**
 * What a click on a node selects. A click inside a step's die (`.chipg`) selects that step's
 * processor, unless the step's processor is not in the graph (then the step itself).
 */
export function selectionFromClick(node: { id: string; type?: string }, target: Element | null, graph: Graph): Selection | null {
  switch (node.type) {
    case 'workflow':
      return { kind: 'workflow' };
    case 'cache':
      return { kind: 'cache', cacheId: node.id.slice(cacheNodeId('').length) };
    case 'step': {
      const step = graph.steps.get(node.id);
      if (!step) return null;
      if (target?.closest('.chipg') && graph.processors.has(step.processorId)) {
        return { kind: 'processor', processorId: step.processorId, stepId: step.id };
      }
      return { kind: 'step', stepId: step.id };
    }
    default:
      return null;
  }
}
