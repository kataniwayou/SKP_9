import type { StudioDocument } from '../app/document';
import type { Id } from '../model/graph';
import { selectionKey, type Selection } from './selection';

/** Where one open document is in its life: being read, ready to draw, or failed with a message. */
export type DocStatus =
  | { kind: 'loading' }
  | { kind: 'ready'; doc: StudioDocument }
  | { kind: 'failed'; message: string };

export interface OpenDocument {
  workflowId: Id;
  /** From the picker's list, so the tab has a title before the graph arrives. */
  name: string;
  version: string;
  status: DocStatus;
  /** Kept per document, so switching tabs and coming back keeps it (spec §9). */
  selection: Selection | null;
}

/**
 * The studio's shared state. Slice 3a holds no drafts and no undo: nothing can be edited yet.
 * Open documents are not restored on reload (spec §6.1), so none of this is persisted.
 */
export interface StudioState {
  /** In the order they were opened. */
  docs: OpenDocument[];
  /** The document the shared panes (Inspector, Problems) follow: the one last activated. */
  activeId: Id | null;
  /** The Inspector's one "▸ show all" switch, shared by every entity (spec §7). */
  showDetails: boolean;
}

export type StudioAction =
  | { type: 'open'; workflowId: Id; name: string; version: string }
  | { type: 'loaded'; workflowId: Id; doc: StudioDocument }
  | { type: 'failed'; workflowId: Id; message: string }
  | { type: 'close'; workflowId: Id }
  | { type: 'activate'; workflowId: Id }
  | { type: 'select'; workflowId: Id; selection: Selection | null }
  | { type: 'toggleDetails' };

export const INITIAL_STATE: StudioState = { docs: [], activeId: null, showDetails: false };

const update = (state: StudioState, id: Id, change: (doc: OpenDocument) => OpenDocument): StudioState => {
  const index = state.docs.findIndex((d) => d.workflowId === id);
  if (index < 0) return state;
  const changed = change(state.docs[index]!);
  if (changed === state.docs[index]) return state;
  const docs = state.docs.slice();
  docs[index] = changed;
  return { ...state, docs };
};

/** Pure: every change to the studio's state goes through here. Unknown ids leave the state as it was. */
export function reduce(state: StudioState, action: StudioAction): StudioState {
  switch (action.type) {
    case 'open': {
      if (state.docs.some((d) => d.workflowId === action.workflowId)) return { ...state, activeId: action.workflowId };
      const doc: OpenDocument = {
        workflowId: action.workflowId, name: action.name, version: action.version, status: { kind: 'loading' }, selection: null,
      };
      return { ...state, docs: [...state.docs, doc], activeId: action.workflowId };
    }
    case 'loaded':
      return update(state, action.workflowId, (d) => ({ ...d, status: { kind: 'ready', doc: action.doc } }));
    case 'failed':
      return update(state, action.workflowId, (d) => ({ ...d, status: { kind: 'failed', message: action.message } }));
    case 'close': {
      const index = state.docs.findIndex((d) => d.workflowId === action.workflowId);
      if (index < 0) return state;
      const docs = state.docs.filter((d) => d.workflowId !== action.workflowId);
      const activeId = state.activeId !== action.workflowId
        ? state.activeId
        : (docs[index] ?? docs[index - 1])?.workflowId ?? null;
      return { ...state, docs, activeId };
    }
    case 'activate':
      return state.docs.some((d) => d.workflowId === action.workflowId) && state.activeId !== action.workflowId
        ? { ...state, activeId: action.workflowId }
        : state;
    case 'select':
      return update(state, action.workflowId, (d) =>
        selectionKey(d.selection) === selectionKey(action.selection) ? d : { ...d, selection: action.selection });
    case 'toggleDetails':
      return { ...state, showDetails: !state.showDetails };
  }
}

export function activeDocument(state: StudioState): OpenDocument | null {
  return state.docs.find((d) => d.workflowId === state.activeId) ?? null;
}

/**
 * Changes whenever what the Inspector shows changes: another document, another selection, or the
 * document finishing its load. A hidden Inspector's rail tab glows when it changes (spec §6.2.5).
 */
export function inspectorKey(state: StudioState): string {
  const active = activeDocument(state);
  return active === null ? 'none' : `${active.workflowId}|${active.status.kind}|${selectionKey(active.selection)}`;
}
