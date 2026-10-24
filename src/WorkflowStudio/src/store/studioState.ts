import { autoConnect, type Dir } from '../design/autoConnect';
import type { StudioDocument } from '../app/document';
import type { EntityReadDto } from '../api/entities';
import type { LiveStatus } from '../api/liveStatus';
import type { Cache, DesignError, Id, Processor, Schema } from '../model/graph';
import {
  createAssignment, EMPTY_DESIGN, EMPTY_EDITS, hasGraphChanges, removeAssignment, revertEntity, sameDesign, setField, storedDesignOf, withAssignmentOp,
  type Design, type EntityEdits, type FieldValue,
} from '../design/design';
import { circuitOf, type Draft } from '../design/draft';
import { applyBlocks } from '../design/blocks';
import { copyClip, deletePicked, pasteClip, type Clip } from '../design/clipboard';
import { dropTool, type ToolItem } from '../design/toolDrop';
import type { Point } from '../layout/geometry';
import { commit, commitAssignment, historyOf, isAssignmentStep, redo, redoStepOf, undo, undoStepOf, type DesignHistory, type HistoryStep } from '../design/history';
import { settleDesign } from '../design/settle';
import { applyEdits } from '../design/apply';
import { keepJunctions } from '../design/keepJunctions';
import { isShortCircuitError } from '../design/shortCircuits';
import { CACHE_NODE_PREFIX, SPHERE_NODE_ID } from '../layout/nodeIds';
import { EMPTY_INSPECTOR, type InspectorState } from './inspector';
import { editBaseOf } from './inspectorBase';
import { currentTarget, editTargetOf, rootTarget, targetKey, type InspectorTarget } from './inspectorTarget';
import { picksOf, samePicks, type Pick } from './picks';
import { selectionKey, type Selection } from './selection';
import { appendOutput, capLine, type LineDraft, type OutputLine } from './output';
import { RUN_TIMEOUT_MS, RUN_WORD, type RunOp, type RunState } from './run';
import { saveAnswerLines, settleReport, type DesignLogLine } from './saveLog';

export type { OutputLine } from './output';

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
  /** The Inspector's part of the design (plan 8): entity edits, assignment operations, schema copies. Only creating or removing an assignment is in the undo history (2026-10-23). */
  edits: EntityEdits;
  /** The last Save's errors (plan 8 §4.1); null: no Save answered with errors since it was opened, saved or discarded. */
  errors: DesignError[] | null;
  /** The last saved design (plan 8 §3.1): the stored design read back with the graph; null until it is loaded. */
  stored: Design | null;
  /** The session brought unsaved design edits back: loading keeps them instead of the stored design. */
  restored: boolean;
  /** A Save is in flight: the design is read-only (spec §4.1). */
  saving: boolean;
  /** A Start or Stop being sent or waiting for the live set (2026-10-09); not kept across a refresh. */
  run: RunState | null;
  /**
   * Counts the times the workflow was read from BaseApi (opened, or read again after a Save). The Inspector's read of
   * the shown entity belongs to one; a newer one makes it read the entity again (2026-10-10: after a Save it showed the
   * values from before).
   */
  generation: number;
  /**
   * A new workflow (2026-10-10, Workflow › New workflow): it exists only in the studio until its first Save creates it in
   * BaseApi. Its document is built locally, never read; Start, Stop and Delete workflow wait for that Save. Absent: false.
   */
  virtual?: boolean;
}

/**
 * The studio's shared state. The page keeps it in its session (app/session.ts), so a refresh brings it back
 * (spec §6.1); a document's unsaved design comes back with it (plan 8 §3.2).
 */
export interface StudioState {
  /** In the order they were opened. */
  docs: OpenDocument[];
  /** The document the shared panes (Inspector, Output's pinned problems) follow: the one last activated. */
  activeId: Id | null;
  /** The Inspector's one "▸ show all" switch, shared by every entity (spec §7). */
  showDetails: boolean;
  /** Output (2026-10-09): what Save, Start and Stop did, oldest first, the last OUTPUT_LIMIT lines; kept in the session. */
  output: OutputLine[];
  /** What Ctrl+C last copied, in any document (2026-10-10); Ctrl+V pastes it into the active one. Kept in the session. */
  clipboard: Clip | null;
  /**
   * The Toolbox's one picked tile (2026-10-11): an existing processor or cache the Inspector shows read-only, whatever
   * document is active. A click on a canvas (a selection or a pick there) or a drop clears it. Not kept in the session.
   */
  toolboxPick: ToolboxPick | null;
}

/** An existing processor (with the schemas its slots name) or cache picked in the Toolbox: a snapshot of its list entry. */
export type ToolboxPick =
  | { kind: 'processor'; processor: Processor; schemas: Schema[] }
  | { kind: 'cache'; cache: Cache };

export type StudioAction =
  | { type: 'open'; workflowId: Id; name: string; version: string }
  /** Workflow › New workflow (2026-10-10): a new workflow's document, ready at once and active; nothing in BaseApi yet. */
  | { type: 'new'; workflowId: Id; doc: StudioDocument }
  | { type: 'loaded'; workflowId: Id; doc: StudioDocument }
  | { type: 'failed'; workflowId: Id; message: string }
  | { type: 'close'; workflowId: Id }
  /**
   * BaseApi deleted the workflow (2026-10-10): its document closes, its draft dropped with it, and Output keeps the
   * deletion's lines under its name. The clipboard keeps what was copied from it.
   */
  | { type: 'workflowDeleted'; workflowId: Id; name: string; lines: LineDraft[] }
  | { type: 'activate'; workflowId: Id }
  /** `picks`: what the canvas picked with it; absent, the selection's own block (or nothing). */
  | { type: 'select'; workflowId: Id; selection: Selection | null; picks?: Pick[] }
  /** Picks only (a drag of a block that was not picked): the Inspector is untouched. */
  | { type: 'pick'; workflowId: Id; picks: Pick[] }
  /** A finished design gesture (spec §5.3); `merge` joins a run of the same kind into one step. */
  | { type: 'design'; workflowId: Id; draft: Draft; merge?: string; picks?: Pick[] }
  | { type: 'undo'; workflowId: Id }
  | { type: 'redo'; workflowId: Id }
  | { type: 'toggleDetails' }
  | { type: 'drill'; workflowId: Id; target: InspectorTarget }
  /** Keeps the first `depth` drill-downs (0: back to the selection). */
  | { type: 'back'; workflowId: Id; depth: number }
  /** `gen`: the document generation the read was made in (absent: the current one); an older read is dropped. */
  | { type: 'read'; workflowId: Id; key: string; gen?: number; result: { ok: true; dto: EntityReadDto } | { ok: false; message: string } }
  /** A field typed into the shown entity: a design edit (spec §3.3). `copyId` names a schema copy if this edit makes one. */
  | { type: 'editField'; workflowId: Id; key: string; value: FieldValue; copyId: string }
  /** Drops the shown entity's design edits. */
  | { type: 'revertEntity'; workflowId: Id }
  /** Creates a step's assignment in the design and shows it. */
  | { type: 'createAssignment'; workflowId: Id; stepId: Id; stepName: string; id: Id }
  /** Removes a step's assignment in the design. */
  | { type: 'removeAssignment'; workflowId: Id; stepId: Id }
  | { type: 'saving'; workflowId: Id }
  /** Empties Output's log for every workflow (2026-10-10); the pinned problems are live state and stay. */
  | { type: 'clearOutput' }
  /** Lines for Output, about this workflow (e.g. "Save started"). */
  | { type: 'log'; workflowId: Id; lines: LineDraft[] }
  /**
   * BaseApi's answer to a Save, with the document read again (null: the re-read failed, `reread` says why).
   * `held`: links of sources a short circuit holds back, which Save did not write (plan 9 §7). `log`: BaseApi's
   * own account (null or absent: it sent none).
   */
  | { type: 'saveAnswered'; workflowId: Id; at: string; applied: boolean; errors: DesignError[]; doc: StudioDocument | null; held?: number; log?: DesignLogLine[] | null; reread?: string }
  /** A Save that never got an answer (400, network): nothing was stored. */
  | { type: 'saveFailed'; workflowId: Id; at: string; message: string }
  /** A failed document goes back to loading. */
  | { type: 'retry'; workflowId: Id }
  /**
   * A workflow started or stopped (2026-10-10: the liveness store says so, for every workflow, open or not). Output logs
   * "<name> running" / "<name> stopped"; an open document's Start or Stop waiting for it is done.
   */
  | { type: 'liveChanged'; workflowId: Id; name: string; running: boolean; at: string }
  /** Start or Stop pressed; `note` is a line Output gets first (the drawing is not what runs). */
  | { type: 'runRequested'; workflowId: Id; op: RunOp; token: string; at: string; note?: string }
  /** BaseApi's answer to Start or Stop: accepted (202), or refused with why. `live`: the workflow's status as it lands. */
  | { type: 'runAnswered'; workflowId: Id; token: string; at: string; ok: boolean; message?: string; live: LiveStatus }
  /** An accepted Start or Stop the live set has not agreed with in RUN_TIMEOUT_MS. */
  | { type: 'runTimeout'; workflowId: Id; token: string; at: string }
  /** Ctrl+C on a document's canvas (2026-10-10): its picks become the clipboard (the hub is skipped). */
  | { type: 'copy'; workflowId: Id }
  /** Ctrl+V: the clipboard pasted into this document with new ids (`newId`), one history step; the pasted items are picked. */
  | { type: 'paste'; workflowId: Id; newId: () => string }
  /**
   * A Toolbox tile dropped on this document's canvas at `at` (flow coordinates, 2026-10-11): a new step, cache or wire, an
   * existing cache linked, or an existing processor given to the step there. `roots`: every cache root BaseApi listed.
   */
  | { type: 'toolDrop'; workflowId: Id; item: ToolItem; at: Point; newId: () => string; roots?: readonly string[]; reach?: number }
  /** A click on an AutoConnect arrow (plan 10 phase 6): a new step there, or a wire to the step there; one history step. */
  | { type: 'autoConnect'; workflowId: Id; id: string; dir: Dir; newId: () => string }
  /** Delete: the picked steps, caches and wires leave the design (the hub is skipped), one history step. */
  | { type: 'deletePicks'; workflowId: Id }
  /** A Toolbox tile clicked (2026-10-11): the Inspector shows it read-only; null clears it. */
  | { type: 'toolboxPick'; pick: ToolboxPick | null };

export const INITIAL_STATE: StudioState = { docs: [], activeId: null, showDetails: false, output: [], clipboard: null, toolboxPick: null };

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
 * After undo or redo: the picks naming what the saved workflow with `draft` over it has.
 * A wire pick stays while the circuit has the wire. A document not ready keeps its picks.
 */
function prunedPicks(d: OpenDocument, draft: Draft): Pick[] {
  if (d.status.kind !== 'ready') return d.picks;
  // the workflow with this draft's pasted and deleted blocks (2026-10-10)
  const saved = applyBlocks(d.status.doc, draft.blocks);
  const wires = circuitOf(saved, draft);
  const exists = (p: Pick): boolean => {
    if (p.kind === 'node') {
      if (p.id === SPHERE_NODE_ID) return true;
      if (p.id.startsWith(CACHE_NODE_PREFIX)) return saved.placement.caches.has(p.id.slice(CACHE_NODE_PREFIX.length));
      return saved.placement.steps.has(p.id);
    }
    // a step's processor: while the step points at one (2026-10-10)
    if (p.kind === 'processor') return (saved.graph.steps.get(p.id)?.processorId ?? null) !== null;
    // a wire keeps its id for life (plan 9): its pick stays while the circuit has it
    return Object.hasOwn(wires, p.id);
  };
  const kept = d.picks.filter(exists);
  return kept.length === d.picks.length ? d.picks : kept;
}

/**
 * The Inspector's selection after the blocks changed (a paste, a delete, undo or redo, 2026-10-10): a step or cache the
 * workflow with `draft`'s blocks no longer has is shown no more (nothing selected, the Inspector back to its root).
 */
function prunedSelection(d: OpenDocument, draft: Draft): OpenDocument {
  if (d.status.kind !== 'ready' || d.selection === null) return d;
  const { graph } = applyBlocks(d.status.doc, draft.blocks);
  const s = d.selection;
  const there = s.kind === 'workflow' || (s.kind === 'cache' ? graph.caches.has(s.cacheId) : graph.steps.has(s.stepId));
  if (!there) return { ...d, selection: null, inspector: EMPTY_INSPECTOR };
  // a processor its step no longer points at (removed in the design, 2026-10-10): the Inspector shows the step
  if (s.kind === 'processor' && graph.steps.get(s.stepId)!.processorId !== s.processorId) {
    return { ...d, selection: { kind: 'step', stepId: s.stepId }, inspector: EMPTY_INSPECTOR };
  }
  return d;
}

const redesign = (d: OpenDocument, design: DesignHistory): OpenDocument =>
  design === d.design ? d : prunedSelection({ ...d, design, picks: prunedPicks(d, design.draft) }, design.draft);

/** A paste or a delete: one history step, the picks it leaves, and the Inspector on the one block picked (or nothing). */
/** A commit's draft with the junctions the router moved kept where they were drawn (the user's ruling, 2026-10-20). */
function keptDraft(d: OpenDocument, draft: Draft): Draft {
  return d.status.kind !== 'ready' ? draft : keepJunctions(applyEdits(d.status.doc, d.edits, draft.blocks), d.design.draft, draft);
}

function blocksChanged(d: OpenDocument, draft: Draft, picks: Pick[]): OpenDocument {
  if (d.status.kind !== 'ready') return d;
  const graph = applyBlocks(d.status.doc, draft.blocks).graph;
  const only = picks.length === 1 && picks[0]!.kind === 'node' ? picks[0]!.id : null;
  const selection: Selection | null = only === null ? null
    : only === SPHERE_NODE_ID ? { kind: 'workflow' }
      : only.startsWith(CACHE_NODE_PREFIX) ? { kind: 'cache', cacheId: only.slice(CACHE_NODE_PREFIX.length) }
        : graph.steps.has(only) ? { kind: 'step', stepId: only } : null;
  const moved: OpenDocument = { ...d, design: commit(d.design, keptDraft(d, draft)), picks };
  return selectionKey(selection) === selectionKey(d.selection) ? moved : { ...moved, selection, inspector: EMPTY_INSPECTOR };
}

/** The history with one more step: a step's assignment as `edits` leave it, after what `d` has (2026-10-23). */
const assignmentStepped = (d: OpenDocument, edits: EntityEdits, stepId: Id): DesignHistory =>
  commitAssignment(d.design, { assignment: { stepId, before: d.edits.assignments[stepId] ?? null, after: edits.assignments[stepId] ?? null } });

/** Whether the workflow, with this design, has no assignment for the step (removed, or never created). */
function noAssignment(d: OpenDocument, stepId: Id): boolean {
  const op = d.edits.assignments[stepId];
  if (op !== undefined) return op.op === 'delete';
  return d.status.kind !== 'ready' || !applyBlocks(d.status.doc, d.design.draft.blocks).graph.assignments.some((a) => a.stepId === stepId);
}

/** An Inspector showing a step's assignment the design no longer has goes back to the step. */
function leftAssignment(d: OpenDocument, stepId: Id): OpenDocument {
  const shown = shownTargetOf(d);
  const leave = shown?.kind === 'assignment' && shown.stepId === stepId && noAssignment(d, stepId);
  return leave ? { ...d, inspector: { ...EMPTY_INSPECTOR, trail: d.inspector.trail.slice(0, -1) } } : d;
}

/** After Undo (`before`) or Redo (`after`) of `step`: an assignment step puts that side's operation back. */
function stepped(d: OpenDocument, step: HistoryStep | null, side: 'before' | 'after'): OpenDocument {
  if (step === null || !isAssignmentStep(step)) return d;
  const { stepId } = step.assignment;
  return leftAssignment({ ...d, edits: withAssignmentOp(d.edits, stepId, step.assignment[side]) }, stepId);
}

/** Pure: every change to the studio's state goes through here. Unknown ids leave the state as it was. */
export function reduce(state: StudioState, action: StudioAction): StudioState {
  const next = reduceDocs(state, action);
  // a click on a canvas (a selection or a pick there) or a drop takes the Inspector back from the Toolbox (2026-10-11)
  return next.toolboxPick !== null && (action.type === 'select' || action.type === 'pick' || action.type === 'toolDrop')
    ? { ...next, toolboxPick: null } : next;
}

function reduceDocs(state: StudioState, action: StudioAction): StudioState {
  switch (action.type) {
    case 'toolboxPick':
      return state.toolboxPick === action.pick ? state : { ...state, toolboxPick: action.pick };
    case 'open': {
      if (state.docs.some((d) => d.workflowId === action.workflowId)) return { ...state, activeId: action.workflowId };
      const doc: OpenDocument = {
        workflowId: action.workflowId, name: action.name, version: action.version, status: { kind: 'loading' }, selection: null, inspector: EMPTY_INSPECTOR,
        picks: [], design: historyOf(), edits: EMPTY_EDITS, errors: null, stored: null, restored: false, saving: false,
        run: null, generation: 0,
      };
      return { ...state, docs: [...state.docs, doc], activeId: action.workflowId };
    }
    case 'new': {
      if (state.docs.some((d) => d.workflowId === action.workflowId)) return { ...state, activeId: action.workflowId };
      const w = action.doc.graph.workflow;
      const doc: OpenDocument = {
        workflowId: action.workflowId, name: w.name, version: w.version, status: { kind: 'ready', doc: action.doc },
        selection: null, inspector: EMPTY_INSPECTOR, picks: [], design: historyOf(), edits: EMPTY_EDITS, errors: null,
        stored: EMPTY_DESIGN, restored: false, saving: false, run: null, generation: 1, virtual: true,
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
          // its Undo and Redo steps from the session stay (the user's ruling, 2026-10-20)
          : settled === d.design.draft ? {} : { design: { ...d.design, draft: settled, merge: null } };
        return { ...d, ...design, name: action.doc.graph.workflow.name, version: action.doc.graph.workflow.version, status: { kind: 'ready', doc: action.doc }, stored, restored: false, generation: d.generation + 1 };
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
    case 'workflowDeleted': {
      const closed = reduce(state, { type: 'close', workflowId: action.workflowId });
      return logged(closed, action.workflowId, action.name, action.lines);
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
      return update(state, action.workflowId, (d) => (designLocked(d) ? d : {
        ...d, design: commit(d.design, keptDraft(d, action.draft), action.merge ?? null), picks: action.picks ?? d.picks,
      }));
    case 'undo':
      return update(state, action.workflowId, (d) => (designLocked(d) ? d : stepped(redesign(d, undo(d.design)), undoStepOf(d.design), 'before')));
    case 'redo':
      return update(state, action.workflowId, (d) => (designLocked(d) ? d : stepped(redesign(d, redo(d.design)), redoStepOf(d.design), 'after')));
    case 'toggleDetails':
      return { ...state, showDetails: !state.showDetails };
    case 'drill':
      return inspect(state, action.workflowId, (i) => ({ ...EMPTY_INSPECTOR, trail: [...i.trail, action.target] }));
    case 'back':
      return inspect(state, action.workflowId, (i) => (action.depth >= i.trail.length ? i : { ...EMPTY_INSPECTOR, trail: i.trail.slice(0, Math.max(0, action.depth)) }));
    case 'read':
      // the key check is what drops a read for an entity no longer shown
      return inspect(state, action.workflowId, (i, d) => {
        const gen = action.gen ?? d.generation;
        if (targetKey(shownTargetOf(d)) !== action.key || gen < d.generation) return i;
        // a failed re-read keeps the form it had, with a note (spec §8); with nothing read, only why
        if (!action.result.ok) return { ...i, saved: i.saved?.key === action.key ? i.saved : null, readError: action.result.message };
        return { ...i, saved: { key: action.key, dto: action.result.dto, gen }, readError: null };
      });
    case 'editField':
      return update(state, action.workflowId, (d) => {
        const target = shownTargetOf(d);
        if (designLocked(d) || target === null || d.status.kind !== 'ready') return d;
        // judged against what the form shows: the graph's entity (its stamp too), the read only of this generation; a
        // pasted step or cache is the graph's like any other (2026-10-10)
        const graph = applyBlocks(d.status.doc, d.design.draft.blocks).graph;
        const base = editBaseOf(graph, target, d.inspector.saved, targetKey(target), d.generation);
        if (base === null) return d;
        return { ...d, edits: setField(d.edits, editTargetOf(target), base, action.key, action.value, () => action.copyId) };
      });
    case 'revertEntity':
      return update(state, action.workflowId, (d) => {
        const target = shownTargetOf(d);
        return designLocked(d) || target === null ? d : { ...d, edits: revertEntity(d.edits, editTargetOf(target)) };
      });
    case 'createAssignment':
      return update(state, action.workflowId, (d) => {
        if (designLocked(d)) return d;
        const edits = createAssignment(d.edits, action.stepId, action.stepName, action.id);
        const shown = edits.assignments[action.stepId]!;
        return { ...d, edits, design: assignmentStepped(d, edits, action.stepId), inspector: { ...EMPTY_INSPECTOR, trail: [...d.inspector.trail, { kind: 'assignment', id: shown.id, stepId: action.stepId }] } };
      });
    case 'removeAssignment':
      return update(state, action.workflowId, (d) => {
        if (designLocked(d)) return d;
        const base = d.status.kind === 'ready' ? applyBlocks(d.status.doc, d.design.draft.blocks).graph.assignments.find((a) => a.stepId === action.stepId) : undefined;
        const edits = removeAssignment(d.edits, action.stepId, base && { id: base.id, updatedAt: base.updatedAt });
        if (edits === d.edits) return d;
        return leftAssignment({ ...d, edits, design: assignmentStepped(d, edits, action.stepId) }, action.stepId);
      });
    case 'saving':
      return update(state, action.workflowId, (d) => (d.saving ? d : { ...d, saving: true }));
    case 'saveAnswered': {
      const doc = state.docs.find((d) => d.workflowId === action.workflowId);
      if (!doc) return state;
      const n = action.errors.length;
      // applied by BaseApi, the errors left are the design's short circuits (plan 9 §7), whose links were not written
      const shorts = action.errors.filter(isShortCircuitError).length;
      const read = action.doc ? storedDesignOf(action.doc.graph.design, action.doc.graph.layout) : null;
      const settled = read && action.doc ? settleDesign(read, action.doc) : null;
      const graph = action.doc?.graph;
      const lines = saveAnswerLines({
        applied: action.applied, errors: action.errors.filter((e) => !isShortCircuitError(e)), log: action.log ?? null,
        shorts, held: action.held ?? 0,
        reread: graph
          ? { ok: true, steps: graph.steps.size, links: graph.workflow.entryStepIds.length + [...graph.steps.values()].reduce((k, s) => k + s.nextStepIds.length, 0) }
          : doc.virtual && !action.applied ? { ok: false, created: false } : { ok: false, message: action.reread ?? 'no answer' },
        // compared on the workflow with the stored design's pasted and deleted blocks (2026-10-10), as the canvas draws it
        settle: read && settled && action.doc ? settleReport(applyBlocks(action.doc, read.draft.blocks), read.draft, settled.draft) : null,
        stored: graph?.design != null,
      });
      // a new workflow BaseApi did not create (2026-10-10): nothing was stored, so the design stays the studio's, unsaved
      if (doc.virtual && !(action.applied && action.doc)) {
        const kept = update(state, action.workflowId, (d) => ({ ...d, saving: false, errors: n === 0 ? null : action.errors }));
        return logged(kept, action.workflowId, doc.name, lines.map((l) => ({ at: action.at, ...l })));
      }
      const next = update(state, action.workflowId, (d) => {
        // either way the design is now stored on the workflow and the session's edits are cleared (spec §4.1)
        const stored = settled ?? designOf(d);
        const status: DocStatus = action.doc ? { kind: 'ready', doc: action.doc } : d.status;
        const out: OpenDocument = {
          ...d, status, stored, restored: false, saving: false, errors: n === 0 ? null : action.errors,
          // read again: the Inspector reads the shown entity anew (what BaseApi holds now)
          generation: action.doc ? d.generation + 1 : d.generation,
          design: historyOf(stored.draft), edits: stored.edits,
          name: action.doc?.graph.workflow.name ?? d.name, version: action.doc?.graph.workflow.version ?? d.version,
          // created by this Save: an ordinary workflow from now on
          virtual: false,
        };
        return { ...out, picks: prunedPicks(out, stored.draft) };
      });
      return logged(next, action.workflowId, doc.name, lines.map((l) => ({ at: action.at, ...l })));
    }
    case 'saveFailed': {
      const doc = state.docs.find((d) => d.workflowId === action.workflowId);
      if (!doc) return state;
      const next = update(state, action.workflowId, (d) => ({ ...d, saving: false }));
      return logged(next, action.workflowId, doc.name, [{ at: action.at, text: `Not saved: ${action.message}`, level: 'error' }]);
    }
    case 'clearOutput': {
      if (state.output.length === 0) return state;
      // a Save in progress keeps its "Save started" line, so its answer does not arrive headless
      const kept = state.docs.filter((d) => d.saving).flatMap((d) => {
        const head = state.output.findLast((l) => l.workflowId === d.workflowId && l.text.startsWith('Save started'));
        return head ? [head] : [];
      });
      return { ...state, output: state.output.filter((l) => kept.includes(l)) };
    }
    case 'log': {
      const doc = state.docs.find((d) => d.workflowId === action.workflowId);
      return doc ? logged(state, action.workflowId, doc.name, action.lines) : state;
    }
    case 'liveChanged': {
      // one line per change, whoever started it: a press's confirmation is this same line (2026-10-10)
      const lines = [{ at: action.at, text: action.running ? 'running' : 'stopped' }];
      // an accepted Start is done when the live set lists the workflow, an accepted Stop when it no longer does
      const next = update(state, action.workflowId, (d) => (d.run?.phase === 'waiting' && agrees(d.run.op, action.running) ? { ...d, run: null } : d));
      return logged(next, action.workflowId, action.name, lines);
    }
    case 'runRequested': {
      const doc = state.docs.find((d) => d.workflowId === action.workflowId);
      if (!doc || doc.run !== null) return state;
      const next = update(state, action.workflowId, (d) => ({ ...d, run: { op: action.op, phase: 'sending', token: action.token } }));
      const lines: LineDraft[] = action.note ? [{ at: action.at, text: action.note }] : [];
      lines.push({ at: action.at, text: `${RUN_WORD[action.op]} requested: POST /orchestration/${action.op} for the workflow BaseApi holds` });
      return logged(next, action.workflowId, doc.name, lines);
    }
    case 'runAnswered': {
      const doc = state.docs.find((d) => d.workflowId === action.workflowId);
      const run = doc?.run;
      if (!doc || !run || run.token !== action.token) return state;
      const word = RUN_WORD[run.op];
      if (!action.ok) {
        const next = update(state, action.workflowId, (d) => ({ ...d, run: null }));
        return logged(next, action.workflowId, doc.name, [{ at: action.at, text: `${word} refused by BaseApi: ${action.message ?? 'no reason given'}`, level: 'error' }]);
      }
      // the live set may already agree (its change came while the request was on its way): done, and already logged
      const seen = action.live === (run.op === 'start' ? 'running' : 'stopped');
      const next = update(state, action.workflowId, (d) => ({ ...d, run: seen ? null : { ...run, phase: 'waiting' } }));
      const wait = run.op === 'start' ? 'starting… waiting for the workflow to appear in the live set' : 'stopping… waiting for the workflow to leave the live set';
      return logged(next, action.workflowId, doc.name, [{ at: action.at, text: seen ? `${word} accepted by BaseApi (202)` : `${word} accepted by BaseApi (202): ${wait}` }]);
    }
    case 'runTimeout': {
      const doc = state.docs.find((d) => d.workflowId === action.workflowId);
      const run = doc?.run;
      if (!doc || !run || run.token !== action.token || run.phase !== 'waiting') return state;
      const next = update(state, action.workflowId, (d) => ({ ...d, run: null }));
      const after = `${Math.round(RUN_TIMEOUT_MS / 1000)} s`;
      const text = run.op === 'start'
        ? `Start accepted, but the workflow is not in the live set after ${after}: its start message may have been parked (BaseApi's known gap); the status shows what BaseApi says`
        : `Stop accepted, but the workflow is still in the live set after ${after}; the status shows what BaseApi says`;
      return logged(next, action.workflowId, doc.name, [{ at: action.at, text, level: 'error' }]);
    }
    case 'retry':
      return update(state, action.workflowId, (d) => (d.status.kind !== 'failed' ? d : { ...d, status: { kind: 'loading' } }));
    case 'copy': {
      const d = state.docs.find((x) => x.workflowId === action.workflowId);
      if (!d || d.status.kind !== 'ready') return state;
      const clip = copyClip(d.status.doc, d.edits, d.design.draft, d.picks, d.workflowId);
      return clip === null ? state : { ...state, clipboard: clip };
    }
    case 'paste': {
      const clip = state.clipboard;
      const d = state.docs.find((x) => x.workflowId === action.workflowId);
      if (!clip || !d || d.status.kind !== 'ready' || designLocked(d)) return state;
      const pasted = pasteClip(d.status.doc, d.edits, d.design.draft, clip, action.newId, d.workflowId);
      if (pasted === null) return state;
      // each further paste of the same clip starts one more 32 px step away (the cascade)
      const next = update(state, action.workflowId, (x) => blocksChanged(x, pasted.draft, pasted.picks));
      return { ...next, clipboard: { ...clip, pasted: clip.pasted + 1 } };
    }
    case 'toolDrop':
      return update(state, action.workflowId, (d) => {
        if (d.status.kind !== 'ready' || designLocked(d)) return d;
        const dropped = dropTool(d.status.doc, d.edits, d.design.draft, action.item, action.at, action.newId, action.reach);
        return dropped === null ? d : blocksChanged(d, dropped.draft, dropped.picks);
      });
    case 'autoConnect':
      return update(state, action.workflowId, (d) => {
        if (d.status.kind !== 'ready' || designLocked(d)) return d;
        const made = autoConnect(d.status.doc, d.edits, d.design.draft, action.id, action.dir, action.newId);
        return made === null ? d : blocksChanged(d, made.draft, made.picks);
      });
    case 'deletePicks':
      return update(state, action.workflowId, (d) => {
        if (d.status.kind !== 'ready' || designLocked(d)) return d;
        const r = deletePicked(d.status.doc, d.edits, d.design.draft, d.picks);
        return r === null ? d : prunedSelection(blocksChanged(d, r.draft, r.picks), r.draft);
      });
  }
}

/** The live set agrees with a press: a Start's workflow runs, a Stop's does not. */
const agrees = (op: RunOp, running: boolean): boolean => (op === 'start') === running;

/** The state with lines for one workflow appended to Output (bounded). */
function logged(state: StudioState, workflowId: Id, name: string, lines: readonly LineDraft[]): StudioState {
  if (lines.length === 0) return state;
  return { ...state, output: appendOutput(state.output, lines.map((l) => ({ at: l.at, workflowId, name, text: capLine(l.text), level: l.level ?? 'info' }))) };
}

/**
 * What Output says before a Start (2026-10-09): Start runs the workflow BaseApi holds, so a design not yet saved, or
 * saved but not applied, is not part of the run. Null when the drawing is what BaseApi holds.
 */
export function startNote(d: OpenDocument): string | null {
  if (designDirty(d)) return 'Started the saved workflow; your unsaved design is not part of this run';
  if (d.stored !== null && hasGraphChanges(d.stored)) return 'Started the saved workflow; the design stored on it is not applied, so it is not part of this run';
  return null;
}

/** The design as it stands: the canvas draft and the entity edits. */
export const designOf = (d: OpenDocument): Design => ({ draft: d.design.draft, edits: d.edits });

/** The design is read-only while a Save is in flight (2026-10-11). Selecting and viewing still work. */
export const designLocked = (d: { saving: boolean }): boolean => d.saving;

/** The design differs from the last saved one (spec §3.2): the tab is marked, closing asks, the session keeps it. */
/** A new workflow (2026-10-10) is unsaved until its first Save creates it, whatever its design holds. */
export const designDirty = (d: OpenDocument): boolean =>
  d.virtual === true || (d.stored === null ? d.restored : !sameDesign(designOf(d), d.stored));

/** Why Save is off on a design with nothing to store (the user's rule, 2026-10-22). */
export const NOTHING_TO_SAVE = 'Nothing changed since the last Save';

/**
 * Why Save cannot be pressed now, or null when it can: once the workflow is loaded and nothing is running on it, and
 * only when it has something to store (the user's rule, 2026-10-22, replacing 2026-10-11's "always"): the design differs
 * from the stored one, or the stored one is not applied yet.
 */
export function saveBlocked(d: OpenDocument): string | null {
  if (d.status.kind === 'failed') return 'The workflow could not be loaded';
  if (d.status.kind !== 'ready' || d.stored === null) return 'The workflow is still loading';
  if (d.saving) return 'Saving…';
  if (!hasChanges(d)) return NOTHING_TO_SAVE;
  return null;
}

/** Save is offered (spec §4.1; 2026-10-22: only with something to store). */
export const canSave = (d: OpenDocument): boolean => saveBlocked(d) === null;

/** Save has something new to store: the design differs from the stored one, or the stored one is not applied yet. */
export const hasChanges = (d: OpenDocument): boolean => d.stored !== null && (designDirty(d) || hasGraphChanges(d.stored));

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
