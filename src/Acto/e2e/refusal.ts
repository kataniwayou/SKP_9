import { isE2e, type Row } from './stack';

/** The write guard's verdict on one /model change (pure: the fixtures route and the unit tests both use it). */

const isEmptyMap = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0;
const norm = (v: unknown) => (v === undefined || v === '' || isEmptyMap(v) ? null : Array.isArray(v) ? [...v].sort() : v);
const sameValue = (a: unknown, b: unknown) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

const sortKeys = (v: unknown): unknown => Array.isArray(v) ? v.map(sortKeys)
  : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])) : v;

/** A schema definition equal to another: as JSON with sorted keys; a string that is not JSON must be byte-identical. */
export function sameDefinition(a: unknown, b: unknown): boolean {
  const parse = (v: unknown): { json: true; value: unknown } | { json: false } => {
    if (typeof v !== 'string') return { json: true, value: sortKeys(v) };
    try { return { json: true, value: sortKeys(JSON.parse(v)) }; } catch { return { json: false }; }
  };
  const pa = parse(a), pb = parse(b);
  if (pa.json && pb.json) return JSON.stringify(pa.value) === JSON.stringify(pb.value);
  return a === b;
}

const TABLES_OK = ['workflows', 'steps', 'caches', 'assignments', 'schemas', 'processors'];

/** Why a /model change must not go out, or null. */
export function refusal(c: { op?: string; table?: string; id?: string; row?: Record<string, unknown> }, real: Map<string, Row>): string | null {
  if (!TABLES_OK.includes(c.table ?? '')) return `a ${c.table} change (only workflows, steps, caches, assignments, schemas and processors may be written)`;
  if (c.table === 'processors' && (c.op === 'create' || c.op === 'delete')) return `${c.op} of a processor (Acto never creates or deletes one)`;
  const was = real.get(c.id ?? '');
  if (c.op === 'create') return isE2e(c.row?.name) ? null : `create of "${String(c.row?.name)}": a throwaway must be named e2e-...`;
  if (!was) return null; // a row the run made
  if (c.op === 'delete') return `delete of the real ${c.table} row ${was.name}`;
  for (const [k, v] of Object.entries(c.row ?? {})) {
    if (k === 'boardX' || k === 'boardY') continue;
    if (c.table === 'schemas' && k === 'definition') {
      if (!sameDefinition(was[k], v)) return `update of the real schemas row ${was.name}: definition would change`;
      continue;
    }
    if (!sameValue(was[k], v)) return `update of the real ${c.table} row ${was.name}: ${k} would change (${JSON.stringify(was[k])} -> ${JSON.stringify(v)})`;
  }
  return null;
}
