import type { ProjectData } from '../api/project';
import { goneArrows, NOTHING_REMOVED, type Removed } from './deletion';
import { arrowKey, KINDS, TYPES, type ArrowKind, type AtomType, type Molecule } from './model';
import type { FieldTable } from './rules';

/** How a writable field is edited. */
export type FieldKind = 'text' | 'multiline' | 'json' | 'choice';

/**
 * A writable, non-arrow field of an entity (spec §3c), built from BaseApi's description of its update DTO
 * (`GET /model/fields`, `rules.fieldTable`): `check` runs BaseApi's own rules for it, so a problem shows while typing;
 * BaseApi stays the judge on apply.
 */
export interface FieldSpec {
  /** The read DTO's property. */
  key: string;
  label: string;
  kind: FieldKind;
  /** Empty text means null. */
  nullable?: boolean;
  /** A choice's values (an enum's, without those its rules refuse). */
  options?: readonly { value: string; label: string }[];
  /** A rule that can lock it, judged on the virtual entities; absent: it is always open. */
  lock?(molecule: Molecule, removed: Removed, atomKey: string): Lock;
  check(text: string): string | null;
}

/** Whether a rule locks a field now, and the line the Inspector shows under it either way. */
export interface Lock { locked: boolean; note: string }

/** The processor slots that hold a schema: while any of them points at it, its definition is frozen. */
const SCHEMA_SLOTS: ReadonlySet<ArrowKind> = new Set(['input', 'output', 'config']);

/**
 * BaseApi's freeze (`SchemaService.UpdateAsync`: a changed definition → 409 while any processor's input, output or
 * config slot points at the schema), judged on the virtual entities (the user, 2026-10-16: "build the rule-driven
 * unlock"): once every such arrow is deleted in Valence the definition opens, and an undo that brings one back closes it.
 */
export function definitionLock(molecule: Molecule, removed: Removed, key: string): Lock {
  const gone = goneArrows(molecule, removed);
  const holding = molecule.arrows.filter((x) => x.to === key && SCHEMA_SLOTS.has(x.kind) && !gone.has(arrowKey(x)));
  if (holding.length === 0) {
    return { locked: false, note: 'Open: no processor uses this schema in Valence. On apply, the processors\' slots clear before the definition is sent.' };
  }
  const users = holding.map((x) => `${molecule.atoms.get(x.from)?.name ?? x.from} (${x.kind})`).join(', ');
  return {
    locked: true,
    note: `Frozen: used by ${users}. BaseApi refuses a changed definition while any processor uses the schema — delete ${holding.length === 1 ? 'that arrow' : 'those arrows'}, or make a new schema version and re-point the processor.`,
  };
}

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
export function arrowRows(molecule: Molecule, atomKey: string): { label: string; target: string; key: string }[] {
  return molecule.arrows.filter((x) => x.from === atomKey)
    .map((x) => ({ label: ARROW_LABEL[x.kind], target: molecule.atoms.get(x.to)!.name, key: arrowKey(x) }));
}

/**
 * The atoms made from the Toolbox, split like edits (2026-10-17): finished once every field, as typed or as made, passes
 * its rule (and BaseApi's dry run did not refuse it); until then unfinished — still drawn, as a create needs no edit to
 * exist, but without its halo, and apply waits.
 */
export function createdStates(fieldTable: FieldTable, data: ProjectData, molecule: Molecule, edits: Readonly<Record<string, Readonly<Record<string, string>>>>,
  created: ReadonlySet<string>, refused: ReadonlySet<string> = new Set()): { finished: Set<string>; unfinished: Set<string> } {
  const finished = new Set<string>(), unfinished = new Set<string>();
  for (const key of created) {
    const atom = molecule.atoms.get(key);
    const row = atom ? rowOf(data, atom.type, atom.id) : undefined;
    if (!atom || !row) continue;
    const broken = refused.has(key) || fieldTable[atom.type].some((spec) => spec.check(edits[key]?.[spec.key] ?? savedText(row, spec)) !== null);
    (broken ? unfinished : finished).add(key);
  }
  return { finished, unfinished };
}

/**
 * The edited atoms, split by whether their edits are finished (the user, 2026-10-16): an edit counts as a change — drawn
 * as an update ghost — only when every edited field passes its rule; one breaking a rule is unfinished, marked in the
 * Inspector and drawn as nothing, and blocks apply until it is fixed or reverted. An edit to a field a rule has locked
 * again (a schema whose processor arrow came back) is unfinished too, and also listed in `frozen`: BaseApi would refuse it.
 * So is an atom whose change BaseApi's dry run refused (`refused`): the dry run runs every rule, code ones included.
 */
export function editStates(fieldTable: FieldTable, molecule: Molecule, edits: Readonly<Record<string, Readonly<Record<string, string>>>>, removed: Removed = NOTHING_REMOVED,
  refused: ReadonlySet<string> = new Set()): { finished: Set<string>; unfinished: Set<string>; frozen: Set<string> } {
  const finished = new Set<string>(), unfinished = new Set<string>(), frozen = new Set<string>();
  for (const [key, fields] of Object.entries(edits)) {
    const atom = molecule.atoms.get(key);
    if (!atom || Object.keys(fields).length === 0) continue;
    const specs = Object.keys(fields).map((f) => fieldTable[atom.type].find((s) => s.key === f));
    const locked = specs.some((s) => s?.lock?.(molecule, removed, key).locked);
    const broken = locked || refused.has(key) || Object.entries(fields).some(([field, text]) => fieldTable[atom.type].find((s) => s.key === field)?.check(text) != null);
    (broken ? unfinished : finished).add(key);
    if (locked) frozen.add(key);
  }
  return { finished, unfinished, frozen };
}
