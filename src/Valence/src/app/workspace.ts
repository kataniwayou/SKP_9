import { useSyncExternalStore } from 'react';
import type { ProjectData } from '../api/project';
import type { Molecule } from '../molecule/model';

/** Edited field texts by atom key, then by field: the virtual entities' changes (decision 8: nothing is applied yet). */
export type Edits = Readonly<Record<string, Readonly<Record<string, string>>>>;

export interface WorkspaceState {
  data: ProjectData | null;
  molecule: Molecule | null;
  /** The atom under the pointer: the Inspector previews it (the user, 2026-10-15: hover previews). */
  hovered: string | null;
  /** The clicked atom: the Inspector edits it while nothing is hovered (click pins). */
  pinned: string | null;
  edits: Edits;
}

export interface Workspace {
  get(): WorkspaceState;
  subscribe(listener: () => void): () => void;
  /** The project as BaseApi returned it; a pin or edit of a row it no longer has is dropped. */
  loaded(data: ProjectData, molecule: Molecule): void;
  hover(key: string | null): void;
  pin(key: string | null): void;
  /** A field's text; the stored text again means the field is no longer edited. */
  edit(key: string, field: string, text: string, saved: string): void;
  revert(key: string): void;
}

/**
 * What the canvas and the panes share, outside React's tree (the dock renders each pane through its own host): the
 * project, the hovered and pinned atoms, and the virtual entities' edits.
 */
export function createWorkspace(init: { pinned?: string | null; edits?: Edits } = {}): Workspace {
  let state: WorkspaceState = { data: null, molecule: null, hovered: null, pinned: init.pinned ?? null, edits: init.edits ?? {} };
  const listeners = new Set<() => void>();
  const set = (next: Partial<WorkspaceState>) => { state = { ...state, ...next }; listeners.forEach((l) => l()); };
  return {
    get: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    loaded(data, molecule) {
      const has = (k: string) => molecule.atoms.has(k);
      set({
        data, molecule, hovered: null,
        pinned: state.pinned && has(state.pinned) ? state.pinned : null,
        edits: Object.fromEntries(Object.entries(state.edits).filter(([k]) => has(k))),
      });
    },
    hover(key) { if (key !== state.hovered) set({ hovered: key }); },
    pin(key) { if (key !== state.pinned) set({ pinned: key }); },
    edit(key, field, text, saved) {
      const { [field]: _, ...rest } = state.edits[key] ?? {};
      const fields = text === saved ? rest : { ...rest, [field]: text };
      const { [key]: __, ...others } = state.edits;
      set({ edits: Object.keys(fields).length ? { ...others, [key]: fields } : others });
    },
    revert(key) { if (state.edits[key]) { const { [key]: _, ...others } = state.edits; set({ edits: others }); } },
  };
}

export function useWorkspace<T>(store: Workspace, select: (s: WorkspaceState) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}
