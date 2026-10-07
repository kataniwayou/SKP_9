import type { Graph } from '../model/graph';
import { CACHE_NODE_PREFIX } from '../layout/nodeIds';
import type { Pick } from '../store/picks';
import type { Selection } from '../store/selection';
import { cacheNodeId, SPHERE_NODE_ID, type StudioEdge, type StudioNode } from './toFlow';

/** Classes on React Flow's node wrapper; canvas.css draws the mockup's selection from them. */
export const SELECTED_CLASS = 'studio-sel';
export const DIE_SELECTED_CLASS = 'studio-die-sel';
/** Picked blocks (plan 4). Drawn like the selection, except on a step whose die is the selection. */
export const PICK_CLASS = 'studio-pick';

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

const withClass = (current: string | undefined, add: string) => (current ? `${current} ${add}` : add);

/**
 * Design mode (plan 4): every block can be dragged; picked blocks are marked and `selected` (React Flow
 * drags them together); picked wires are marked and drawn on top. Picks naming nothing (after an undo)
 * simply match nothing.
 */
export function withPicks(nodes: StudioNode[], edges: StudioEdge[], picks: readonly Pick[]): { nodes: StudioNode[]; edges: StudioEdge[] } {
  const ids = new Set(picks.filter((p) => p.kind === 'node').map((p) => p.id));
  const wires = new Set(picks.filter((p) => p.kind === 'wire').map((p) => p.id));
  return {
    nodes: nodes.map((n) => ({ ...n, draggable: true, selected: ids.has(n.id), className: ids.has(n.id) ? withClass(n.className, PICK_CLASS) : n.className })) as StudioNode[],
    edges: edges.map((e) => (e.type === 'cable' && e.data
      ? { ...e, zIndex: wires.has(e.id) ? 1 : 0, data: { ...e.data, picked: wires.has(e.id) } }
      : e)) as StudioEdge[],
  };
}

/** The selection one picked block stands for, or null when the graph has no such block. */
export function selectionOfNode(id: string, graph: Graph): Selection | null {
  if (id === SPHERE_NODE_ID) return { kind: 'workflow' };
  if (id.startsWith(CACHE_NODE_PREFIX)) {
    const cacheId = id.slice(CACHE_NODE_PREFIX.length);
    return graph.caches.has(cacheId) ? { kind: 'cache', cacheId } : null;
  }
  return graph.steps.has(id) ? { kind: 'step', stepId: id } : null;
}

/**
 * The Inspector's selection for a set of picks (spec §3.3): one block is its entity (the clicked die
 * stays the processor); a wire, several items or none show no entity.
 */
export function selectionForPicks(picks: readonly Pick[], clicked: { id: string; selection: Selection | null } | null, graph: Graph): Selection | null {
  if (picks.length !== 1 || picks[0]!.kind !== 'node') return null;
  const id = picks[0]!.id;
  return clicked && clicked.id === id ? clicked.selection : selectionOfNode(id, graph);
}
