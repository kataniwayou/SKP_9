import type { EntityReadDto } from '../api/entities';
import type { Audit, Graph } from '../model/graph';
import type { InspectorTarget } from './inspectorTarget';

/** The audit fields as a read DTO carries them, from the graph's `audit`. */
const auditOf = (a: Audit) => ({ createdAt: a.createdAt, createdBy: a.createdBy, updatedAt: a.updatedAt, updatedBy: a.updatedBy });

/**
 * The shown entity as the workflow's graph holds it (2026-10-10, the user's ruling): the Inspector shows the design
 * graph's entities, so its base values come from the same loaded graph the canvas and the read-outs draw, never from
 * a copy of its own that could lag. `complete`: the graph carries every field the form shows (workflow, step,
 * processor, cache); a schema's definition and an assignment's name, version and description are not in the graph,
 * so for those the per-entity read fills the rest. Null when the graph has no such entity (a schema copy's empty
 * slot, a created assignment).
 */
export function graphBaseOf(graph: Graph, target: InspectorTarget): { values: Record<string, unknown>; complete: boolean } | null {
  switch (target.kind) {
    case 'workflow': {
      const w = graph.workflow;
      return { complete: true, values: { id: w.id, name: w.name, version: w.version, description: w.description, cronExpression: w.cronExpression, ...auditOf(w.audit), updatedAt: w.updatedAt } };
    }
    case 'step': {
      const s = graph.steps.get(target.id);
      return s ? { complete: true, values: { id: s.id, name: s.name, version: s.version, description: s.description, entryCondition: s.entryCondition, processorId: s.processorId, ...auditOf(s.audit), updatedAt: s.updatedAt } } : null;
    }
    case 'processor': {
      const p = graph.processors.get(target.id);
      return p ? {
        complete: true,
        values: {
          id: p.id, name: p.name, version: p.version, description: p.description, sourceHash: p.sourceHash, instanceId: p.instanceId,
          inputSchemaId: p.inputSchemaId, outputSchemaId: p.outputSchemaId, configSchemaId: p.configSchemaId, ...auditOf(p.audit),
        },
      } : null;
    }
    case 'cache': {
      const c = graph.caches.get(target.id);
      return c ? { complete: true, values: { id: c.id, name: c.name, version: c.version, description: c.description, root: c.root, items: c.items, ...auditOf(c.audit) } } : null;
    }
    case 'schema': {
      const s = target.id === '' ? undefined : graph.schemas.get(target.id);
      return s ? { complete: false, values: { id: s.id, name: s.name, version: s.version, description: s.description, ...auditOf(s.audit) } } : null;
    }
    case 'assignment': {
      const a = graph.assignments.find((x) => x.id === target.id);
      return a ? { complete: false, values: { id: a.id, stepId: a.stepId, payload: a.payload, updatedAt: a.updatedAt } } : null;
    }
  }
}

/** The base the Inspector's form shows: the graph's values over the entity's read; the graph alone when it carries all. */
export function inspectorBaseOf(graph: Graph, target: InspectorTarget, read: EntityReadDto | null): EntityReadDto | null {
  const fromGraph = graphBaseOf(graph, target);
  if (fromGraph === null) return read;
  if (read === null && !fromGraph.complete) return null;
  return { ...(read ?? {}), ...fromGraph.values } as EntityReadDto;
}

/**
 * The base an Inspector edit is judged against (2026-10-10 review): the same graph-backed base the form shows, with the
 * entity's read only when it was made in the document's current generation. Null while an entity the graph does not
 * fully carry (an assignment, a schema) has no read of the current generation yet: its form waits, and no edit is taken.
 */
export function editBaseOf(graph: Graph, target: InspectorTarget, saved: { key: string; dto: EntityReadDto; gen?: number } | null, key: string, generation: number): EntityReadDto | null {
  const read = saved !== null && saved.key === key && (saved.gen ?? generation) >= generation ? saved.dto : null;
  const fromGraph = graphBaseOf(graph, target);
  if (read === null && (fromGraph === null || !fromGraph.complete)) return null;
  return inspectorBaseOf(graph, target, read);
}
