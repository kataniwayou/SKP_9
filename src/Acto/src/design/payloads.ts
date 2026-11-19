import { payloadSkeleton } from '../model/assignments';
import type { Id } from '../model/graph';
import type { AssignmentRow, BoardState } from './board';
import { NO_AUDIT } from './board';

/** All the assignments a workflow links, in its assignmentIds order. */
export function assignmentsOf(b: BoardState, wf: Id): AssignmentRow[] {
  const w = b.workflows[wf];
  if (!w) return [];
  return w.assignmentIds.map((id) => b.assignments[id]).filter((a): a is AssignmentRow => !!a);
}

/** The first of the workflow's assignments for that step. */
export function assignmentOf(b: BoardState, wf: Id, stepId: Id): AssignmentRow | null {
  return assignmentsOf(b, wf).find((a) => a.stepId === stepId) ?? null;
}

/** The step's processor's config schema definition (null: no processor, no config schema, or not read). */
export function configDefinitionOf(b: BoardState, stepId: Id): string | null {
  const pid = b.steps[stepId]?.processorId;
  const sid = pid ? b.processors[pid]?.configSchemaId : null;
  return sid ? b.schemas[sid]?.definition ?? null : null;
}

/**
 * A new assignment's payload as Studio's ＋ Create lays it out [user, 2026-11-19]: from the step's processor's config
 * schema (payloadSkeleton: a required key as a "<type>" marker, an optional one as its default or empty value); `{}`
 * without one. The Inspector's ＋ Create and the chat's set_payload without a payload both use it.
 */
export const newPayloadOf = (b: BoardState, stepId: Id): string => payloadSkeleton(configDefinitionOf(b, stepId));

/** The workflows that link this assignment row. */
export function linkedBy(b: BoardState, assignmentId: Id): Id[] {
  return Object.values(b.workflows).filter((w) => w.assignmentIds.includes(assignmentId)).map((w) => w.id);
}

/**
 * Sets the workflow's payload for a step. In place when only this workflow links the row; a row another
 * workflow links is copied for this one (copy-on-write); no row yet makes one.
 */
export function setPayload(b: BoardState, wf: Id, stepId: Id, payload: string, newId: () => Id): BoardState {
  const w = b.workflows[wf];
  if (!w) return b;
  const cur = assignmentOf(b, wf, stepId);
  if (cur && linkedBy(b, cur.id).every((x) => x === wf)) {
    if (cur.payload === payload) return b;
    return { ...b, assignments: { ...b.assignments, [cur.id]: { ...cur, payload } } };
  }
  const id = newId();
  const row: AssignmentRow = cur
    ? { ...cur, id, payload, updatedAt: null, ...NO_AUDIT }
    : {
      id, stepId, name: `${b.steps[stepId]?.name ?? stepId}-assignment`, version: '1.0.0', description: null,
      payload, updatedAt: null, ...NO_AUDIT,
    };
  const assignmentIds = cur ? w.assignmentIds.map((x) => (x === cur.id ? id : x)) : [...w.assignmentIds, id];
  return {
    ...b,
    assignments: { ...b.assignments, [id]: row },
    workflows: { ...b.workflows, [wf]: { ...w, assignmentIds } },
  };
}

/** Unlinks the assignment from the workflow; the row goes only when no workflow links it any more. */
export function removeAssignment(b: BoardState, wf: Id, assignmentId: Id): BoardState {
  const w = b.workflows[wf];
  if (!w || !w.assignmentIds.includes(assignmentId)) return b;
  const workflows = { ...b.workflows, [wf]: { ...w, assignmentIds: w.assignmentIds.filter((x) => x !== assignmentId) } };
  const next = { ...b, workflows };
  if (linkedBy(next, assignmentId).length > 0) return next;
  const assignments = { ...b.assignments };
  delete assignments[assignmentId];
  return { ...next, assignments };
}

/**
 * Sets the payload of one assignment the workflow links, by its row id. Same copy-on-write rule as setPayload: a row
 * another workflow also links is copied for this workflow only (the copy takes the row's place in its list).
 */
export function setAssignmentPayload(b: BoardState, wf: Id, assignmentId: Id, payload: string, newId: () => Id): BoardState {
  const w = b.workflows[wf];
  const cur = b.assignments[assignmentId];
  if (!w || !cur || !w.assignmentIds.includes(assignmentId)) return b;
  if (linkedBy(b, assignmentId).every((x) => x === wf)) {
    if (cur.payload === payload) return b;
    return { ...b, assignments: { ...b.assignments, [assignmentId]: { ...cur, payload } } };
  }
  const id = newId();
  return {
    ...b,
    assignments: { ...b.assignments, [id]: { ...cur, id, payload, updatedAt: null, ...NO_AUDIT } },
    workflows: { ...b.workflows, [wf]: { ...w, assignmentIds: w.assignmentIds.map((x) => (x === assignmentId ? id : x)) } },
  };
}

/**
 * Sets the name, version or description of one assignment the workflow links, by its row id. Same copy-on-write rule
 * as setAssignmentPayload: a row another workflow also links is copied for this workflow only.
 */
export function setAssignmentField(
  b: BoardState, wf: Id, assignmentId: Id, key: 'name' | 'version' | 'description', value: string | null, newId: () => Id,
): BoardState {
  const w = b.workflows[wf];
  const cur = b.assignments[assignmentId];
  if (!w || !cur || !w.assignmentIds.includes(assignmentId)) return b;
  if (linkedBy(b, assignmentId).every((x) => x === wf)) {
    if (cur[key] === value) return b;
    return { ...b, assignments: { ...b.assignments, [assignmentId]: { ...cur, [key]: value } } };
  }
  const id = newId();
  return {
    ...b,
    assignments: { ...b.assignments, [id]: { ...cur, id, [key]: value, updatedAt: null, ...NO_AUDIT } },
    workflows: { ...b.workflows, [wf]: { ...w, assignmentIds: w.assignmentIds.map((x) => (x === assignmentId ? id : x)) } },
  };
}
