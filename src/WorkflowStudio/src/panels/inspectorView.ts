import type { EntityReadDto } from '../api/entities';
import { entityName } from '../model/entityNames';
import type { Audit, Graph } from '../model/graph';
import type { InspectorTarget } from '../store/inspectorTarget';

/** One read-only line of the Inspector. `value` is always text: an absent value reads "—". */
export interface Row {
  label: string;
  value: string;
}

const NONE = '—';
const text = (value: string | null | undefined): string => (value === null || value === undefined || value === '' ? NONE : value);

/** `2026-10-05T12:00:00.123456Z` → `2026-10-05 12:00:00.123 UTC`; anything else is shown as it came. */
export function formatInstant(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?Z$/.exec(iso);
  if (!m) return text(iso);
  return `${m[1]} ${m[2]}${m[3] ? m[3].slice(0, 4) : ''} UTC`;
}

/** The base-entity fields behind "▸ show all" (spec §7), from the entity's last GET. */
export function detailRows(dto: EntityReadDto): Row[] {
  return [
    { label: 'Id', value: text(dto.id) },
    { label: 'Created at', value: formatInstant(dto.createdAt ?? '') },
    { label: 'Created by', value: text(dto.createdBy) },
    { label: 'Updated at', value: formatInstant(dto.updatedAt ?? '') },
    { label: 'Updated by', value: text(dto.updatedBy) },
  ];
}

/** The unique name (spec §7) by the saved name and version, never by what is being typed. */
export function uniqueNameOf(dto: EntityReadDto): string {
  return entityName(dto.name ?? '', dto.version ?? '', dto.id ?? '');
}

/** The kind pill. An unwired step is an ordinary step (plan 8). */
export function kindLabel(target: InspectorTarget): string {
  return target.kind.toUpperCase();
}

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
      return { complete: true, values: { id: w.id, name: w.name, version: w.version, description: w.description, cronExpression: w.cronExpression, ...auditOf(w.audit) } };
    }
    case 'step': {
      const s = graph.steps.get(target.id);
      return s ? { complete: true, values: { id: s.id, name: s.name, version: s.version, description: s.description, entryCondition: s.entryCondition, processorId: s.processorId, ...auditOf(s.audit) } } : null;
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
      return a ? { complete: false, values: { id: a.id, stepId: a.stepId, payload: a.payload } } : null;
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
