import { useSyncExternalStore } from 'react';
import type { RulesSource } from '../api/fields';
import type { ProjectData } from '../api/project';
import { canDeleteArrow, canDeleteAtom, deletedLine, NOTHING_REMOVED, type Removed } from '../molecule/deletion';
import type { Vec } from '../molecule/layout';
import { arrowKey, atomKey, buildMolecule, isArrowKey, KINDS, TYPES, type ArrowKind, type AtomType, type Molecule } from '../molecule/model';
import { DRAWABLE, MAKES, newCreated, virtualData, type AddedArrow, type CreatedAtom } from './virtual';
import { rulesOf, SNAPSHOT_RULES, type Rules } from '../molecule/rules';
import { NO_DRY_RUN, type DryRunState } from '../molecule/verdict';

/** Edited field texts by atom key, then by field: the virtual entities' changes (decision 8: nothing is applied yet). */
export type Edits = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** One atom's edited fields before and after a change (null: not edited). */
export interface EditChange { key: string; before: Readonly<Record<string, string>> | null; after: Readonly<Record<string, string>> | null }

/**
 * One step of the shared history (the user, 2026-10-16: edits and deletions in one history, kept on refresh): edits,
 * and atoms or arrows deleted. `merge` joins typing in one field into one step.
 */
export interface Change {
  label: string;
  edits?: readonly EditChange[];
  atoms?: readonly string[];
  arrows?: readonly string[];
  /** Atoms made from the Toolbox (forward: they appear) and made ones deleted (forward: they go). */
  created?: readonly CreatedAtom[];
  uncreated?: readonly CreatedAtom[];
  /** Arrows drawn from the Toolbox (forward: they appear) and drawn ones deleted (forward: they go). */
  added?: readonly AddedArrow[];
  unadded?: readonly AddedArrow[];
  /** Deleted arrows drawn again (forward: their delete is taken back). */
  restored?: readonly string[];
  merge?: string;
}
export interface History { past: readonly Change[]; future: readonly Change[] }
export const NO_HISTORY: History = { past: [], future: [] };
/** The steps kept: enough to step back through a session, small enough for the session's storage. */
const HISTORY_CAP = 100;

/** A line in the Output pane. */
export interface Message { id: number; at: string; text: string; tone: 'info' | 'refused' }
const MESSAGE_CAP = 200;

export interface WorkspaceState {
  /** The project as Valence shows it: BaseApi's rows with the created atoms and the drawn arrows (`virtualData`). */
  data: ProjectData | null;
  molecule: Molecule | null;
  /** The project as BaseApi returned it. */
  base: { data: ProjectData; molecule: Molecule } | null;
  /** Made from the Toolbox, not applied (the user, 2026-10-17): atoms, and arrows drawn between atoms. */
  created: readonly CreatedAtom[];
  added: readonly AddedArrow[];
  /** The atom or arrow under the pointer: the Inspector previews it (the user, 2026-10-15: hover previews). */
  hovered: string | null;
  /** The clicked atom or arrow: the Inspector shows it while nothing is hovered (click pins); Delete deletes it. */
  pinned: string | null;
  edits: Edits;
  /** Deleted in Valence and not applied (spec §6): drawn as ghosts. */
  removed: Removed;
  history: History;
  messages: readonly Message[];
  /** BaseApi's rules for every writable field (`GET /model/fields`), or the bundled snapshot until BaseApi answers. */
  rules: Rules;
  /** BaseApi's dry run of the virtual changes (`POST /model/validate`): what the apply would answer, change by change. */
  dryRun: DryRunState;
  /** Whether BaseApi's dry run answers (its last run did): then it runs the code rules and Valence's stand-ins rest. */
  dryRunWorks: boolean;
}

export interface Workspace {
  get(): WorkspaceState;
  subscribe(listener: () => void): () => void;
  /** The project as BaseApi returned it; a pin, edit or deletion of a row it no longer has is dropped. */
  loaded(data: ProjectData, molecule: Molecule): void;
  /** The rules BaseApi described (or the snapshot it fell back to, and why): one line in the Output pane. */
  rulesLoaded(source: RulesSource): void;
  /** BaseApi's answer to the dry run of the current changes; a line for the Output pane when the answer changed. */
  judged(state: DryRunState, line?: string | null, works?: boolean): void;
  hover(key: string | null): void;
  pin(key: string | null): void;
  /** A field's text; the stored text again means the field is no longer edited. Typing in one field is one step. */
  edit(key: string, field: string, text: string, saved: string): void;
  revert(key: string): void;
  /** Deletes an atom or arrow in Valence under the rules (spec §6); a refusal says why in the Output pane. */
  remove(key: string | null): boolean;
  /** Makes an atom from the Toolbox, dropped on `on` (its mandatory arrow's target) or on empty canvas; a refusal says why. */
  create(type: AtomType, on: string | null, pos: Vec): string | null;
  /** Draws an arrow from the Toolbox, tail first, then head (the user, 2026-10-17); a refusal says why. */
  draw(kind: ArrowKind, tail: string, head: string): boolean;
  undo(): void;
  redo(): void;
}

/**
 * What the canvas and the panes share, outside React's tree (the dock renders each pane through its own host): the
 * project, the hovered and pinned atom or arrow, the virtual entities' edits and deletions, their history, and the
 * Output pane's messages.
 */
export function createWorkspace(init: { pinned?: string | null; edits?: Edits; removed?: Removed; history?: History; created?: readonly CreatedAtom[]; added?: readonly AddedArrow[] } = {}): Workspace {
  let state: WorkspaceState = {
    data: null, molecule: null, base: null, created: init.created ?? [], added: init.added ?? [],
    hovered: null, pinned: init.pinned ?? null, edits: init.edits ?? {},
    removed: init.removed ?? NOTHING_REMOVED, history: init.history ?? NO_HISTORY, messages: [], rules: SNAPSHOT_RULES, dryRun: NO_DRY_RUN, dryRunWorks: false,
  };
  let nextMessage = 1;
  const listeners = new Set<() => void>();
  /** The virtual project again when what was made changed. */
  const virtual = (next: Partial<WorkspaceState>): Partial<WorkspaceState> => {
    if (!('created' in next || 'added' in next || 'base' in next)) return next;
    const b = next.base ?? state.base;
    if (!b) return next;
    const created = next.created ?? state.created, added = next.added ?? state.added;
    if (created.length === 0 && added.length === 0) return { ...next, data: b.data, molecule: b.molecule };
    const data = virtualData(b.data, created, added);
    return { ...next, data, molecule: buildMolecule(data) };
  };
  const set = (next: Partial<WorkspaceState>) => { state = { ...state, ...virtual(next) }; listeners.forEach((l) => l()); };
  const say = (text: string, tone: Message['tone'] = 'info') =>
    [...state.messages, { id: nextMessage++, at: new Date().toISOString(), text, tone }].slice(-MESSAGE_CAP);

  /** The state a change leaves, run forwards (redo) or backwards (undo). */
  function run(change: Change, forward: boolean): Pick<WorkspaceState, 'edits' | 'removed' | 'created' | 'added'> {
    let edits: Record<string, Readonly<Record<string, string>>> = { ...state.edits };
    for (const e of change.edits ?? []) {
      const fields = forward ? e.after : e.before;
      if (fields && Object.keys(fields).length) edits[e.key] = fields; else { const { [e.key]: _, ...rest } = edits; edits = rest; }
    }
    const toggle = (list: readonly string[], keys: readonly string[] | undefined) =>
      (!keys?.length ? list : forward ? [...list, ...keys.filter((k) => !list.includes(k))] : list.filter((k) => !keys.includes(k)));
    // made atoms and drawn arrows: what a change brought in goes out when it is undone, and the other way round
    const made = <T,>(list: readonly T[], plus: readonly T[] | undefined, minus: readonly T[] | undefined, same: (a: T, b: T) => boolean) => {
      const [add, drop] = forward ? [plus, minus] : [minus, plus];
      const kept = list.filter((x) => !(drop ?? []).some((y) => same(x, y)));
      return [...kept, ...(add ?? []).filter((x) => !kept.some((y) => same(x, y)))];
    };
    return {
      edits,
      removed: {
        atoms: toggle(state.removed.atoms, change.atoms),
        arrows: (() => {
          const arrows = toggle(state.removed.arrows, change.arrows), back = change.restored ?? [];
          return forward ? arrows.filter((k) => !back.includes(k)) : [...arrows, ...back.filter((k) => !arrows.includes(k))];
        })(),
      },
      created: change.created || change.uncreated ? made(state.created, change.created, change.uncreated, (a, b) => a.key === b.key) : state.created,
      added: change.added || change.unadded ? made(state.added, change.added, change.unadded, (a, b) => a === b) : state.added,
    };
  }
  /** Does a change and records it; typing on in the same field replaces the last step's result instead of adding one. */
  function commit(change: Change, extra: Partial<WorkspaceState> = {}) {
    const last = state.history.past[state.history.past.length - 1];
    if (change.merge && last?.merge === change.merge && state.history.future.length === 0) {
      const merged: Change = { ...last, edits: last.edits!.map((e, i) => ({ ...e, after: change.edits![i]!.after })) };
      set({ ...run(change, true), history: { past: [...state.history.past.slice(0, -1), merged], future: [] }, ...extra });
      return;
    }
    set({ ...run(change, true), history: { past: [...state.history.past, change].slice(-HISTORY_CAP), future: [] }, ...extra });
  }

  return {
    get: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    loaded(data, molecule) {
      // what was made stays while what it hangs on is still there (a made atom may hang on another made one)
      const created = state.created.filter((c) => {
        const on = MAKES[c.type].on;
        if (!on) return true;
        const field = c.type === 'step' ? 'processorId' : c.type === 'asg' ? 'stepId' : 'entryStepIds';
        const id = c.type === 'wf' ? (c.row.entryStepIds as string[])[0] : (c.row[field] as string);
        return !!id && (molecule.atoms.has(atomKey(on, id)) || state.created.some((o) => o.id === id));
      });
      const known = (k: string) => molecule.atoms.has(k) || created.some((c) => c.key === k);
      const added = state.added.filter((a) => { const [, f, t] = a.split('|'); return known(f!) && known(t!); });
      const v = virtualData(data, created, added);
      const vm = created.length || added.length ? buildMolecule(v) : molecule;
      const has = (k: string) => vm.atoms.has(k) || (isArrowKey(k) && vm.arrows.some((x) => arrowKey(x) === k));
      state = { ...state, base: { data, molecule }, created, added };
      set({
        data: v, molecule: vm, hovered: null,
        pinned: state.pinned && has(state.pinned) ? state.pinned : null,
        edits: Object.fromEntries(Object.entries(state.edits).filter(([k]) => has(k))),
        removed: { atoms: state.removed.atoms.filter(has), arrows: state.removed.arrows.filter(has) },
      });
    },
    rulesLoaded(source) { set({ rules: rulesOf(source), messages: say(source.note, source.from === 'baseapi' ? 'info' : 'refused') }); },
    judged(dryRun, line, works) {
      const last = state.messages[state.messages.length - 1]?.text;
      const dryRunWorks = works ?? (dryRun.kind === 'done' ? true : dryRun.kind === 'unavailable' ? false : state.dryRunWorks);
      set(line && line !== last ? { dryRun, dryRunWorks, messages: say(line, dryRun.kind === 'done' && dryRun.ok ? 'info' : 'refused') } : { dryRun, dryRunWorks });
    },
    hover(key) { if (key !== state.hovered) set({ hovered: key }); },
    pin(key) { if (key !== state.pinned) set({ pinned: key }); },
    edit(key, field, text, saved) {
      const before = state.edits[key] ?? null;
      const { [field]: _, ...rest } = before ?? {};
      const after = text === saved ? rest : { ...rest, [field]: text };
      const name = state.molecule?.atoms.get(key)?.name ?? key;
      commit({ label: `edit ${field} of ${name}`, edits: [{ key, before, after: Object.keys(after).length ? after : null }], merge: `edit|${key}|${field}` });
    },
    revert(key) {
      const before = state.edits[key];
      if (!before) return;
      commit({ label: `revert ${state.molecule?.atoms.get(key)?.name ?? key}`, edits: [{ key, before, after: null }] });
    },
    remove(key) {
      const molecule = state.molecule;
      if (!molecule) return false;
      if (key === null) { set({ messages: say('Nothing to delete: click an atom or arrow to pin it, then press Delete.', 'refused') }); return false; }
      const arrow = isArrowKey(key);
      const verdict = arrow ? canDeleteArrow(molecule, state.removed, key) : canDeleteAtom(molecule, state.removed, key);
      if (!verdict.ok) { set({ messages: say(verdict.reason, 'refused') }); return false; }
      // made in Valence: deleting it takes it back, with the drawn arrows touching it
      const made = state.created.find((c) => c.key === key);
      if (made || state.added.includes(key)) {
        const touching = state.added.filter((a) => a === key || a.split('|')[1] === key || a.split('|')[2] === key);
        const name = molecule.atoms.get(key)?.name;
        const named = made && state.edits[key]?.name ? ` ${state.edits[key]!.name}` : '';
        const line = made ? `Took back the new ${TYPES[made.type].label.toLowerCase()}${named} (made in Valence, never applied).` : 'Took back the drawn arrow (never applied).';
        commit({ label: made ? `take back ${name}` : 'take back an arrow', ...(made ? { uncreated: [made] } : {}), ...(touching.length ? { unadded: touching } : {}) },
          { messages: say(line), pinned: state.pinned === key ? null : state.pinned });
        return true;
      }
      const line = deletedLine(molecule, key, verdict.taking);
      commit({ label: line.replace(/^Deleted /, 'delete ').replace(/ in Valence.*$/, ''), ...(arrow ? { arrows: [key] } : { atoms: [key] }) },
        { messages: say(line) });
      return true;
    },
    create(type, on, pos) {
      const molecule = state.molecule;
      if (!molecule) return null;
      const need = MAKES[type].on;
      const label = TYPES[type].label;
      const target = on ? molecule.atoms.get(on) : undefined;
      if (need && (!target || target.type !== need || state.removed.atoms.includes(on!))) {
        set({ messages: say(`A ${label.toLowerCase()} is dropped on a ${TYPES[need].label.toLowerCase()}: its ${KINDS[type === 'step' ? 'uses' : type === 'asg' ? 'asg' : 'entry'].label} arrow is mandatory.`, 'refused') });
        return null;
      }
      const made = newCreated(type, need ? target!.id : null, pos);
      commit({ label: `make a ${label.toLowerCase()}`, created: [made] },
        { messages: say(`Made a new ${label.toLowerCase()}${target ? ` on ${target.name}` : ''} in Valence (not applied): fill in its fields in the Inspector.`), pinned: made.key });
      return made.key;
    },
    draw(kind, tail, head) {
      const molecule = state.molecule;
      const d = DRAWABLE[kind];
      if (!molecule || !d) return false;
      const t = molecule.atoms.get(tail), h = molecule.atoms.get(head);
      const refuse = (why: string) => { set({ messages: say(why, 'refused') }); return false; };
      if (!t || t.type !== d.tail || state.removed.atoms.includes(tail)) return refuse(`${KINDS[kind].label} starts at a ${TYPES[d.tail].label.toLowerCase()}.`);
      if (!h || h.type !== d.head || state.removed.atoms.includes(head)) return refuse(`${KINDS[kind].label} ends at a ${TYPES[d.head].label.toLowerCase()}.`);
      if (kind === 'next' && tail === head) return refuse(`${t.name} cannot be its own next step.`);
      const key = `${kind}|${tail}|${head}`;
      const there = molecule.arrows.find((x) => arrowKey(x) === key);
      if (there && !state.removed.arrows.includes(key)) return refuse(`${t.name} → ${h.name} (${KINDS[kind].label}) is already there.`);
      if (there) {
        // drawn again where it was deleted: the delete is taken back
        commit({ label: `draw ${t.name} → ${h.name}`, restored: [key] }, { messages: say(`Drew ${t.name} → ${h.name} again (${KINDS[kind].label}); its delete is taken back.`) });
        return true;
      }
      if (!d.list) {
        const taken = molecule.arrows.find((x) => x.kind === kind && x.from === tail && !state.removed.arrows.includes(arrowKey(x)));
        if (taken) return refuse(`${t.name} already has a ${KINDS[kind].label.toLowerCase()} (${molecule.atoms.get(taken.to)?.name}): delete that arrow first.`);
      }
      commit({ label: `draw ${t.name} → ${h.name}`, added: [key] }, { messages: say(`Drew ${t.name} → ${h.name} (${KINDS[kind].label}) in Valence (not applied).`) });
      return true;
    },
    undo() {
      const change = state.history.past[state.history.past.length - 1];
      if (!change) { set({ messages: say('Nothing to undo.') }); return; }
      set({ ...run(change, false), history: { past: state.history.past.slice(0, -1), future: [change, ...state.history.future] }, messages: say(`Undid: ${change.label}.`) });
    },
    redo() {
      const [change, ...future] = state.history.future;
      if (!change) { set({ messages: say('Nothing to redo.') }); return; }
      set({ ...run(change, true), history: { past: [...state.history.past, change], future }, messages: say(`Redid: ${change.label}.`) });
    },
  };
}

export function useWorkspace<T>(workspace: Workspace, pick: (s: WorkspaceState) => T): T {
  return useSyncExternalStore(workspace.subscribe, () => pick(workspace.get()));
}
