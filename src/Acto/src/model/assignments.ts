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

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A property's JSON Schema type: its `type`, the first one other than null when it names several; null when it names none. */
function typeOf(prop: Record<string, unknown>): string | null {
  const t = prop.type;
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) return (t.find((x) => typeof x === 'string' && x !== 'null') as string | undefined) ?? null;
  return null;
}

const EMPTY: Readonly<Record<string, () => unknown>> = { string: () => '', number: () => 0, integer: () => 0, boolean: () => false, object: () => ({}), array: () => [] };

/**
 * A new assignment's payload laid out from its processor's config schema (the user, 2026-11-02): every top-level
 * property on its own line, a required one as a marker naming its type ("<string>") to be filled in, an optional
 * one as its schema default or its type's empty value. `{}` when the schema is absent, does not parse or has no properties.
 */
export function payloadSkeleton(definition: string | null | undefined): string {
  let schema: unknown;
  try {
    schema = JSON.parse(definition ?? '');
  } catch {
    return '{}';
  }
  if (!isObject(schema) || !isObject(schema.properties)) return '{}';
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : []);
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(schema.properties)) {
    const prop = isObject(raw) ? raw : {};
    const type = typeOf(prop);
    if (required.has(key)) out[key] = `<${type ?? 'value'}>`;
    else if (Object.hasOwn(prop, 'default')) out[key] = prop.default;
    else out[key] = type !== null && Object.hasOwn(EMPTY, type) ? EMPTY[type]!() : null;
  }
  return Object.keys(out).length === 0 ? '{}' : JSON.stringify(out, null, 2);
}
