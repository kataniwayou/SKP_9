import type { EntityKind } from '../api/entities';
import type { EditTarget } from '../design/design';
import type { Id } from '../model/graph';
import type { Selection } from './selection';

export type SchemaSlot = 'input' | 'output' | 'config';

/**
 * What the Inspector shows (spec §7.1): an entity it reads and edits in the design (plan 8). The
 * selection gives the first one; drill-downs (step → processor → schema, step → assignment) add the
 * rest, as a trail.
 */
export type InspectorTarget =
  | { kind: 'workflow'; id: Id }
  | { kind: 'step'; id: Id }
  | { kind: 'processor'; id: Id }
  /** `id` is the slot's schema in the database ('' when the slot is empty); the design's copy is found by processor and slot (plan 8). */
  | { kind: 'schema'; id: Id; slot: SchemaSlot; processorId: Id }
  | { kind: 'assignment'; id: Id; stepId: Id }
  | { kind: 'cache'; id: Id };

/** The selection as a target; existence is the server's answer (a GET that 404s). */
export function rootTarget(selection: Selection | null, workflowId: Id): InspectorTarget | null {
  if (selection === null) return null;
  switch (selection.kind) {
    case 'workflow': return { kind: 'workflow', id: workflowId };
    case 'step': return { kind: 'step', id: selection.stepId };
    case 'processor': return { kind: 'processor', id: selection.processorId };
    case 'cache': return { kind: 'cache', id: selection.cacheId };
  }
}

/** The entity shown: the trail's last drill-down, else the selection itself. */
export function currentTarget(root: InspectorTarget, trail: readonly InspectorTarget[]): InspectorTarget {
  return trail.at(-1) ?? root;
}

export function targetKey(target: InspectorTarget | null): string {
  if (target === null) return 'none';
  return target.kind === 'schema' ? `schema:${target.processorId}:${target.slot}` : `${target.kind}:${target.id}`;
}

/** The entity kind a target reads. */
export const entityKindOf = (target: InspectorTarget): EntityKind => target.kind;

const SLOT_LABEL: Record<SchemaSlot, string> = { input: 'Input', output: 'Output', config: 'Config' };

/** The breadcrumb's word for a target (spec §7.1: "Step › Processor › Config schema"). */
export function crumbLabel(target: InspectorTarget): string {
  switch (target.kind) {
    case 'workflow': return 'Workflow';
    case 'step': return 'Step';
    case 'processor': return 'Processor';
    case 'schema': return `${SLOT_LABEL[target.slot]} schema`;
    case 'assignment': return 'Assignment';
    case 'cache': return 'Cache';
  }
}

/** A well-formed target: a restored draft's trail is checked with it. */
export function isTarget(value: unknown): value is InspectorTarget {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const id = (key: string) => typeof v[key] === 'string' && v[key] !== '';
  switch (v.kind) {
    case 'workflow': case 'step': case 'processor': case 'cache': return id('id');
    case 'schema': return typeof v.id === 'string' && id('processorId') && (v.slot === 'input' || v.slot === 'output' || v.slot === 'config');
    case 'assignment': return id('id') && id('stepId');
    default: return false;
  }
}

/** The design entity a target edits (plan 8): a schema by its processor's slot, an assignment by its step. */
export function editTargetOf(target: InspectorTarget): EditTarget {
  switch (target.kind) {
    case 'workflow': return { kind: 'workflow' };
    case 'schema': return { kind: 'schema', processorId: target.processorId, slot: target.slot };
    case 'assignment': return { kind: 'assignment', id: target.id, stepId: target.stepId };
    default: return { kind: target.kind, id: target.id };
  }
}
