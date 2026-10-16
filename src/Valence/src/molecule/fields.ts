import type { ProjectData } from '../api/project';
import { KINDS, TYPES, type ArrowKind, type AtomType, type Molecule } from './model';

/** How a writable field is edited. */
export type FieldKind = 'text' | 'multiline' | 'json' | 'condition';

/**
 * A writable, non-arrow field of an entity (spec §3c, the user's list of 2026-10-15). `check` is BaseApi's own rule for
 * it (BaseDtoValidator and the entities' validators), so a problem shows while typing; BaseApi stays the judge on apply.
 */
export interface FieldSpec {
  /** The read DTO's property. */
  key: string;
  label: string;
  kind: FieldKind;
  /** Empty text means null. */
  nullable?: boolean;
  /** Why it cannot be edited yet; absent: it can. */
  readOnly?: string;
  check(text: string): string | null;
}

const MB = 1_048_576;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const required = (label: string, max: number) => (t: string) =>
  t.trim() === '' ? `${label} is required` : t.length > max ? `${label} is at most ${max} characters` : null;
const jsonProblem = (t: string): string | null => { try { JSON.parse(t); return null; } catch (e) { return `Not valid JSON: ${(e as Error).message}`; } };

/** The entry conditions BaseApi accepts (0, PreviousProcessing, is refused by both step validators). */
export const CONDITIONS: readonly { value: number; label: string }[] = [
  { value: 1, label: 'PreviousCompleted' }, { value: 2, label: 'PreviousFailed' }, { value: 3, label: 'PreviousCancelled' },
  { value: 4, label: 'Always' }, { value: 5, label: 'Never' },
];

const COMMON: readonly FieldSpec[] = [
  { key: 'name', label: 'Name', kind: 'text', check: required('Name', 200) },
  { key: 'version', label: 'Version', kind: 'text', check: (t) => (t.trim() === '' ? 'Version is required' : VERSION.test(t) ? null : 'Version is x.y.z, e.g. 1.0.0') },
  { key: 'description', label: 'Description', kind: 'multiline', nullable: true, check: (t) => (t.length > 2000 ? 'Description is at most 2000 characters' : null) },
];

/** Every kind's writable fields that are not arrows, in the Inspector's order. */
export const FIELDS: Readonly<Record<AtomType, readonly FieldSpec[]>> = {
  wf: [...COMMON, {
    key: 'cronExpression', label: 'Cron', kind: 'text', nullable: true,
    check: (t) => { const n = t.trim() === '' ? 0 : t.trim().split(/\s+/).length; return n === 0 || n === 5 || n === 6 ? null : 'A cron has 5 or 6 fields'; },
  }],
  step: [...COMMON, {
    key: 'entryCondition', label: 'Entry condition', kind: 'condition',
    check: (t) => (CONDITIONS.some((c) => String(c.value) === t) ? null : 'Pick an entry condition'),
  }],
  proc: [...COMMON,
    { key: 'sourceHash', label: 'Source hash', kind: 'text', check: (t) => (/^[a-f0-9]{64}$/.test(t) ? null : 'A source hash is 64 lowercase hex characters') },
    { key: 'instanceId', label: 'Instance id', kind: 'text', nullable: true, check: (t) => (t.length > 200 ? 'Instance id is at most 200 characters' : null) },
  ],
  schema: [...COMMON, { key: 'definition', label: 'Definition', kind: 'json', readOnly: 'Read-only for now', check: () => null }],
  asg: [...COMMON, {
    key: 'payload', label: 'Payload', kind: 'json',
    check: (t) => (t.trim() === '' ? 'Payload is required' : t.length > MB ? 'Payload is at most 1 MB' : jsonProblem(t)),
  }],
  cache: [...COMMON,
    { key: 'root', label: 'Root', kind: 'text', check: (t) => required('Root', 200)(t) ?? (t.includes(':') ? 'Root cannot contain ":"' : null) },
    {
      key: 'items', label: 'Items', kind: 'json',
      check: (t) => {
        if (t.length > MB) return 'Items are at most 1 MB';
        let v: unknown;
        try { v = JSON.parse(t); } catch (e) { return `Not valid JSON: ${(e as Error).message}`; }
        if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'Items are a JSON object';
        for (const [k, x] of Object.entries(v)) {
          if (k === '' || k.includes(':')) return `Key "${k}": keys are non-empty and without ":"`;
          if (typeof x !== 'string') return `Key "${k}": values are strings`;
        }
        return null;
      },
    },
  ],
};

const LIST: Readonly<Record<AtomType, keyof ProjectData>> = { wf: 'workflows', step: 'steps', proc: 'processors', schema: 'schemas', asg: 'assignments', cache: 'caches' };

/** The row an atom stands for, as BaseApi returned it. */
export function rowOf(data: ProjectData, type: AtomType, id: string): Record<string, unknown> | undefined {
  return (data[LIST[type]] as unknown as Record<string, unknown>[]).find((r) => r.id === id);
}

/** A field's stored value as the text its editor holds: null is empty, JSON is pretty-printed. */
export function savedText(row: Record<string, unknown>, spec: FieldSpec): string {
  const v = row[spec.key];
  if (v === null || v === undefined) return '';
  if (spec.kind === 'json' && typeof v === 'string') { try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; } }
  return String(v);
}

/** The read-only details of an atom (spec §3c): table, id, audit, and what points at it. */
export function detailRows(molecule: Molecule, row: Record<string, unknown>, atomKey: string): { label: string; value: string }[] {
  const atom = molecule.atoms.get(atomKey)!;
  const when = (at: unknown, by: unknown) => `${typeof at === 'string' && at ? at.replace('T', ' ').replace(/\.\d+Z?$|Z$/, '') : '—'} · ${typeof by === 'string' && by ? by : '—'}`;
  const pointed = molecule.arrows.filter((x) => x.to === atomKey)
    .map((x) => `${molecule.atoms.get(x.from)!.name} (${KINDS[x.kind].where.replace(/^(a row in|the column) /, '')})`);
  return [
    { label: 'Table', value: TYPES[atom.type].table },
    { label: 'Id', value: atom.id },
    { label: 'Created', value: when(row.createdAt, row.createdBy) },
    { label: 'Updated', value: when(row.updatedAt, row.updatedBy) },
    { label: 'Pointed at by', value: pointed.length ? `${pointed.length}: ${pointed.join(', ')}` : 'nothing' },
  ];
}

/** An outgoing arrow's name, as the atom it leaves calls it. */
const ARROW_LABEL: Readonly<Record<ArrowKind, string>> = {
  entry: 'entry step', wfAsg: 'assignment', wfCache: 'cache', next: 'next step', uses: 'processor', asg: 'step', input: 'input', output: 'output', config: 'config',
};

/** The arrows that leave an atom (its arrow fields, read-only in the Inspector), each `label → target name`. */
export function arrowRows(molecule: Molecule, atomKey: string): { label: string; target: string }[] {
  return molecule.arrows.filter((x) => x.from === atomKey).map((x) => ({ label: ARROW_LABEL[x.kind], target: molecule.atoms.get(x.to)!.name }));
}
