import type { StudioApi } from '../api/client';
import { describeError } from '../api/describeError';
import type { EntityReadDto } from '../api/entities';
import type { AssignmentReadDto, SchemaReadDto } from '../api/types';
import { newId } from '../design/ids';
import { applyBlocks, type NewAssignment } from '../design/blocks';
import type { Id } from '../model/graph';
import { fieldValue, type FieldSpec } from '../store/entityForms';
import { graphBaseOf } from '../store/inspectorBase';
import { crumbLabel, targetKey, type InspectorTarget } from '../store/inspectorTarget';
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
  /** Drops the shown entity's design edits. */
  revert(workflowId: Id): void;
  /** Creates the step's assignment in the design (`{step}-assignment`, 1.0.0, `{}`) and shows it. */
  createAssignment(workflowId: Id, stepId: Id, stepName: string): void;
  /** Removes the step's assignment in the design: no question, no other workflow checked (assignments are not shared). */
  removeAssignment(workflowId: Id, stepId: Id): void;
}

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
    return { id: '', name: `${p?.name ?? target.processorId}-${target.slot}`, version: '1.0.0', description: null, definition: '{}' } as SchemaReadDto;
  }
  return null;
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

export function createInspectorService(api: StudioApi, store: StudioStore): InspectorService {
  /** workflowId → the target key whose GET is in flight. */
  const reading = new Map<Id, string>();
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
    const virtual = madeUp(doc, target);
    if (virtual !== null) {
      store.dispatch({ type: 'read', workflowId, key, gen, result: { ok: true, dto: virtual } });
      return;
    }
    const pasted = pastedAssignment(doc, target);
    if (pasted !== null && target.kind === 'assignment') {
      // its name, version and description are its original's until Save: read from that row when it is a real one
      if (pasted.copyOf === null) {
        store.dispatch({ type: 'read', workflowId, key, gen, result: { ok: true, dto: pastedDto(pasted, target.stepId, null) } });
        return;
      }
      reading.set(workflowId, reads);
      void api.getEntity('assignment', pasted.copyOf).then((r) => {
        if (reading.get(workflowId) === reads) reading.delete(workflowId);
        store.dispatch({ type: 'read', workflowId, key, gen, result: { ok: true, dto: pastedDto(pasted, target.stepId, r.ok ? r.value : null) } });
      });
      return;
    }
    reading.set(workflowId, reads);
    void api.getEntity(target.kind, target.id).then((r) => {
      if (reading.get(workflowId) === reads) reading.delete(workflowId);
      store.dispatch({
        type: 'read', workflowId, key, gen,
        result: r.ok ? { ok: true, dto: r.value }
          : { ok: false, message: r.error.kind === 'notFound' ? `This ${crumbLabel(target).toLowerCase()} no longer exists.` : `Could not read it. ${describeError(r.error)}` },
      });
    });
  }

  return {
    read,
    edit: (workflowId, spec, text) => store.dispatch({ type: 'editField', workflowId, key: spec.key, value: fieldValue(spec, text), copyId: newId() }),
    revert: (workflowId) => store.dispatch({ type: 'revertEntity', workflowId }),
    createAssignment: (workflowId, stepId, stepName) => store.dispatch({ type: 'createAssignment', workflowId, stepId, stepName, id: newId() }),
    removeAssignment: (workflowId, stepId) => store.dispatch({ type: 'removeAssignment', workflowId, stepId }),
  };
}
