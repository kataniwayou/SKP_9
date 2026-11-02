import type { StudioApi } from '../api/client';
import { describeError } from '../api/describeError';
import type { EntityReadDto } from '../api/entities';
import type { AssignmentReadDto, SchemaReadDto } from '../api/types';
import { newId } from '../design/ids';
import { applyBlocks, type NewAssignment } from '../design/blocks';
import { slotKey } from '../design/design';
import { payloadSkeleton } from '../model/assignments';
import type { Id } from '../model/graph';
import { fieldValue, type FieldSpec } from '../store/entityForms';
import { graphBaseOf } from '../store/inspectorBase';
import { crumbLabel, targetKey, type InspectorTarget, type SchemaSlot } from '../store/inspectorTarget';
import { shownDesignOf } from '../store/problems';
import { shownTargetOf, type OpenDocument } from '../store/studioState';
import type { StudioStore } from '../store/studioStore';

/**
 * The Inspector's reads and edits (plan 8 §3.3). Reads are GETs of the shown entity's base; every edit goes
 * to the design in the store. Nothing here writes to BaseApi: Save does (app/saveDesign.ts).
 */
export interface InspectorService {
  /** Reads the base of the entity a document's Inspector shows, unless it is read or being read; `again` reads it anew. */
  read(workflowId: Id, again?: boolean): void;
  /** One field typed into the shown entity: a design edit. */
  edit(workflowId: Id, spec: FieldSpec, text: string): void;
  /** Leaves a processor's slot with no schema in the design (2026-11-01). */
  clearSlot(workflowId: Id, processorId: Id, slot: SchemaSlot): void;
  /** Drops the shown entity's design edits. */
  revert(workflowId: Id): void;
  /**
   * Creates the step's assignment in the design (`{step}-assignment`, 1.0.0) and shows it, its payload laid out from
   * the config schema of the step's processor (2026-11-02; `{}` without one). Resolves once it is made.
   */
  createAssignment(workflowId: Id, stepId: Id, stepName: string): Promise<void>;
  /** Removes the step's assignment in the design: no question, no other workflow checked (assignments are not shared). */
  removeAssignment(workflowId: Id, stepId: Id): void;
  /** The definition of the config schema the step's processor has in the design (the payload's live check, 2026-11-02); null: none. */
  configDefinition(workflowId: Id, stepId: Id): Promise<string | null>;
}

/** An empty slot's new schema starts as every schema BaseApi holds is laid out (the user, 2026-11-02): an object, no fields yet. */
export const NEW_SCHEMA_DEFINITION = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', required: [], properties: {}, additionalProperties: false,
}, null, 2);

/** A base for what the database does not hold yet (spec §3.2): a created assignment, an empty slot's schema. */
function madeUp(doc: OpenDocument, target: InspectorTarget): EntityReadDto | null {
  // a new workflow (2026-10-10) BaseApi does not have yet: its own graph is all there is to read
  if (target.kind === 'workflow' && doc.virtual && doc.status.kind === 'ready') {
    const w = doc.status.doc.graph.workflow;
    return {
      id: w.id, name: w.name, version: w.version, description: w.description, cronExpression: w.cronExpression,
      entryStepIds: w.entryStepIds, assignmentIds: w.assignmentIds, cacheIds: w.cacheIds, updatedAt: w.updatedAt,
    } as unknown as EntityReadDto;
  }
  if (target.kind === 'assignment') {
    const op = doc.edits.assignments[target.stepId];
    if (op?.op === 'create' && op.id === target.id) {
      return { id: op.id, name: '', version: '', description: null, stepId: target.stepId, payload: '' } as AssignmentReadDto;
    }
  }
  // a step or cache the design made (pasted, or from the Toolbox, 2026-10-20): BaseApi has no row to read until Save, and the
  // graph carries every field its form shows
  const blocks = doc.design.draft.blocks;
  if (doc.status.kind === 'ready' && ((target.kind === 'step' && Object.hasOwn(blocks.steps, target.id)) || (target.kind === 'cache' && Object.hasOwn(blocks.caches, target.id)))) {
    const base = graphBaseOf(applyBlocks(doc.status.doc, blocks).graph, target);
    if (base !== null) return base.values as unknown as EntityReadDto;
  }
  if (target.kind === 'schema' && target.id === '' && doc.status.kind === 'ready') {
    const p = applyBlocks(doc.status.doc, doc.design.draft.blocks).graph.processors.get(target.processorId);
    return { id: '', name: `${p?.name ?? target.processorId}-${target.slot}`, version: '1.0.0', description: null, definition: NEW_SCHEMA_DEFINITION } as SchemaReadDto;
  }
  return null;
}

/**
 * The definition of the config schema the step's processor has in the design: the slot's copy when the design made one,
 * else BaseApi's row; null when the step has no processor, the processor no config schema, or the row cannot be read.
 */
async function configDefinitionOf(api: StudioApi, doc: OpenDocument, stepId: Id): Promise<string | null> {
  const graph = shownDesignOf(doc)?.graph;
  const processorId = graph?.steps.get(stepId)?.processorId ?? null;
  const schemaId = processorId === null ? null : graph?.processors.get(processorId)?.configSchemaId ?? null;
  if (processorId === null || schemaId === null) return null;
  const copy = doc.edits.schemas[slotKey(processorId, 'config')];
  if (copy?.id === schemaId) return copy.definition;
  const r = await api.getEntity('schema', schemaId);
  return r.ok ? ((r.value as SchemaReadDto).definition ?? null) : null;
}

/** A pasted step's own assignment (2026-10-10), when the target is one: a new row that exists only in the design. */
function pastedAssignment(doc: OpenDocument, target: InspectorTarget): NewAssignment | null {
  if (target.kind !== 'assignment') return null;
  const a = doc.design.draft.blocks.steps[target.stepId]?.assignment;
  return a && a.id === target.id ? a : null;
}

/** A pasted assignment's base: the fields it was copied with over its original's read (when it copies a real row). */
function pastedDto(a: NewAssignment, stepId: Id, original: EntityReadDto | null): EntityReadDto {
  const f = a.fields;
  const text = (k: string, was: string) => (typeof f[k] === 'string' ? (f[k] as string) : was);
  const o = (original ?? {}) as Partial<AssignmentReadDto>;
  return {
    ...o, id: a.id, stepId, name: text('name', o.name ?? ''), version: text('version', o.version ?? ''),
    description: Object.hasOwn(f, 'description') ? (f.description === null ? null : String(f.description)) : (o.description ?? null),
    payload: text('payload', o.payload ?? '{}'),
  } as AssignmentReadDto;
}

/** What the Inspector's read of an entity comes to: its base DTO, or the message it shows instead. */
export type BaseDto = { ok: true; dto: EntityReadDto } | { ok: false; message: string };

/**
 * The base of one entity as the Inspector reads it: what the design made up, a pasted assignment over its original's
 * row, else BaseApi's row (2026-10-23: one path for the Inspector and the chat's read_entity).
 */
export async function baseDtoOf(api: StudioApi, doc: OpenDocument, target: InspectorTarget): Promise<BaseDto> {
  const virtual = madeUp(doc, target);
  if (virtual !== null) return { ok: true, dto: virtual };
  const pasted = pastedAssignment(doc, target);
  if (pasted !== null && target.kind === 'assignment') {
    // its name, version and description are its original's until Save: read from that row when it is a real one
    if (pasted.copyOf === null) return { ok: true, dto: pastedDto(pasted, target.stepId, null) };
    const r = await api.getEntity('assignment', pasted.copyOf);
    return { ok: true, dto: pastedDto(pasted, target.stepId, r.ok ? r.value : null) };
  }
  const r = await api.getEntity(target.kind, target.id);
  return r.ok ? { ok: true, dto: r.value }
    : { ok: false, message: r.error.kind === 'notFound' ? `This ${crumbLabel(target).toLowerCase()} no longer exists.` : `Could not read it. ${describeError(r.error)}` };
}

export function createInspectorService(api: StudioApi, store: StudioStore): InspectorService {
  /** workflowId → the target key whose GET is in flight. */
  const reading = new Map<Id, string>();
  /** `${workflowId}|${stepId}` of the assignments whose config schema is being read: a second click makes no second one. */
  const creating = new Set<string>();
  const docOf = (id: Id) => store.getState().docs.find((d) => d.workflowId === id) ?? null;

  function read(workflowId: Id, again = false): void {
    const doc = docOf(workflowId);
    const target = doc === null ? null : shownTargetOf(doc);
    if (doc === null || target === null) return;
    const key = targetKey(target);
    const gen = doc.generation;
    // read once per entity and document generation: a Save's re-read makes a new one, so the shown entity is read again
    const current = doc.inspector.saved?.key === key && (doc.inspector.saved.gen ?? gen) >= gen;
    const reads = `${gen}|${key}`;
    if (!again && (current || reading.get(workflowId) === reads)) return;
    reading.set(workflowId, reads);
    void baseDtoOf(api, doc, target).then((result) => {
      if (reading.get(workflowId) === reads) reading.delete(workflowId);
      store.dispatch({ type: 'read', workflowId, key, gen, result });
    });
  }

  return {
    read,
    edit: (workflowId, spec, text) => store.dispatch({ type: 'editField', workflowId, key: spec.key, value: fieldValue(spec, text), copyId: newId() }),
    clearSlot: (workflowId, processorId, slot) => store.dispatch({ type: 'clearSlot', workflowId, processorId, slot }),
    revert: (workflowId) => store.dispatch({ type: 'revertEntity', workflowId }),
    async createAssignment(workflowId, stepId, stepName) {
      const doc = docOf(workflowId);
      const key = `${workflowId}|${stepId}`;
      if (doc === null || creating.has(key)) return;
      creating.add(key);
      try {
        const payload = payloadSkeleton(await configDefinitionOf(api, doc, stepId));
        store.dispatch({ type: 'createAssignment', workflowId, stepId, stepName, id: newId(), payload });
      } finally {
        creating.delete(key);
      }
    },
    removeAssignment: (workflowId, stepId) => store.dispatch({ type: 'removeAssignment', workflowId, stepId }),
    async configDefinition(workflowId, stepId) {
      const doc = docOf(workflowId);
      return doc === null ? null : configDefinitionOf(api, doc, stepId);
    },
  };
}
