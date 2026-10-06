import type { Assignment, Id } from './graph';

/**
 * At most one assignment applies per (workflow, step) (spec §2). Legacy data can hold more; the
 * graph saver keeps the smallest id, so the studio shows that one. Postgres orders uuids by their
 * bytes, which is the order of their lower-case hex text.
 */
export function assignmentByStep(assignments: Assignment[]): Map<Id, Assignment> {
  const byStep = new Map<Id, Assignment>();
  for (const a of assignments) {
    const current = byStep.get(a.stepId);
    if (!current || a.id.toLowerCase() < current.id.toLowerCase()) byStep.set(a.stepId, a);
  }
  return byStep;
}

/** The number of top-level keys in an object payload, or null when it is not a JSON object. */
export function payloadKeyCount(payload: string): number | null {
  try {
    const value: unknown = JSON.parse(payload);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).length : null;
  } catch {
    return null;
  }
}
