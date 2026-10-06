import type { StudioDocument } from '../app/document';
import { entityName } from '../model/entityNames';
import { conditionInfo } from '../model/entryConditions';
import type { Audit, Graph, Id } from '../model/graph';
import type { Selection } from '../store/selection';

/** One read-only line of the Inspector. `value` is always text: an absent value reads "—". */
export interface Row {
  label: string;
  value: string;
  /** The entry condition's colour, drawn as a dot before the value. */
  dot?: string;
  /** An empty schema slot, drawn faint. */
  empty?: boolean;
}

/**
 * What the Inspector shows for a selection (slice 3a, read-only; spec §7): the kind pill, the
 * unique entity name, name and version, the base-entity details behind "▸ show all", then the
 * entity's own fields. AssignmentIds are never shown.
 */
export interface InspectorView {
  kind: string;
  uniqueName: string;
  title: string;
  head: Row[];
  details: Row[];
  fields: Row[];
  note?: string;
  /** A second section: the processor's three schema slots. */
  slots?: Row[];
}

const NONE = '—';
const text = (value: string | null | undefined): string => (value === null || value === undefined || value === '' ? NONE : value);

/** `2026-10-05T12:00:00.123456Z` → `2026-10-05 12:00:00.123 UTC`; anything else is shown as it came. */
export function formatInstant(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?Z$/.exec(iso);
  if (!m) return text(iso);
  return `${m[1]} ${m[2]}${m[3] ? m[3].slice(0, 4) : ''} UTC`;
}

function details(id: Id, audit: Audit): Row[] {
  return [
    { label: 'Id', value: id },
    { label: 'Created at', value: formatInstant(audit.createdAt) },
    { label: 'Created by', value: text(audit.createdBy) },
    { label: 'Updated at', value: formatInstant(audit.updatedAt) },
    { label: 'Updated by', value: text(audit.updatedBy) },
  ];
}

function schemaSlot(graph: Graph, label: string, id: Id | null): Row {
  if (!id) return { label, value: '∅', empty: true };
  const schema = graph.schemas.get(id);
  return { label, value: schema ? entityName(schema.name, schema.version, schema.id) : id };
}

/** The view for a selection, or null when nothing (or nothing this document holds) is selected. */
export function inspectorView(doc: StudioDocument, selection: Selection | null): InspectorView | null {
  if (selection === null) return null;
  const { graph } = doc;
  switch (selection.kind) {
    case 'workflow': {
      const w = graph.workflow;
      return {
        kind: 'WORKFLOW', uniqueName: entityName(w.name, w.version, w.id), title: 'Workflow',
        head: [{ label: 'Name', value: text(w.name) }, { label: 'Version', value: text(w.version) }],
        details: details(w.id, w.audit),
        fields: [{ label: 'Description', value: text(w.description) }, { label: 'Cron', value: text(w.cronExpression) }],
      };
    }
    case 'step': {
      const s = graph.steps.get(selection.stepId);
      if (!s) return null;
      const parked = doc.parkedIds.includes(s.id);
      const p = graph.processors.get(s.processorId);
      const condition = conditionInfo(s.entryCondition);
      return {
        kind: parked ? 'STEP · PARKED' : 'STEP', uniqueName: entityName(s.name, s.version, s.id), title: 'Step',
        head: [{ label: 'Name', value: text(s.name) }, { label: 'Version', value: text(s.version) }],
        details: details(s.id, s.audit),
        fields: [
          { label: 'Description', value: text(s.description) },
          { label: 'Entry condition', value: `${condition.letter} · ${condition.name}`, dot: condition.colour },
          { label: 'Processor', value: p ? entityName(p.name, p.version, p.id) : `${text(s.processorId)} (not loaded)` },
        ],
        note: parked ? '⚠ Parked: not connected, so not part of this workflow.' : undefined,
      };
    }
    case 'processor': {
      const p = graph.processors.get(selection.processorId);
      if (!p) return null;
      return {
        kind: 'PROCESSOR', uniqueName: entityName(p.name, p.version, p.id), title: 'Processor',
        head: [{ label: 'Name', value: text(p.name) }, { label: 'Version', value: text(p.version) }],
        details: details(p.id, p.audit),
        fields: [
          { label: 'Description', value: text(p.description) },
          { label: 'Source hash', value: text(p.sourceHash) },
          { label: 'Instance id', value: text(p.instanceId) },
        ],
        slots: [schemaSlot(graph, 'In', p.inputSchemaId), schemaSlot(graph, 'Out', p.outputSchemaId), schemaSlot(graph, 'Config', p.configSchemaId)],
      };
    }
    case 'cache': {
      const c = graph.caches.get(selection.cacheId);
      if (!c) return null;
      return {
        kind: 'CACHE', uniqueName: entityName(c.name, c.version, c.id), title: 'Cache',
        head: [{ label: 'Name', value: text(c.name) }, { label: 'Version', value: text(c.version) }],
        details: details(c.id, c.audit),
        fields: [
          { label: 'Description', value: text(c.description) },
          { label: 'Root', value: text(c.root) },
          { label: 'Items', value: text(c.items) },
        ],
      };
    }
  }
}
