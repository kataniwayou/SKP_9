import type { ApiError, StudioApi } from '../api/client';
import { describeError } from '../api/describeError';
import type { AssignmentReadDto } from '../api/types';
import type { Id } from '../model/graph';
import { createAssignmentDto, newAssignmentDto, splitErrors, updateDto } from '../store/entityForms';
import type { SaveFailure } from '../store/inspector';
import { crumbLabel, entityKindOf, targetKey, type InspectorTarget } from '../store/inspectorTarget';
import { shownTargetOf } from '../store/studioState';
import type { StudioStore } from '../store/studioStore';

/** The Inspector's I/O (spec §7.1). Every answer goes into the store; nothing here throws. */
export interface InspectorService {
  /** GETs the entity a document's Inspector shows, unless it is read or being read; `again` re-reads it in place. */
  read(workflowId: Id, again?: boolean): void;
  /** Saves the shown entity's edits: a fresh GET, then a PUT of that DTO with only the edits. True when nothing is left unsaved. */
  save(workflowId: Id): Promise<boolean>;
  /** Creates the assignment the new-assignment form describes, then links it to the workflow. */
  create(workflowId: Id): Promise<boolean>;
  /** Unlinks the shown assignment from this workflow; the assignment itself is kept. */
  unlink(workflowId: Id): Promise<boolean>;
}

/** What a failed write shows (spec §7.1, §8): a 400 under its fields, everything else in the banner. */
export function failureOf(target: InspectorTarget, error: ApiError): SaveFailure {
  switch (error.kind) {
    case 'badRequest': {
      const { fields, other } = splitErrors(entityKindOf(target), error.errors);
      if (other.length > 0) return { fields, banner: `Not saved: ${other.join(' ')}` };
      return { fields, banner: Object.keys(fields).length === 0 ? `Not saved: ${error.detail}` : null };
    }
    case 'notFound': return { fields: {}, banner: `Not saved: this ${crumbLabel(target).toLowerCase()} no longer exists.` };
    case 'network': return { fields: {}, banner: 'Not saved: BaseApi unreachable' };
    default: return { fields: {}, banner: `Not saved: ${error.detail}` };
  }
}

/** `afterWrite` runs after every successful write: the page re-reads every open document (spec §7.1). */
export function createInspectorService(api: StudioApi, store: StudioStore, afterWrite: () => void): InspectorService {
  /** workflowId → the target key whose GET is in flight. */
  const reading = new Map<Id, string>();
  const docOf = (id: Id) => store.getState().docs.find((d) => d.workflowId === id) ?? null;
  const shown = (id: Id) => {
    const doc = docOf(id);
    return doc === null ? null : shownTargetOf(doc);
  };
  const fail = (workflowId: Id, failure: SaveFailure): false => {
    store.dispatch({ type: 'saveFailed', workflowId, failure });
    return false;
  };

  function read(workflowId: Id, again = false): void {
    const doc = docOf(workflowId);
    const target = shown(workflowId);
    if (doc === null || target === null) return;
    const key = targetKey(target);
    if (!again && (doc.inspector.saved?.key === key || reading.get(workflowId) === key)) return;
    if (target.kind === 'newAssignment') {
      store.dispatch({ type: 'read', workflowId, key, result: { ok: true, dto: newAssignmentDto({ id: target.stepId, name: target.stepName }) } });
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

  async function save(workflowId: Id): Promise<boolean> {
    const doc = docOf(workflowId);
    const target = shown(workflowId);
    if (doc === null || target === null || Object.keys(doc.inspector.edits).length === 0) return true;
    if (target.kind === 'newAssignment') return create(workflowId);
    const sent = doc.inspector.edits;
    store.dispatch({ type: 'busy', workflowId, busy: true });
    // built from a GET made now: structural fields go back exactly as the server holds them (review focus 3)
    const fresh = await api.getEntity(target.kind, target.id);
    if (!fresh.ok) return fail(workflowId, failureOf(target, fresh.error));
    const put = await api.putEntity(target.kind, target.id, updateDto(target.kind, fresh.value, sent));
    if (!put.ok) return fail(workflowId, failureOf(target, put.error));
    store.dispatch({ type: 'saved', workflowId, key: targetKey(target), sent, dto: put.value });
    afterWrite();
    return true;
  }

  /** Re-reads the workflow and PUTs it back with its assignment ids changed; null when done, else why not. */
  async function relink(workflowId: Id, change: (ids: string[]) => string[]): Promise<string | null> {
    const workflow = await api.getEntity('workflow', workflowId);
    if (!workflow.ok) return describeError(workflow.error);
    const body = { ...updateDto('workflow', workflow.value, {}), assignmentIds: change(workflow.value.assignmentIds ?? []) };
    const put = await api.putEntity('workflow', workflowId, body);
    return put.ok ? null : describeError(put.error);
  }

  async function create(workflowId: Id): Promise<boolean> {
    const doc = docOf(workflowId);
    const target = shown(workflowId);
    if (doc === null || target?.kind !== 'newAssignment' || doc.inspector.saved === null) return false;
    store.dispatch({ type: 'busy', workflowId, busy: true });
    const made = await api.createAssignment(createAssignmentDto(doc.inspector.saved.dto as AssignmentReadDto, doc.inspector.edits));
    if (!made.ok) return fail(workflowId, failureOf(target, made.error));
    const id = made.value.id ?? '';
    store.dispatch({ type: 'created', workflowId, target: { kind: 'assignment', id, stepId: target.stepId }, dto: made.value });
    const why = await relink(workflowId, (ids) => [...ids, id]);
    afterWrite();
    return why === null ? true : fail(workflowId, { fields: {}, banner: `Created but not linked to this workflow: ${why}` });
  }

  async function unlink(workflowId: Id): Promise<boolean> {
    const doc = docOf(workflowId);
    const target = shown(workflowId);
    if (doc === null || target?.kind !== 'assignment') return false;
    store.dispatch({ type: 'busy', workflowId, busy: true });
    const why = await relink(workflowId, (ids) => ids.filter((x) => x !== target.id));
    if (why !== null) return fail(workflowId, { fields: {}, banner: `Not unlinked: ${why}` });
    store.dispatch({ type: 'back', workflowId, depth: doc.inspector.trail.length - 1 });
    afterWrite();
    return true;
  }

  return { read, save, create, unlink };
}
