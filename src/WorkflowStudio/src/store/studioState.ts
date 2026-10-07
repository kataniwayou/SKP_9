import type { StudioDocument } from '../app/document';
import type { EntityReadDto } from '../api/entities';
import type { Id } from '../model/graph';
import { savedText } from './entityForms';
import { EMPTY_INSPECTOR, type InspectorState, type SaveFailure } from './inspector';
import { currentTarget, rootTarget, targetKey, type InspectorTarget } from './inspectorTarget';
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
  /** This document's Inspector (slice 3b): its trail and edits are the draft the session keeps. */
  inspector: InspectorState;
}

/**
 * The studio's shared state. The page keeps it in its session (app/session.ts), so a refresh brings it back
 * (spec §6.1); a document's Inspector edits are its draft.
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
  | { type: 'toggleDetails' }
  | { type: 'drill'; workflowId: Id; target: InspectorTarget }
  /**
   * Keeps the first `depth` drill-downs (0: back to the selection). The user's back carries no `write`;
   * an unlink's back carries its write's token and applies only while that write is the Inspector's.
   */
  | { type: 'back'; workflowId: Id; depth: number; write?: number }
  | { type: 'edit'; workflowId: Id; key: string; text: string; saved: string }
  | { type: 'discard'; workflowId: Id }
  | { type: 'read'; workflowId: Id; key: string; result: { ok: true; dto: EntityReadDto } | { ok: false; message: string } }
  /**
   * Write results below carry the token `busy: true` started their write with (from the service's counter).
   * Each applies only while `inspector.write` is that token; otherwise it changes nothing, not even busy.
   */
  | { type: 'busy'; workflowId: Id; busy: boolean; write: number }
  | { type: 'saveFailed'; workflowId: Id; write: number; failure: SaveFailure }
  /** `sent`: the edits the PUT carried; only those are cleared. */
  | { type: 'saved'; workflowId: Id; write: number; key: string; sent: Record<string, string>; dto: EntityReadDto }
  /** `sent`: the edits the POST carried; text typed meanwhile stays, on the new assignment. */
  | { type: 'created'; workflowId: Id; write: number; target: InspectorTarget; sent: Record<string, string>; dto: EntityReadDto }
  /** A ready document re-read after a write: the new graph, keeping selection, view and Inspector. */
  | { type: 'refreshed'; workflowId: Id; doc: StudioDocument }
  /** A failed document goes back to loading. */
  | { type: 'retry'; workflowId: Id };

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

/** The target a document's Inspector shows, or null when nothing is selected. */
export function shownTargetOf(doc: OpenDocument): InspectorTarget | null {
  const root = rootTarget(doc.selection, doc.workflowId);
  return root === null ? null : currentTarget(root, doc.inspector.trail);
}

const inspect = (state: StudioState, id: Id, change: (i: InspectorState, d: OpenDocument) => InspectorState): StudioState =>
  update(state, id, (d) => {
    const next = change(d.inspector, d);
    return next === d.inspector ? d : { ...d, inspector: next };
  });

const without = (edits: Record<string, string>, drop: (key: string, text: string) => boolean): Record<string, string> =>
  Object.fromEntries(Object.entries(edits).filter(([key, text]) => !drop(key, text)));

/** Pure: every change to the studio's state goes through here. Unknown ids leave the state as it was. */
export function reduce(state: StudioState, action: StudioAction): StudioState {
  switch (action.type) {
    case 'open': {
      if (state.docs.some((d) => d.workflowId === action.workflowId)) return { ...state, activeId: action.workflowId };
      const doc: OpenDocument = {
        workflowId: action.workflowId, name: action.name, version: action.version, status: { kind: 'loading' }, selection: null, inspector: EMPTY_INSPECTOR,
      };
      return { ...state, docs: [...state.docs, doc], activeId: action.workflowId };
    }
    case 'loaded':
      return update(state, action.workflowId, (d) => ({
        ...d, name: action.doc.graph.workflow.name, version: action.doc.graph.workflow.version, status: { kind: 'ready', doc: action.doc },
      }));
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
        selectionKey(d.selection) === selectionKey(action.selection) ? d : { ...d, selection: action.selection, inspector: EMPTY_INSPECTOR });
    case 'toggleDetails':
      return { ...state, showDetails: !state.showDetails };
    case 'drill':
      return inspect(state, action.workflowId, (i) => ({ ...EMPTY_INSPECTOR, trail: [...i.trail, action.target] }));
    case 'back':
      return inspect(state, action.workflowId, (i) => {
        if (action.write !== undefined && i.write !== action.write) return i;
        return action.depth >= i.trail.length ? i : { ...EMPTY_INSPECTOR, trail: i.trail.slice(0, Math.max(0, action.depth)) };
      });
    case 'edit':
      return inspect(state, action.workflowId, (i) => {
        const edits = without(i.edits, (key) => key === action.key);
        if (action.text !== action.saved) edits[action.key] = action.text;
        return { ...i, edits };
      });
    case 'discard':
      return inspect(state, action.workflowId, (i) => ({ ...i, edits: {}, failure: null }));
    case 'read':
      // a read has no write token: the key check is what drops a read for an entity no longer shown
      return inspect(state, action.workflowId, (i, d) => {
        if (targetKey(shownTargetOf(d)) !== action.key) return i;
        // a failed re-read keeps the form it had, with a note (spec §8); with nothing read, only why
        if (!action.result.ok) return { ...i, saved: i.saved?.key === action.key ? i.saved : null, readError: action.result.message };
        const dto = action.result.dto;
        return { ...i, saved: { key: action.key, dto }, readError: null, edits: without(i.edits, (key, text) => text === savedText(dto, key)) };
      });
    // Write results are guarded by the write token alone: only select, drill, back and created change what the
    // Inspector shows, and the first three reset `write` to null, so a matching token means the entity the write
    // began on (or, after created, the assignment it made) is still shown. No key check is needed on top.
    case 'busy':
      return inspect(state, action.workflowId, (i) => {
        if (action.busy) return i.busy && i.write === action.write ? i : { ...i, busy: true, write: action.write };
        return i.write !== action.write || !i.busy ? i : { ...i, busy: false };
      });
    case 'saveFailed':
      return inspect(state, action.workflowId, (i) => (i.write !== action.write ? i : { ...i, busy: false, failure: action.failure }));
    case 'saved':
      return inspect(state, action.workflowId, (i) => {
        if (i.write !== action.write) return i;
        const edits = without(i.edits, (key, text) => action.sent[key] === text);
        return { ...i, edits, busy: false, failure: null, readError: null, saved: { key: action.key, dto: action.dto } };
      });
    case 'created':
      // stays busy under the same token: the link that follows is still part of this write. It ends with its own
      // busy false, or a saveFailed that says on the new assignment why it is not linked. Typing goes on meanwhile.
      return inspect(state, action.workflowId, (i) => (i.write !== action.write ? i : {
        ...EMPTY_INSPECTOR, trail: [...i.trail.slice(0, -1), action.target], saved: { key: targetKey(action.target), dto: action.dto },
        edits: without(i.edits, (key, text) => action.sent[key] === text), busy: true, write: action.write,
      }));
    case 'refreshed':
      return update(state, action.workflowId, (d) => (d.status.kind !== 'ready' ? d : {
        ...d, name: action.doc.graph.workflow.name, version: action.doc.graph.workflow.version, status: { kind: 'ready', doc: action.doc },
      }));
    case 'retry':
      return update(state, action.workflowId, (d) => (d.status.kind !== 'failed' ? d : { ...d, status: { kind: 'loading' } }));
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
  return active === null ? 'none' : `${active.workflowId}|${active.status.kind}|${selectionKey(active.selection)}|${active.inspector.trail.map(targetKey).join('>')}`;
}
