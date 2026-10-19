import { routeWires } from '../layout/circuitRoute';
import { parseLayout } from '../layout/layoutDoc';
import { place } from '../layout/placement';
import type { Graph, Id } from '../model/graph';
import type { StudioDocument } from './document';

/** A new workflow's version until the Inspector changes it (2026-10-10, Workflow › New workflow). */
export const NEW_VERSION = '1.0.0';

/**
 * A new workflow's name (2026-10-10): `untitled`, or `untitled-2`, `untitled-3`, … when a workflow BaseApi lists or a
 * document already open has that name. A placeholder: the Inspector renames it, and Save refuses a name that is taken.
 */
export function untitledName(taken: Iterable<string>): string {
  const names = new Set(taken);
  if (!names.has('untitled')) return 'untitled';
  for (let n = 2; ; n++) if (!names.has(`untitled-${n}`)) return `untitled-${n}`;
}

/**
 * A workflow that exists only in the studio until its first Save creates it (2026-10-10, Workflow › New workflow): a
 * blank graph, only the workflow hub on the canvas, at its usual spot on the left. Nothing is read from BaseApi.
 */
export async function newWorkflowDocument(workflowId: Id, name: string, version: string = NEW_VERSION): Promise<StudioDocument> {
  const graph: Graph = {
    workflow: {
      id: workflowId, name, version, description: null, cronExpression: null, entryStepIds: [], assignmentIds: [], cacheIds: [],
      updatedAt: '', audit: { createdAt: '', createdBy: null, updatedAt: '', updatedBy: null },
    },
    steps: new Map(), processors: new Map(), schemas: new Map(), assignments: [], caches: new Map(), layout: null, design: null,
  };
  const placement = await place({ entryStepIds: [], reachable: [], parkedIds: [], cacheIds: [], layout: parseLayout(null) });
  const wires = routeWires({ entryStepIds: [], steps: graph.steps }, placement);
  return { graph, parkedIds: [], placement, wires };
}
