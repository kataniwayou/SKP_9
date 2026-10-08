import type { StudioDocument } from '../app/document';
import type { EntityReadDto } from '../api/entities';
import type { DesignError, Id } from '../model/graph';
import {
  createAssignment, EMPTY_EDITS, hasGraphChanges, removeAssignment, revertEntity, sameDesign, setField, storedDesignOf,
  type Design, type EntityEdits, type FieldValue,
} from '../design/design';
import { circuitOf, EMPTY_DRAFT, type Draft } from '../design/draft';
import { commit, historyOf, redo, undo, type DesignHistory } from '../design/history';
import { settleDesign } from '../design/settle';
import { CACHE_NODE_PREFIX, SPHERE_NODE_ID } from '../layout/nodeIds';
import { EMPTY_INSPECTOR, type InspectorState } from './inspector';
import { currentTarget, editTargetOf, rootTarget, targetKey, type InspectorTarget } from './inspectorTarget';
import { picksOf, samePicks, type Pick } from './picks';
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
  /** This document's Inspector (slice 3b): its trail is the draft the session keeps. */
  inspector: InspectorState;
  /** What is picked on the canvas (plan 4); the Inspector's `selection` is the one entity it shows. */
  picks: Pick[];
  /** The design draft and its history (plan 4). The draft is kept in the session; the history is not. */
  design: DesignHistory;
  /** The Inspector's part of the design (plan 8): entity edits, assignment operations, schema copies. Not in the undo history. */
  edits: EntityEdits;
  /** The last Save's errors (plan 8 §4.1); null: no Save answered with errors since it was opened, saved or discarded. */
  errors: DesignError[] | null;
  /** The last saved design (plan 8 §3.1): the stored design read back with the graph; null until it is loaded. */
  stored: Design | null;
  /** The session brought unsaved design edits back: loading keeps them instead of the stored design. */
  restored: boolean;
  /** A Save is in flight: the design is read-only (spec §4.1). */
  saving: boolean;
}

export interface OutputLine {
  /** ISO time of the answer. */
  at: string;
  workflowId: Id;
  name: string;
  text: string;
}

/**
 * The studio's shared state. The page keeps it in its session (app/session.ts), so a refresh brings it back
 * (spec §6.1); a document's unsaved design comes back with it (plan 8 §3.2).
 */
export interface StudioState {
  /** In the order they were opened. */
  docs: OpenDocument[];
  /** The document the shared panes (Inspector, Problems) follow: the one last activated. */
  activeId: Id | null;
  /** The Inspector's one "▸ show all" switch, shared by every entity (spec §7). */
  showDetails: boolean;
  /** Save results, oldest first (plan 8 §4.1); not kept across a refresh. */
  output: OutputLine[];
}

export type StudioAction =
  | { type: 'open'; workflowId: Id; name: string; version: string }
  | { type: 'loaded'; workflowId: Id; doc: StudioDocument }
  | { type: 'failed'; workflowId: Id; message: string }
  | { type: 'close'; workflowId: Id }
  | { type: 'activate'; workflowId: Id }
  /** `picks`: what the canvas picked with it; absent, the selection's own block (or nothing). */
  | { type: 'select'; workflowId: Id; selection: Selection | null; picks?: Pick[] }
  /** Picks only (a drag of a block that was not picked): the Inspector is untouched. */
  | { type: 'pick'; workflowId: Id; picks: Pick[] }
  /** A finished design gesture (spec §5.3); `merge` joins a run of the same kind into one step. */
  | { type: 'design'; workflowId: Id; draft: Draft; merge?: string; picks?: Pick[] }
  | { type: 'undo'; workflowId: Id }
  | { type: 'redo'; workflowId: Id }
  | { type: 'discardDesign'; workflowId: Id }
  | { type: 'toggleDetails' }
  | { type: 'drill'; workflowId: Id; target: InspectorTarget }
  /** Keeps the first `depth` drill-downs (0: back to the selection). */
  | { type: 'back'; workflowId: Id; depth: number }
  | { type: 'read'; workflowId: Id; key: string; result: { ok: true; dto: EntityReadDto } | { ok: false; message: string } }
  /** A field typed into the shown entity: a design edit (spec §3.3). `copyId` names a schema copy if this edit makes one. */
  | { type: 'editField'; workflowId: Id; key: string; value: FieldValue; copyId: string }
  /** Drops the shown entity's design edits. */
  | { type: 'revertEntity'; workflowId: Id }
  /** Creates a step's assignment in the design and shows it. */
  | { type: 'createAssignment'; workflowId: Id; stepId: Id; stepName: string; id: Id }
  /** Removes a step's assignment in the design. */
  | { type: 'removeAssignment'; workflowId: Id; stepId: Id }
  | { type: 'saving'; workflowId: Id }
  /** BaseApi's answer to a Save, with the document read again (null: the re-read failed). */
  | { type: 'saveAnswered'; workflowId: Id; at: string; applied: boolean; errors: DesignError[]; doc: StudioDocument | null }
  /** A Save that never got an answer (400, network): nothing was stored. */
  | { type: 'saveFailed'; workflowId: Id; at: string; message: string }
  /** A failed document goes back to loading. */
  | { type: 'retry'; workflowId: Id };

export const INITIAL_STATE: StudioState = { docs: [], activeId: null, showDetails: false, output: [] };

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

/** New picks end a run of nudges (spec §5.3): the next nudge is a step of its own. */
const withPicks = (d: OpenDocument, picks: Pick[]): OpenDocument =>
  ({ ...d, picks, design: d.design.merge === null ? d.design : { ...d.design, merge: null } });

/**
 * After undo, redo or Discard design: the picks naming what the saved workflow with `draft` over it has.
 * A wire pick stays while the circuit has the wire. A document not ready keeps its picks.
 */
function prunedPicks(d: OpenDocument, draft: Draft): Pick[] {
  if (d.status.kind !== 'ready') return d.picks;
  const saved = d.status.doc;
  const wires = circuitOf(saved, draft);
  const exists = (p: Pick): boolean => {
    if (p.kind === 'node') {
      if (p.id === SPHERE_NODE_ID) return true;
      if (p.id.startsWith(CACHE_NODE_PREFIX)) return saved.placement.caches.has(p.id.slice(CACHE_NODE_PREFIX.length));
      return saved.placement.steps.has(p.id);
    }
    // a wire keeps its id for life (plan 9): its pick stays while the circuit has it
    return Object.hasOwn(wires, p.id);
  };
  const kept = d.picks.filter(exists);
  return kept.length === d.picks.length ? d.picks : kept;
}

const redesign = (d: OpenDocument, design: DesignHistory): OpenDocument =>
  design === d.design ? d : { ...d, design, picks: prunedPicks(d, design.draft) };

/** Pure: every change to the studio's state goes through here. Unknown ids leave the state as it was. */
export function reduce(state: StudioState, action: StudioAction): StudioState {
  switch (action.type) {
    case 'open': {
      if (state.docs.some((d) => d.workflowId === action.workflowId)) return { ...state, activeId: action.workflowId };
      const doc: OpenDocument = {
        workflowId: action.workflowId, name: action.name, version: action.version, status: { kind: 'loading' }, selection: null, inspector: EMPTY_INSPECTOR,
        picks: [], design: historyOf(), edits: EMPTY_EDITS, errors: null, stored: null, restored: false, saving: false,
      };
      return { ...state, docs: [...state.docs, doc], activeId: action.workflowId };
    }
    case 'loaded':
      return update(state, action.workflowId, (d) => {
        const stored = settleDesign(storedDesignOf(action.doc.graph.design, action.doc.graph.layout), action.doc);
        // a refresh's unsaved edits win over the stored design (spec §3.2); a plan 8 session's wires are settled too (plan 9 §8)
        const settled = d.restored ? settleDesign({ draft: d.design.draft, edits: d.edits }, action.doc).draft : null;
        const design = settled === null
          ? { design: historyOf(stored.draft), edits: stored.edits }
          : settled === d.design.draft ? {} : { design: historyOf(settled) };
        return { ...d, ...design, name: action.doc.graph.workflow.name, version: action.doc.graph.workflow.version, status: { kind: 'ready', doc: action.doc }, stored, restored: false };
      });
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
      return update(state, action.workflowId, (d) => {
        const picks = action.picks ?? picksOf(action.selection);
        const same = selectionKey(d.selection) === selectionKey(action.selection);
        const picked = samePicks(d.picks, picks);
        if (same && picked) return d;
        const next = picked ? d : withPicks(d, picks);
        return same ? next : { ...next, selection: action.selection, inspector: EMPTY_INSPECTOR };
      });
    case 'pick':
      return update(state, action.workflowId, (d) => (samePicks(d.picks, action.picks) ? d : withPicks(d, action.picks)));
    case 'design':
      return update(state, action.workflowId, (d) => ({
        ...d, design: commit(d.design, action.draft, action.merge ?? null), picks: action.picks ?? d.picks,
      }));
    case 'undo':
      return update(state, action.workflowId, (d) => redesign(d, undo(d.design)));
    case 'redo':
      return update(state, action.workflowId, (d) => redesign(d, redo(d.design)));
    case 'discardDesign':
      return update(state, action.workflowId, (d) => {
        const back = redesign(d, historyOf(d.stored?.draft ?? EMPTY_DRAFT));
        return { ...back, edits: d.stored?.edits ?? EMPTY_EDITS, errors: null };
      });
    case 'toggleDetails':
      return { ...state, showDetails: !state.showDetails };
    case 'drill':
      return inspect(state, action.workflowId, (i) => ({ ...EMPTY_INSPECTOR, trail: [...i.trail, action.target] }));
    case 'back':
      return inspect(state, action.workflowId, (i) => (action.depth >= i.trail.length ? i : { ...EMPTY_INSPECTOR, trail: i.trail.slice(0, Math.max(0, action.depth)) }));
    case 'read':
      // the key check is what drops a read for an entity no longer shown
      return inspect(state, action.workflowId, (i, d) => {
        if (targetKey(shownTargetOf(d)) !== action.key) return i;
        // a failed re-read keeps the form it had, with a note (spec §8); with nothing read, only why
        if (!action.result.ok) return { ...i, saved: i.saved?.key === action.key ? i.saved : null, readError: action.result.message };
        return { ...i, saved: { key: action.key, dto: action.result.dto }, readError: null };
      });
    case 'editField':
      return update(state, action.workflowId, (d) => {
        const target = shownTargetOf(d);
        const base = d.inspector.saved;
        if (d.saving || target === null || base === null || base.key !== targetKey(target)) return d;
        return { ...d, edits: setField(d.edits, editTargetOf(target), base.dto, action.key, action.value, () => action.copyId) };
      });
    case 'revertEntity':
      return update(state, action.workflowId, (d) => {
        const target = shownTargetOf(d);
        return d.saving || target === null ? d : { ...d, edits: revertEntity(d.edits, editTargetOf(target)) };
      });
    case 'createAssignment':
      return update(state, action.workflowId, (d) => {
        if (d.saving) return d;
        const edits = createAssignment(d.edits, action.stepId, action.stepName, action.id);
        const shown = edits.assignments[action.stepId]!;
        return { ...d, edits, inspector: { ...EMPTY_INSPECTOR, trail: [...d.inspector.trail, { kind: 'assignment', id: shown.id, stepId: action.stepId }] } };
      });
    case 'removeAssignment':
      return update(state, action.workflowId, (d) => {
        if (d.saving) return d;
        const base = d.status.kind === 'ready' ? d.status.doc.graph.assignments.find((a) => a.stepId === action.stepId) : undefined;
        const edits = removeAssignment(d.edits, action.stepId, base && { id: base.id, updatedAt: base.updatedAt });
        const shown = shownTargetOf(d);
        const leave = shown?.kind === 'assignment' && shown.stepId === action.stepId;
        return { ...d, edits, inspector: leave ? { ...EMPTY_INSPECTOR, trail: d.inspector.trail.slice(0, -1) } : d.inspector };
      });
    case 'saving':
      return update(state, action.workflowId, (d) => (d.saving ? d : { ...d, saving: true }));
    case 'saveAnswered': {
      const doc = state.docs.find((d) => d.workflowId === action.workflowId);
      if (!doc) return state;
      const n = action.errors.length;
      // applied by BaseApi, the only errors left are the design's short circuits (plan 9 §7), whose links were not written
      const text = !action.applied ? `Saved; not applied: ${n} error${n === 1 ? '' : 's'}`
        : n === 0 ? 'Saved and applied' : `Saved and applied; ${n} short circuit${n === 1 ? '' : 's'} not written`;
      const next = update(state, action.workflowId, (d) => {
        // either way the design is now stored on the workflow and the session's edits are cleared (spec §4.1)
        const stored = action.doc ? settleDesign(storedDesignOf(action.doc.graph.design, action.doc.graph.layout), action.doc) : designOf(d);
        const status: DocStatus = action.doc ? { kind: 'ready', doc: action.doc } : d.status;
        const out: OpenDocument = {
          ...d, status, stored, restored: false, saving: false, errors: n === 0 ? null : action.errors,
          design: historyOf(stored.draft), edits: stored.edits,
          name: action.doc?.graph.workflow.name ?? d.name, version: action.doc?.graph.workflow.version ?? d.version,
        };
        return { ...out, picks: prunedPicks(out, stored.draft) };
      });
      return { ...next, output: [...next.output, { at: action.at, workflowId: action.workflowId, name: doc.name, text: action.doc ? text : `${text} (the workflow could not be read again)` }] };
    }
    case 'saveFailed': {
      const doc = state.docs.find((d) => d.workflowId === action.workflowId);
      if (!doc) return state;
      const next = update(state, action.workflowId, (d) => ({ ...d, saving: false }));
      return { ...next, output: [...next.output, { at: action.at, workflowId: action.workflowId, name: doc.name, text: `Not saved: ${action.message}` }] };
    }
    case 'retry':
      return update(state, action.workflowId, (d) => (d.status.kind !== 'failed' ? d : { ...d, status: { kind: 'loading' } }));
  }
}

/** The design as it stands: the canvas draft and the entity edits. */
export const designOf = (d: OpenDocument): Design => ({ draft: d.design.draft, edits: d.edits });

/** The design differs from the last saved one (spec §3.2): the tab is marked, closing asks, the session keeps it. */
export const designDirty = (d: OpenDocument): boolean => (d.stored === null ? d.restored : !sameDesign(designOf(d), d.stored));

/** Save is offered (spec §4.1): the design differs from the stored one, or the stored one is not applied yet. */
export const canSave = (d: OpenDocument): boolean =>
  d.status.kind === 'ready' && !d.saving && d.stored !== null && (designDirty(d) || hasGraphChanges(d.stored));

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
