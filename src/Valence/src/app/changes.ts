import { goneArrows } from '../molecule/deletion';
import { rowOf, savedText } from '../molecule/fields';
import { arrowKey, reachOf, TYPES, type Arrow, type ArrowKind, type AtomType } from '../molecule/model';
import { planChanges, type PlannedChange } from '../molecule/plan';
import type { WorkspaceState } from './workspace';

/** One changed atom in the apply's confirmation, in the canvas's terms: green new, amber updated, red deleted. */
export interface ChangeRow {
  key: string;
  type: AtomType;
  name: string;
  mode: 'new' | 'updated' | 'deleted';
  /** What changes, in a few words: its arrows, its edited fields (before → after), what goes with it. */
  what: string[];
  /** The workflows it affects, by name; empty: none yet (a new processor with no step). */
  affects: string[];
}

export interface ApplySummary {
  /** The changes BaseApi takes, in its order (the dry run's plan). */
  planned: PlannedChange[];
  /** One row per changed atom: new, then updated, then deleted. */
  rows: ChangeRow[];
  /** Every workflow a change affects, by name. */
  affects: string[];
}

/** An arrow named from its tail: what it makes of its head. */
const OUT: Readonly<Partial<Record<ArrowKind, string>>> = {
  uses: 'on', asg: 'on', entry: 'entry', next: 'next', wfAsg: 'assignment', wfCache: 'cache', input: 'input schema', output: 'output schema', config: 'config schema',
};
/** An arrow named from its head: what its tail makes of it. */
const IN: Readonly<Partial<Record<ArrowKind, string>>> = {
  uses: 'used by', asg: 'assigned to', entry: 'entry of', next: 'next of', wfAsg: 'assignment of', wfCache: 'cache of', input: 'input schema of', output: 'output schema of', config: 'config schema of',
};
/** A value short enough to show as before → after. */
const SHORT = 32;
const shown = (text: string) => (text.length <= SHORT && !text.includes('\n') ? text : null);

/**
 * The apply's confirmation (approved 2026-10-17): every virtual change as BaseApi takes it, and per changed atom what
 * changes and which workflows it affects. A workflow is affected by an atom it reaches (its steps, their processors and
 * schemas, its assignments and caches), on the virtual molecule — made atoms and drawn arrows included, deleted ones
 * still there; an assignment no workflow lists affects its step's workflows; a workflow affects itself.
 */
export function summarize(s: Pick<WorkspaceState, 'data' | 'molecule' | 'base' | 'edits' | 'removed' | 'created' | 'added' | 'rules'>): ApplySummary | null {
  const { data, molecule, edits, removed, created, added, rules } = s;
  if (!data || !molecule) return null;
  const createdKeys = new Set(created.map((c) => c.key));
  const planned = planChanges(data, molecule, edits, removed, rules.fields, createdKeys, added);
  const gone = goneArrows(molecule, removed);
  const deleted = new Set(removed.atoms);
  const nameOf = (key: string) => edits[key]?.name || molecule.atoms.get(key)?.name || key;
  const phrase = (x: Arrow, from: boolean) => from ? `${OUT[x.kind] ?? x.kind} ${nameOf(x.to)}` : `${IN[x.kind] ?? x.kind} ${nameOf(x.from)}`;

  // each workflow's reach, once
  const reach = [...molecule.atoms.values()].filter((a) => a.type === 'wf').map((w) => ({ name: nameOf(w.key), keys: reachOf(molecule, w.key) }));
  const affectsOf = (key: string): string[] => {
    const hit = reach.filter((w) => w.keys.has(key)).map((w) => w.name);
    if (hit.length || molecule.atoms.get(key)?.type !== 'asg') return hit;
    const step = molecule.arrows.find((x) => x.from === key && x.kind === 'asg')?.to;
    return step ? reach.filter((w) => w.keys.has(step)).map((w) => w.name) : [];
  };

  const rows: ChangeRow[] = [];
  for (const key of [...new Set(planned.map((c) => c.atom))]) {
    const atom = molecule.atoms.get(key);
    if (!atom) continue;
    const mode: ChangeRow['mode'] = createdKeys.has(key) ? 'new' : deleted.has(key) ? 'deleted' : 'updated';
    const what: string[] = [];
    if (mode === 'new') {
      what.push('made in Valence');
      molecule.arrows.filter((x) => x.from === key && !gone.has(arrowKey(x))).forEach((x) => what.push(phrase(x, true)));
      molecule.arrows.filter((x) => x.to === key && !gone.has(arrowKey(x)) && !createdKeys.has(x.from)).forEach((x) => what.push(phrase(x, false)));
    } else if (mode === 'updated') {
      const row = s.base ? rowOf(s.base.data, atom.type, atom.id) : undefined;
      for (const [field, text] of Object.entries(edits[key] ?? {})) {
        const spec = rules.table[atom.type].find((f) => f.key === field);
        const label = spec?.label ?? field;
        const before = row && spec ? savedText(row, spec) : null;
        const a = before === null ? null : shown(before), b = shown(text);
        what.push(a !== null && b !== null ? `${label} ${a || '∅'} → ${b || '∅'}` : `${label} edited`);
      }
      for (const k of added) {
        const [, tail] = k.split('|');
        const x = molecule.arrows.find((y) => arrowKey(y) === k);
        if (tail === key && x && !gone.has(k)) what.push(`arrow drawn: ${phrase(x, true)}`);
      }
      molecule.arrows.filter((x) => x.from === key && gone.has(arrowKey(x))).forEach((x) => {
        what.push(deleted.has(x.to) ? `${phrase(x, true)} cleared (deleted)` : `arrow deleted: ${phrase(x, true)}`);
      });
    } else {
      const along = molecule.arrows.filter((x) => x.to === key && !deleted.has(x.from)).map((x) => phrase(x, false));
      if (along.length) what.push(`goes with: ${along.join('; ')}`);
      if (atom.type === 'step' && molecule.arrows.some((x) => x.from === key && x.kind === 'next')) what.push('its next-step rows go first');
      if (!what.length) what.push('deleted');
    }
    rows.push({ key, type: atom.type, name: nameOf(key), mode, what, affects: affectsOf(key) });
  }
  const order = { new: 0, updated: 1, deleted: 2 } as const;
  rows.sort((a, b) => order[a.mode] - order[b.mode]);
  const affects = [...new Set(rows.flatMap((r) => r.affects))].sort((a, b) => a.localeCompare(b));
  return { planned, rows, affects };
}

/** The Output pane's line for an applied set. */
export function appliedLine(rows: readonly ChangeRow[]): string {
  const n = (m: ChangeRow['mode']) => rows.filter((r) => r.mode === m).length;
  const parts = [[n('new'), 'created'], [n('updated'), 'updated'], [n('deleted'), 'deleted']].filter(([c]) => c).map(([c, w]) => `${c} ${w}`);
  return `Applied ${rows.length} change${rows.length === 1 ? '' : 's'} to BaseApi (${parts.join(', ')}).`;
}

export const typeLabel = (t: AtomType) => TYPES[t].label.toLowerCase();
