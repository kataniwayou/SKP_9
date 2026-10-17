import type { ProjectData } from '../api/project';
import type { Vec } from '../molecule/layout';
import { atomKey, type ArrowKind, type AtomType } from '../molecule/model';

/**
 * An atom made from the Toolbox (the user, 2026-10-17: approved toolbox), virtual like an edit or a delete (decision 8):
 * its row as a create would send it, with a client id BaseApi's dry run maps to the id it assigns, and where it sits.
 */
export interface CreatedAtom { key: string; type: AtomType; id: string; row: Record<string, unknown>; pos: Vec }

/** An arrow drawn from the Toolbox between two atoms (tail first, then head): its key, `kind|from|to`. */
export type AddedArrow = string;

const LIST: Readonly<Record<AtomType, keyof ProjectData>> = { wf: 'workflows', step: 'steps', proc: 'processors', schema: 'schemas', asg: 'assignments', cache: 'caches' };

/** The arrows the Toolbox can draw: the deletable ones (spec §6b), each with the kinds at its tail and head. */
export const DRAWABLE: Readonly<Partial<Record<ArrowKind, { tail: AtomType; head: AtomType; field: string; list: boolean }>>> = {
  entry: { tail: 'wf', head: 'step', field: 'entryStepIds', list: true },
  next: { tail: 'step', head: 'step', field: 'nextStepIds', list: true },
  wfAsg: { tail: 'wf', head: 'asg', field: 'assignmentIds', list: true },
  wfCache: { tail: 'wf', head: 'cache', field: 'cacheIds', list: true },
  input: { tail: 'proc', head: 'schema', field: 'inputSchemaId', list: false },
  output: { tail: 'proc', head: 'schema', field: 'outputSchemaId', list: false },
  config: { tail: 'proc', head: 'schema', field: 'configSchemaId', list: false },
};

/** The atom kinds the Toolbox makes, and the kind of atom each must be dropped on (its mandatory arrow), or null. */
export const MAKES: Readonly<Record<AtomType, { on: AtomType | null }>> = {
  schema: { on: null }, cache: { on: null }, proc: { on: null }, step: { on: 'proc' }, asg: { on: 'step' }, wf: { on: 'step' },
};

const base = () => ({ name: '', version: '1.0.0', description: null });

/** A new atom's row: required text left empty where BaseApi has no default, its mandatory arrow to `onId`. */
export function defaultRow(type: AtomType, onId: string | null): Record<string, unknown> {
  switch (type) {
    case 'schema': return { ...base(), definition: '{"type":"object"}' };
    case 'cache': return { ...base(), root: '', items: '{}' };
    case 'proc': return { ...base(), sourceHash: '', instanceId: null, inputSchemaId: null, outputSchemaId: null, configSchemaId: null };
    case 'step': return { ...base(), processorId: onId, nextStepIds: [], entryCondition: 1 };
    case 'asg': return { ...base(), stepId: onId, payload: '{}' };
    case 'wf': return { ...base(), entryStepIds: [onId], assignmentIds: [], cacheIds: [], cronExpression: null };
  }
}

export function newCreated(type: AtomType, onId: string | null, pos: Vec, id: string = globalThis.crypto.randomUUID(), values: Readonly<Record<string, unknown>> = {}): CreatedAtom {
  return { key: atomKey(type, id), type, id, row: { id, ...defaultRow(type, onId), ...values }, pos };
}

/** The fields that are arrows (copy/paste leaves them: a paste gets only its mandatory arrow, from where it lands). */
const LINK_FIELDS = new Set(['processorId', 'nextStepIds', 'stepId', 'entryStepIds', 'assignmentIds', 'cacheIds', 'inputSchemaId', 'outputSchemaId', 'configSchemaId']);
/** Unique in the database (uq_cache_root, uq_processor_source_hash): an exact copy is always refused, so it pastes empty. */
export const PASTED_EMPTY = new Set(['root', 'sourceHash']);
/** The field keys a copy carries (the user, 2026-10-17): the atom's own values, not its arrows, not the unique ones. */
export const copiedField = (field: string) => field !== 'id' && !LINK_FIELDS.has(field) && !PASTED_EMPTY.has(field);

/** An atom copied (Ctrl+C), to paste as a new one: its own values, and a made atom's typed texts. */
export interface Copied { type: AtomType; name: string; values: Readonly<Record<string, unknown>>; texts: Readonly<Record<string, string>> }

/** The copy of a row: every own field of the kind's row, as the source has it. */
export function copyOf(type: AtomType, name: string, row: Readonly<Record<string, unknown>>, texts: Readonly<Record<string, string>> = {}): Copied {
  const values: Record<string, unknown> = {};
  for (const f of Object.keys(defaultRow(type, null))) if (copiedField(f) && f in row) values[f] = row[f];
  return { type, name, values, texts: Object.fromEntries(Object.entries(texts).filter(([f]) => copiedField(f))) };
}

const idOf = (key: string) => key.slice(key.indexOf(':') + 1);

/**
 * The project as Valence shows it: BaseApi's rows, the created atoms' rows, and each drawn arrow written into its tail's
 * row (the row that holds it). Deletions and edits stay apart (they are judged against this), so this is the base the
 * molecule, the Inspector, the rules and the planner all read.
 */
export function virtualData(data: ProjectData, created: readonly CreatedAtom[], added: readonly AddedArrow[]): ProjectData {
  const out = Object.fromEntries(Object.entries(data).map(([k, rows]) => [k, (rows as Record<string, unknown>[]).map((r) => ({ ...r }))])) as unknown as ProjectData;
  for (const c of created) (out[LIST[c.type]] as unknown as Record<string, unknown>[]).push({ ...c.row });
  for (const key of added) {
    const [kind, from, to] = key.split('|') as [ArrowKind, string, string];
    const d = DRAWABLE[kind];
    if (!d) continue;
    const row = (out[LIST[d.tail]] as unknown as Record<string, unknown>[]).find((r) => r.id === idOf(from));
    if (!row) continue;
    if (d.list) { const ids = Array.isArray(row[d.field]) ? (row[d.field] as string[]) : []; if (!ids.includes(idOf(to))) row[d.field] = [...ids, idOf(to)]; }
    else row[d.field] = idOf(to);
  }
  return out;
}
