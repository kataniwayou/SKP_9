import { useSyncExternalStore } from 'react';
import type { ProjectData } from '../api/project';
import { canDeleteArrow, canDeleteAtom, deletedLine, NOTHING_REMOVED, type Removed } from '../molecule/deletion';
import { arrowKey, isArrowKey, type Molecule } from '../molecule/model';

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
  data: ProjectData | null;
  molecule: Molecule | null;
  /** The atom or arrow under the pointer: the Inspector previews it (the user, 2026-10-15: hover previews). */
  hovered: string | null;
  /** The clicked atom or arrow: the Inspector shows it while nothing is hovered (click pins); Delete deletes it. */
  pinned: string | null;
  edits: Edits;
  /** Deleted in Valence and not applied (spec §6): drawn as ghosts. */
  removed: Removed;
  history: History;
  messages: readonly Message[];
}

export interface Workspace {
  get(): WorkspaceState;
  subscribe(listener: () => void): () => void;
  /** The project as BaseApi returned it; a pin, edit or deletion of a row it no longer has is dropped. */
  loaded(data: ProjectData, molecule: Molecule): void;
  hover(key: string | null): void;
  pin(key: string | null): void;
  /** A field's text; the stored text again means the field is no longer edited. Typing in one field is one step. */
  edit(key: string, field: string, text: string, saved: string): void;
  revert(key: string): void;
  /** Deletes an atom or arrow in Valence under the rules (spec §6); a refusal says why in the Output pane. */
  remove(key: string | null): boolean;
  undo(): void;
  redo(): void;
}

/**
 * What the canvas and the panes share, outside React's tree (the dock renders each pane through its own host): the
 * project, the hovered and pinned atom or arrow, the virtual entities' edits and deletions, their history, and the
 * Output pane's messages.
 */
export function createWorkspace(init: { pinned?: string | null; edits?: Edits; removed?: Removed; history?: History } = {}): Workspace {
  let state: WorkspaceState = {
    data: null, molecule: null, hovered: null, pinned: init.pinned ?? null, edits: init.edits ?? {},
    removed: init.removed ?? NOTHING_REMOVED, history: init.history ?? NO_HISTORY, messages: [],
  };
  let nextMessage = 1;
  const listeners = new Set<() => void>();
  const set = (next: Partial<WorkspaceState>) => { state = { ...state, ...next }; listeners.forEach((l) => l()); };
  const say = (text: string, tone: Message['tone'] = 'info') =>
    [...state.messages, { id: nextMessage++, at: new Date().toISOString(), text, tone }].slice(-MESSAGE_CAP);

  /** The state a change leaves, run forwards (redo) or backwards (undo). */
  function run(change: Change, forward: boolean): Pick<WorkspaceState, 'edits' | 'removed'> {
    let edits: Record<string, Readonly<Record<string, string>>> = { ...state.edits };
    for (const e of change.edits ?? []) {
      const fields = forward ? e.after : e.before;
      if (fields && Object.keys(fields).length) edits[e.key] = fields; else { const { [e.key]: _, ...rest } = edits; edits = rest; }
    }
    const toggle = (list: readonly string[], keys: readonly string[] | undefined) =>
      (!keys?.length ? list : forward ? [...list, ...keys.filter((k) => !list.includes(k))] : list.filter((k) => !keys.includes(k)));
    return { edits, removed: { atoms: toggle(state.removed.atoms, change.atoms), arrows: toggle(state.removed.arrows, change.arrows) } };
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
      const has = (k: string) => molecule.atoms.has(k) || (isArrowKey(k) && molecule.arrows.some((x) => arrowKey(x) === k));
      set({
        data, molecule, hovered: null,
        pinned: state.pinned && has(state.pinned) ? state.pinned : null,
        edits: Object.fromEntries(Object.entries(state.edits).filter(([k]) => has(k))),
        removed: { atoms: state.removed.atoms.filter(has), arrows: state.removed.arrows.filter(has) },
      });
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
      const line = deletedLine(molecule, key, verdict.taking);
      commit({ label: line.replace(/^Deleted /, 'delete ').replace(/ in Valence.*$/, ''), ...(arrow ? { arrows: [key] } : { atoms: [key] }) },
        { messages: say(line) });
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
