import type { ModelFields } from '../api/fields';
import type { ProjectData } from '../api/project';
import { goneArrows, type Removed } from './deletion';
import { rowOf } from './fields';
import { arrowKey, atomKey, TYPES, type ArrowKind, type AtomType, type Molecule } from './model';

/** One change as BaseApi's dry run (and later the apply) takes it: the body a PUT would send, or a DELETE. */
export interface PlannedChange {
  op: 'create' | 'update' | 'delete';
  table: string;
  id: string;
  row?: Record<string, unknown>;
  /** The atom the change belongs to, for showing BaseApi's answer on it. */
  atom: string;
  /** Why this change is in the plan, for the Output pane. */
  why: string;
}

/** The update DTO's link fields, as the arrows model.ts draws from them (spec §5). */
const LINKS: Readonly<Record<string, ArrowKind>> = {
  inputSchemaId: 'input', outputSchemaId: 'output', configSchemaId: 'config', processorId: 'uses', stepId: 'asg',
  nextStepIds: 'next', entryStepIds: 'entry', assignmentIds: 'wfAsg', cacheIds: 'wfCache',
};

/** Creates in this order: what a new row points at is created before it. */
const CREATE_ORDER: readonly AtomType[] = ['schema', 'cache', 'proc', 'step', 'asg', 'wf'];
/** Updates in this order: a processor's cleared slot lands before its schema's new definition (spec §7 freeze). */
const UPDATE_ORDER: readonly AtomType[] = ['wf', 'step', 'asg', 'proc', 'cache', 'schema'];
/** Deletes in this order: what points at a row goes before it (workflows' link rows cascade). */
const DELETE_ORDER: readonly AtomType[] = ['wf', 'asg', 'step', 'proc', 'cache', 'schema'];

/** An editor's text as the field's JSON value: empty is null where null is allowed; numbers and enums as numbers. */
function valueOf(text: string, type: string, nullable: boolean): unknown {
  if (text === '' && nullable) return null;
  if (type === 'enum' || type === 'integer' || type === 'number') return Number(text);
  if (type === 'boolean') return text === 'true';
  return text;
}

/**
 * The virtual state as the changes BaseApi would apply (atoms made from the Toolbox first, as creates) (decision 8: nothing is applied yet), in an order its rules
 * accept: every surviving row whose fields were edited or whose arrows were deleted is one update — the whole body a
 * PUT sends, built from the row BaseApi returned, the edits and the arrows still there — then every deleted row is a
 * delete, after the rows pointing at it (a deleted step first drops its own next-step rows, a RESTRICT key).
 */
export function planChanges(data: ProjectData, molecule: Molecule, edits: Readonly<Record<string, Readonly<Record<string, string>>>>, removed: Removed, fields: ModelFields,
  created: ReadonlySet<string> = new Set(), added: readonly string[] = []): PlannedChange[] {
  const gone = goneArrows(molecule, removed);
  const deleted = new Set(removed.atoms);
  const entityOf = (type: AtomType) => fields.entities.find((e) => e.table === TYPES[type].table);

  /** The PUT body of an atom: its row, its edits (none for a deleted one), and its arrows minus the gone ones. */
  function body(key: string, clearLinks: readonly string[] = []): Record<string, unknown> | null {
    const atom = molecule.atoms.get(key)!;
    const row = rowOf(data, atom.type, atom.id);
    const entity = entityOf(atom.type);
    if (!row || !entity) return null;
    const out: Record<string, unknown> = {};
    for (const f of entity.fields) {
      const kind = LINKS[f.field];
      const edited = deleted.has(key) ? undefined : edits[key]?.[f.field];
      if (kind && f.type.endsWith('[]')) {
        const kept = molecule.arrows.filter((x) => x.from === key && x.kind === kind && !gone.has(arrowKey(x))).map((x) => molecule.atoms.get(x.to)!.id);
        out[f.field] = clearLinks.includes(f.field) ? [] : kept;
      } else if (kind) {
        const x = molecule.arrows.find((a) => a.from === key && a.kind === kind);
        out[f.field] = !x || gone.has(arrowKey(x)) ? null : molecule.atoms.get(x.to)!.id;
      } else if (edited !== undefined) {
        out[f.field] = valueOf(edited, f.type, f.nullable);
      } else {
        out[f.field] = row[f.field] ?? null;
      }
    }
    return out;
  }

  const changes: PlannedChange[] = [];
  // atoms made from the Toolbox: a create each, its row as typed, with its arrows (the mandatory one and any drawn).
  // A new step's next steps that are new too would name rows not created yet (a foreign key BaseApi refuses, found by
  // the browser suite 2026-10-17): it is created without them, and an update after every create adds them.
  const madeIds = new Set([...molecule.atoms.values()].filter((a) => created.has(a.key) && !deleted.has(a.key)).map((a) => a.id));
  const later: PlannedChange[] = [];
  for (const type of CREATE_ORDER) {
    for (const atom of molecule.atoms.values()) {
      if (atom.type !== type || !created.has(atom.key) || deleted.has(atom.key)) continue;
      const row = body(atom.key);
      if (!row) continue;
      const next = Array.isArray(row.nextStepIds) ? (row.nextStepIds as string[]) : [];
      if (type === 'step' && next.some((id) => madeIds.has(id))) {
        changes.push({ op: 'create', table: TYPES[type].table, id: atom.id, row: { ...row, nextStepIds: next.filter((id) => !madeIds.has(id)) }, atom: atom.key, why: `${atom.name}: made in Valence` });
        later.push({ op: 'update', table: TYPES[type].table, id: atom.id, row, atom: atom.key, why: `${atom.name}: its next steps made in Valence, once they exist` });
      } else {
        changes.push({ op: 'create', table: TYPES[type].table, id: atom.id, row, atom: atom.key, why: `${atom.name}: made in Valence` });
      }
    }
  }
  changes.push(...later);
  for (const type of UPDATE_ORDER) {
    for (const atom of molecule.atoms.values()) {
      if (atom.type !== type || deleted.has(atom.key) || created.has(atom.key)) continue;
      const editedFields = Object.keys(edits[atom.key] ?? {});
      const lostArrows = molecule.arrows.filter((x) => x.from === atom.key && gone.has(arrowKey(x))).length;
      const drawn = added.filter((k) => k.split('|')[1] === atom.key && !gone.has(k)).length;
      if (editedFields.length === 0 && lostArrows === 0 && drawn === 0) continue;
      const row = body(atom.key);
      if (!row) continue;
      const why = [editedFields.length ? `edits ${editedFields.join(', ')}` : '', lostArrows ? `${lostArrows} arrow${lostArrows === 1 ? '' : 's'} deleted` : '',
        drawn ? `${drawn} arrow${drawn === 1 ? '' : 's'} drawn` : ''].filter(Boolean).join('; ');
      changes.push({ op: 'update', table: TYPES[type].table, id: atom.id, row, atom: atom.key, why: `${atom.name}: ${why}` });
    }
  }
  for (const type of DELETE_ORDER) {
    for (const key of removed.atoms) {
      const atom = molecule.atoms.get(key);
      if (!atom || atom.type !== type) continue;
      // a step's own next-step rows hold a RESTRICT key to it: they go first, by an update of the step
      if (type === 'step' && molecule.arrows.some((x) => x.from === key && x.kind === 'next')) {
        const row = body(key, ['nextStepIds']);
        if (row) changes.push({ op: 'update', table: TYPES[type].table, id: atom.id, row, atom: key, why: `${atom.name}: its next-step rows go before it` });
      }
      changes.push({ op: 'delete', table: TYPES[type].table, id: atom.id, atom: key, why: `${atom.name}: deleted` });
    }
  }
  return changes;
}

/** The atom a change's table and id stand for. */
export function atomOfChange(table: string, id: string): string | null {
  const type = (Object.keys(TYPES) as AtomType[]).find((t) => TYPES[t].table === table);
  return type ? atomKey(type, id) : null;
}
