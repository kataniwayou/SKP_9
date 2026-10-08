import type { StudioApi } from '../api/client';
import { describeError } from '../api/describeError';
import type { EntityReadDto } from '../api/entities';
import type { AssignmentReadDto, SchemaReadDto } from '../api/types';
import { newId } from '../design/ids';
import type { Id } from '../model/graph';
import { fieldValue, type FieldSpec } from '../store/entityForms';
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
  if (target.kind === 'assignment') {
    const op = doc.edits.assignments[target.stepId];
    if (op?.op === 'create' && op.id === target.id) {
      return { id: op.id, name: '', version: '', description: null, stepId: target.stepId, payload: '' } as AssignmentReadDto;
    }
  }
  if (target.kind === 'schema' && target.id === '' && doc.status.kind === 'ready') {
    const p = doc.status.doc.graph.processors.get(target.processorId);
    return { id: '', name: `${p?.name ?? target.processorId}-${target.slot}`, version: '1.0.0', description: null, definition: '{}' } as SchemaReadDto;
  }
  return null;
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
    if (!again && (doc.inspector.saved?.key === key || reading.get(workflowId) === key)) return;
    const virtual = madeUp(doc, target);
    if (virtual !== null) {
      store.dispatch({ type: 'read', workflowId, key, result: { ok: true, dto: virtual } });
      return;
    }
    reading.set(workflowId, key);
    void api.getEntity(target.kind, target.id).then((r) => {
      if (reading.get(workflowId) === key) reading.delete(workflowId);
      store.dispatch({
        type: 'read', workflowId, key,
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
