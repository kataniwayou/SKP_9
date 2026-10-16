import { arrowKey, KINDS, TYPES, type Arrow, type ArrowKind, type Molecule } from './model';

/**
 * The deletion rules (spec §6), judged on the virtual entities (decision 8) so that every virtual state is one the
 * database can hold and the apply step can never fail on a RESTRICT.
 *
 * Rule #1, relaxed (the user, 2026-10-16): an atom can be deleted when every arrow pointing at it is a deletable one —
 * those arrows go with it, as do the arrows leaving it. Two arrows can only be re-pointed (a NOT NULL key column), so
 * either one pointing at an atom keeps it; and a workflow keeps at least one entry step (`EntryStepIds` ≥ 1).
 */

/** What is deleted in Valence and not applied: atoms, and arrows deleted on their own. */
export interface Removed { atoms: readonly string[]; arrows: readonly string[] }
export const NOTHING_REMOVED: Removed = { atoms: [], arrows: [] };

/** The arrows that can only be re-pointed: a NOT NULL key column (spec §6b). */
export const REQUIRED: ReadonlySet<ArrowKind> = new Set(['uses', 'asg']);

/** Every arrow that is gone: deleted on its own, or touching a deleted atom (its tail's row or its target is gone). */
export function goneArrows(molecule: Molecule, removed: Removed): Set<string> {
  const atoms = new Set(removed.atoms);
  const gone = new Set(removed.arrows);
  for (const x of molecule.arrows) if (atoms.has(x.from) || atoms.has(x.to)) gone.add(arrowKey(x));
  return gone;
}

export type Verdict =
  | { ok: true; /** the arrows pointing at an atom that go with it */ taking: Arrow[] }
  | { ok: false; reason: string };

const nameOf = (molecule: Molecule, key: string) => molecule.atoms.get(key)?.name ?? key;
const describe = (molecule: Molecule, x: Arrow) => `${nameOf(molecule, x.from)} → ${nameOf(molecule, x.to)} (${KINDS[x.kind].label})`;

/** Whether the workflow would be left with no entry step once `leaving` (entry arrow keys) are gone too. */
function lastEntry(molecule: Molecule, gone: ReadonlySet<string>, workflow: string, leaving: ReadonlySet<string>): boolean {
  return !molecule.arrows.some((x) => x.kind === 'entry' && x.from === workflow && !gone.has(arrowKey(x)) && !leaving.has(arrowKey(x)));
}

export function canDeleteAtom(molecule: Molecule, removed: Removed, key: string): Verdict {
  const atom = molecule.atoms.get(key);
  if (!atom) return { ok: false, reason: 'This row is no longer in the project.' };
  if (removed.atoms.includes(key)) return { ok: false, reason: `${atom.name} is already deleted in Valence.` };
  const gone = goneArrows(molecule, removed);
  const incoming = molecule.arrows.filter((x) => x.to === key && !gone.has(arrowKey(x)));
  const required = incoming.filter((x) => REQUIRED.has(x.kind));
  if (required.length > 0) {
    const what = required.length === 1 ? 'an arrow that can only be re-pointed points' : `${required.length} arrows that can only be re-pointed point`;
    return { ok: false, reason: `${atom.name} cannot be deleted: ${what} to it — ${required.map((x) => describe(molecule, x)).join('; ')}.` };
  }
  const leaving = new Set(incoming.filter((x) => x.kind === 'entry').map(arrowKey));
  const orphaned = [...new Set(incoming.filter((x) => x.kind === 'entry').map((x) => x.from))].filter((w) => lastEntry(molecule, gone, w, leaving));
  if (orphaned.length > 0) {
    return { ok: false, reason: `${atom.name} cannot be deleted: it is the only entry step of ${orphaned.map((w) => nameOf(molecule, w)).join(', ')} (a workflow keeps at least one).` };
  }
  return { ok: true, taking: incoming };
}

export function canDeleteArrow(molecule: Molecule, removed: Removed, key: string): Verdict {
  const x = molecule.arrows.find((a) => arrowKey(a) === key);
  if (!x) return { ok: false, reason: 'This arrow is no longer in the project.' };
  if (goneArrows(molecule, removed).has(key)) return { ok: false, reason: `${describe(molecule, x)} is already deleted in Valence.` };
  if (REQUIRED.has(x.kind)) {
    return { ok: false, reason: `${KINDS[x.kind].label} can only be re-pointed, not deleted: ${KINDS[x.kind].where} is NOT NULL.` };
  }
  if (x.kind === 'entry' && lastEntry(molecule, goneArrows(molecule, removed), x.from, new Set([key]))) {
    return { ok: false, reason: `${nameOf(molecule, x.to)} is the only entry step of ${nameOf(molecule, x.from)}: a workflow keeps at least one.` };
  }
  return { ok: true, taking: [] };
}

/** What deleting an arrow of this kind changes (spec §6b), for the Inspector. */
export const CONSEQUENCE: Readonly<Record<ArrowKind, string>> = {
  uses: 'Re-point only: every step runs on a processor.',
  asg: 'Re-point only: an assignment belongs to a step.',
  input: "The start's schema-edge check passes on an empty slot: this processor's input is no longer checked against the step before it. Running pods keep the old schema until they restart.",
  output: "The start's schema-edge check passes on an empty slot: this processor's output is no longer checked against the step after it. Running pods keep the old schema until they restart.",
  config: "The start's payload check skips a processor with no config schema: its steps' payloads are no longer checked. Running pods keep the old schema until they restart.",
  next: 'Steps no entry step reaches any more drop out of the run, with their assignments; this pair is no longer schema-checked.',
  entry: "This step, and what only it reached, drops out of the workflow's run.",
  wfAsg: 'The step still runs, with an empty payload: the payload is looked up only among the workflow\'s own assignments, and no start check notices.',
  wfCache: "The cache's entries are not projected into Redis at the next start: processors reading its root find nothing.",
};

/** One line for the Output pane: what a delete takes with it. */
export function deletedLine(molecule: Molecule, key: string, taking: readonly Arrow[]): string {
  const atom = molecule.atoms.get(key);
  if (atom) {
    const leaving = molecule.arrows.filter((x) => x.from === key).length;
    const went = taking.length + leaving;
    return `Deleted ${TYPES[atom.type].label.toLowerCase()} ${atom.name} in Valence (not applied)${went ? `; ${went} arrow${went === 1 ? '' : 's'} went with it` : ''}.`;
  }
  const x = molecule.arrows.find((a) => arrowKey(a) === key);
  return x ? `Deleted the arrow ${describe(molecule, x)} in Valence (not applied).` : 'Deleted in Valence (not applied).';
}
