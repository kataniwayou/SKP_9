import { SNAPSHOT, type ModelField, type ModelFields, type ModelRule, type RulesSource } from '../api/fields';
import { definitionLock, type FieldKind, type FieldSpec } from './fields';
import { schemaProblem } from './jsonSchema';
import { TYPES, type AtomType } from './model';

/** Every kind's writable fields that are not arrows, in the order BaseApi's update DTO lists them. */
export type FieldTable = Readonly<Record<AtomType, readonly FieldSpec[]>>;

/**
 * Stand-ins for BaseApi's `code` rules (a `Must` or `Custom` written as code, which a description cannot carry), so an
 * edit is checked while typing. They run only where BaseApi says a code rule exists, and BaseApi's own message is shown
 * when the rule has one. They stay on while BaseApi's dry run answers too (the user, 2026-10-18: "turn on the local checks
 * everywhere"), so a bad cron, payload or items is marked at once, not half a second later by the dry run alone; BaseApi
 * stays the judge on apply. Keyed `table.field`.
 */
const CODE_STANDINS: Readonly<Record<string, (text: string) => string | null>> = {
  'schemas.definition': (t) => {
    let v: unknown;
    try { v = JSON.parse(t); } catch (e) { return `Not valid JSON: ${(e as Error).message}`; }
    const p = schemaProblem(v);
    return p ? `Not a valid JSON Schema (draft 2020-12) — ${p}` : null;
  },
  'assignments.payload': (t) => { try { JSON.parse(t); return null; } catch (e) { return `Not valid JSON: ${(e as Error).message}`; } },
  'caches.root': (t) => (t.trim() === '' ? 'Root must not be empty.' : t.includes(':') ? "Root must not contain ':'." : null),
  'caches.items': (t) => {
    let v: unknown;
    try { v = JSON.parse(t); } catch (e) { return `Not valid JSON: ${(e as Error).message}`; }
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'Items must be a JSON object.';
    for (const [k, x] of Object.entries(v)) {
      if (k === '') return 'Items must not contain an empty key.';
      if (k.includes(':')) return `Items key '${k}' must not contain ':'.`;
      if (typeof x !== 'string') return `Items value for key '${k}' must be a string.`;
    }
    return null;
  },
  'workflows.cronExpression': (t) => { const n = t.trim().split(/\s+/).length; return n === 5 || n === 6 ? null : 'A cron has 5 or 6 fields'; },
};

/** Rules BaseApi cannot describe because they live in its services; Valence judges them on the virtual entities. */
const LOCKS: Readonly<Record<string, FieldSpec['lock']>> = { 'schemas.definition': definitionLock };

/** `sourceHash` → "Source hash". */
export const labelOf = (field: string) => {
  const words = field.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** A link field is an arrow (spec §5), edited on the canvas, not in the field list. */
const isArrow = (f: ModelField) => f.type === 'guid' || f.type.endsWith('[]');

function kindOf(f: ModelField): FieldKind {
  if (f.storeType === 'jsonb') return 'json';
  if (f.type === 'enum') return 'choice';
  const max = f.rules.find((r) => r.kind === 'maxLength');
  return max && Number(max.value) >= 1000 ? 'multiline' : 'text';
}

/** One rule as a check of the editor's text; null when it passes or cannot apply to text. */
function ruleCheck(table: string, f: ModelField, label: string, rule: ModelRule): ((text: string) => string | null) | null {
  const own = rule.message;
  switch (rule.kind) {
    case 'required':
    case 'notNull':
      return (t) => (t.trim() === '' ? own ?? `${label} is required` : null);
    case 'maxLength': {
      const n = Number(rule.value);
      return (t) => (t.length > n ? own ?? `${label} is at most ${n} characters` : null);
    }
    case 'minLength': {
      const n = Number(rule.value);
      return (t) => (t !== '' && t.length < n ? own ?? `${label} is at least ${n} characters` : null);
    }
    case 'pattern': {
      let re: RegExp;
      try { re = new RegExp(rule.value ?? ''); } catch { return null; } // a .NET-only pattern: BaseApi checks it on apply
      return (t) => (t !== '' && !re.test(t) ? own ?? `${label} does not match ${rule.value}` : null);
    }
    case 'enum': {
      const values = new Set((f.values ?? []).map((v) => String(v.value)));
      return (t) => (values.has(t) ? null : own ?? `${label} is not one of its values`);
    }
    case 'notEqual':
      return (t) => (t === rule.value ? own ?? `${label} must not be ${rule.value}` : null);
    case 'equal':
      return (t) => (t !== rule.value ? own ?? `${label} must be ${rule.value}` : null);
    case 'code': {
      const standin = CODE_STANDINS[`${table}.${f.field}`];
      if (!standin) return null;
      return (t) => { const p = standin(t); return p === null ? null : own ?? p; };
    }
    default:
      return null;
  }
}

/** A field's spec, its checks built from BaseApi's rules in the order they run (the first failure is shown). */
function specOf(table: string, f: ModelField): FieldSpec {
  const label = labelOf(f.field);
  const checks = f.rules.map((r) => ({ r, check: ruleCheck(table, f, label, r) })).filter((x) => x.check !== null);
  const refused = new Set(f.rules.filter((r) => r.kind === 'notEqual').map((r) => r.value));
  return {
    key: f.field,
    label,
    kind: kindOf(f),
    nullable: f.nullable || undefined,
    lock: LOCKS[`${table}.${f.field}`],
    options: f.type === 'enum' ? (f.values ?? []).filter((v) => !refused.has(String(v.value))).map((v) => ({ value: String(v.value), label: v.name })) : undefined,
    check(text) {
      // an empty nullable field is null, which every length, pattern and conditional rule lets through (FluentValidation)
      const empty = text === '' && f.nullable;
      for (const { r, check } of checks) {
        if (empty && r.kind !== 'required' && r.kind !== 'notNull') continue;
        if (r.conditional && text.trim() === '') continue;
        const p = check!(text);
        if (p) return p;
      }
      return null;
    },
  };
}

/** Every kind's writable non-arrow fields, from BaseApi's description of its update DTOs (`GET /model/fields`). */
export function fieldTable(fields: ModelFields): FieldTable {
  const out = {} as Record<AtomType, FieldSpec[]>;
  for (const type of Object.keys(TYPES) as AtomType[]) {
    const entity = fields.entities.find((e) => e.table === TYPES[type].table);
    out[type] = entity ? entity.fields.filter((f) => !isArrow(f)).map((f) => specOf(entity.table, f)) : [];
  }
  return out;
}

/** The rules in use: the description, where it came from, and its field table (the code rules' stand-ins included). */
export interface Rules { from: RulesSource['from']; etag: string; note: string; fields: ModelFields; table: FieldTable }

export const rulesOf = (source: RulesSource): Rules => ({
  from: source.from, etag: source.fields.etag, note: source.note, fields: source.fields,
  table: fieldTable(source.fields),
});

/** Before BaseApi answers: the bundled snapshot. */
export const SNAPSHOT_RULES: Rules = rulesOf({ from: 'snapshot', fields: SNAPSHOT, note: 'Rules: the bundled snapshot of GET /model/fields (BaseApi not read yet).' });
