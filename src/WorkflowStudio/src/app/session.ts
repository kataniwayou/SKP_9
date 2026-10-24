import type { SavedView } from '../canvas/savedView';
import { parseDraft, type Draft } from '../design/draft';
import { parseClip, type Clip } from '../design/clipboard';
import { EMPTY_EDITS, parseEdits, toOp, type EntityEdits } from '../design/design';
import { historyOf, type HistoryStep } from '../design/history';
import { parseLayout, type SavedLayout } from '../dock/layoutPersistence';
import { EMPTY_INSPECTOR, type InspectorDraft } from '../store/inspector';
import { parseOutput, type OutputLine } from '../store/output';
import { isTarget } from '../store/inspectorTarget';
import { picksOf } from '../store/picks';
import type { Selection } from '../store/selection';
import { designDirty, INITIAL_STATE, type StudioState } from '../store/studioState';

/**
 * The page as the user left it (spec §6.1, amended 2026-10-06): a refresh keeps the open documents,
 * the dock and each document's selection and view. The session is kept per tab, in sessionStorage
 * (it survives a refresh and is not shared between tabs), and every write is mirrored to
 * localStorage under the same key, to seed a new tab or a browser restart. Separate from Window ›
 * Save's named layout. Documents are fetched again on load: where things were is kept, and the
 * unsaved design (plan 8 §3.2). A new workflow's document (2026-10-10) is built again locally, with its design.
 */
export const SESSION_KEY = 'skp.studio.session';
export const SESSION_VERSION = 1;

export interface SessionDoc {
  workflowId: string;
  name: string;
  version: string;
  selection: Selection | null;
  /** null: the view still followed Fit, or was never reported; the document is fitted on restore. */
  view: SavedView | null;
  /** Where the document's Inspector was drilled to (slice 3b): absent at the selection itself. Optional, so the version stays 1. */
  draft?: InspectorDraft;
  /** The document's unsaved design draft (plan 4, plan 8): absent while the design is the stored one. Optional, so the version stays 1. */
  design?: Draft;
  /** The unsaved entity edits (plan 8): absent when there are none. */
  edits?: EntityEdits;
  /**
   * The design's Undo and Redo steps (the user's ruling, 2026-10-20: Undo survives a refresh), oldest first; `design`
   * is then the draft they lead to. Absent when there are none. Optional, so the version stays 1.
   */
  history?: { past: HistoryStep[]; future: HistoryStep[] };
  /** A new workflow BaseApi does not have yet (2026-10-10): built again locally, never read. Absent: an ordinary one. */
  virtual?: true;
}

export interface Session {
  version: typeof SESSION_VERSION;
  docs: SessionDoc[];
  activeId: string | null;
  showDetails: boolean;
  /** The dock with its documents (`captureLayout(…, { keepDocuments: true })`); null: the page's default. */
  dock: SavedLayout | null;
  /** Output's lines (2026-10-09), so a refresh keeps them. Optional, so the version stays 1. */
  output?: OutputLine[];
  /** The studio's clipboard (2026-10-10), so a refresh keeps it. Optional, so the version stays 1. */
  clipboard?: Clip;
}

export function readSession(storage: Storage | null): Session | null {
  let text: string | null;
  try {
    text = storage?.getItem(SESSION_KEY) ?? null;
  } catch {
    return null;
  }
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.version !== SESSION_VERSION) return null;
  const docs: SessionDoc[] = [];
  for (const d of Array.isArray(value.docs) ? value.docs : []) {
    if (!isRecord(d) || typeof d.workflowId !== 'string' || typeof d.name !== 'string' || typeof d.version !== 'string') continue;
    if (docs.some((x) => x.workflowId === d.workflowId)) continue;
    docs.push({
      workflowId: d.workflowId, name: d.name, version: d.version,
      selection: isSelection(d.selection) ? d.selection : null,
      view: isView(d.view) ? d.view : null,
      ...(isDraft(d.draft) ? { draft: { trail: d.draft.trail } } : {}),
      ...designParts(d.design, d.edits),
      ...historyPart(d.history),
      ...(d.virtual === true ? { virtual: true as const } : {}),
    });
  }
  const activeId = typeof value.activeId === 'string' && docs.some((d) => d.workflowId === value.activeId)
    ? value.activeId : docs[0]?.workflowId ?? null;
  const output = parseOutput(value.output);
  const clipboard = parseClip(value.clipboard);
  return {
    version: SESSION_VERSION, docs, activeId, showDetails: value.showDetails === true, dock: parseLayout(value.dock),
    ...(output.length > 0 ? { output } : {}), ...(clipboard !== null ? { clipboard } : {}),
  };
}

/** False when the browser refuses (quota, blocked storage); never throws. */
export function writeSession(storage: Storage | null, session: Session): boolean {
  if (!storage) return false;
  try {
    storage.setItem(SESSION_KEY, JSON.stringify(session));
    return true;
  } catch {
    return false;
  }
}

/** `window.sessionStorage` (this tab's storage), or null where reading it throws (blocked storage, sandboxed frames). */
export function browserTabStorage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** Whether the storage holds a session entry; a storage that cannot be read holds none. */
function holdsSession(storage: Storage | null): boolean {
  try {
    return storage?.getItem(SESSION_KEY) != null;
  } catch {
    return false;
  }
}

/**
 * This tab's session: the tab's own entry when it has one (a refresh), else the mirror (a new tab,
 * a browser restart). A tab entry that cannot be used is no session; the mirror, another tab's
 * last write, is not read in its place. Never throws.
 */
export function readTabSession(tab: Storage | null, mirror: Storage | null): Session | null {
  return readSession(holdsSession(tab) ? tab : mirror);
}

/**
 * Writes the session to the tab and mirrors it. True when the next refresh will find it: the tab
 * took it, or the tab holds no entry (or there is no tab storage) and the mirror took it. Never throws.
 */
export function writeTabSession(tab: Storage | null, mirror: Storage | null, session: Session): boolean {
  const mirrored = writeSession(mirror, session);
  // a tab that refused the write is read again only if it already holds an (older) entry
  return writeSession(tab, session) || (mirrored && !holdsSession(tab));
}

/**
 * Writes the session as `writeTabSession` does; when the browser refuses it (quota), writes it again with Output's log
 * trimmed to its last 100 lines, then with no log, so the documents, dock and drafts are kept before the log.
 */
export function keepSession(tab: Storage | null, mirror: Storage | null, session: Session): boolean {
  if (writeTabSession(tab, mirror, session)) return true;
  // the Undo history before Output's log: its last steps first, then none (the drafts themselves are always kept)
  if (session.docs.some((d) => d.history) && writeTabSession(tab, mirror, withHistory(session, SHORT_HISTORY))) return true;
  session = withHistory(session, SHORT_HISTORY);
  const output = session.output ?? [];
  if (output.length > 100 && writeTabSession(tab, mirror, { ...session, output: output.slice(-100) })) return true;
  if (output.length === 0) return false;
  const { output: _, ...without } = session;
  return writeTabSession(tab, mirror, without) || writeTabSession(tab, mirror, withHistory(without, 0));
}

/** How many Undo and Redo steps a document keeps in a session the browser found too big. */
const SHORT_HISTORY = 20;

/** Each document's Undo history cut to its last `depth` steps back and forth (0: none). */
function withHistory(session: Session, depth: number): Session {
  return {
    ...session,
    docs: session.docs.map((d) => {
      if (!d.history) return d;
      const { history, ...rest } = d;
      return depth === 0 ? rest : { ...rest, history: { past: history.past.slice(-depth), future: history.future.slice(0, depth) } };
    }),
  };
}

/** The session for the current state: views of documents that are no longer open are dropped. */
export function sessionOf(state: StudioState, views: ReadonlyMap<string, SavedView>, dock: SavedLayout | null): Session {
  return {
    version: SESSION_VERSION,
    docs: state.docs.map((d) => ({
      workflowId: d.workflowId, name: d.name, version: d.version, selection: d.selection, view: views.get(d.workflowId) ?? null,
      ...(d.inspector.trail.length > 0 ? { draft: { trail: d.inspector.trail } } : {}),
      ...(designDirty(d) ? { design: d.design.draft, edits: d.edits } : {}),
      // with Undo or Redo steps the draft they lead to is kept too, unsaved or not
      ...(d.design.past.length > 0 || d.design.future.length > 0
        ? { design: d.design.draft, history: { past: d.design.past, future: d.design.future } } : {}),
      ...(d.virtual === true ? { virtual: true as const } : {}),
    })),
    activeId: state.activeId,
    showDetails: state.showDetails,
    dock,
    ...(state.output.length > 0 ? { output: state.output } : {}),
    ...(state.clipboard !== null ? { clipboard: state.clipboard } : {}),
  };
}

/** The store's first state: every document from the session, loading again, with its selection. */
export function restoredState(session: Session | null): StudioState {
  if (session === null) return INITIAL_STATE;
  return {
    docs: session.docs.map((d) => ({ workflowId: d.workflowId, name: d.name, version: d.version, status: { kind: 'loading' }, selection: d.selection,
      inspector: { ...EMPTY_INSPECTOR, trail: d.draft?.trail ?? [] },
      picks: picksOf(d.selection),
      design: { ...historyOf(d.design), past: d.history?.past ?? [], future: d.history?.future ?? [] },
      edits: d.edits ?? EMPTY_EDITS,
      stored: null,
      restored: d.design !== undefined || d.edits !== undefined,
      saving: false,
      errors: null,
      run: null,
      generation: 0,
      ...(d.virtual === true ? { virtual: true } : {}),
    })),
    activeId: session.activeId,
    showDetails: session.showDetails,
    output: session.output ?? [],
    clipboard: session.clipboard ?? null,
    toolboxPick: null,
  };
}

/** Coalesces writes: `schedule` writes 300 ms after the last call; `flush` writes a pending one now. */
export function createSaver(write: () => void, delayMs = 300): { schedule(): void; flush(): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { clearTimeout(timer); timer = undefined; };
  return {
    schedule() { cancel(); timer = setTimeout(() => { timer = undefined; write(); }, delayMs); },
    flush() { if (timer === undefined) return; cancel(); write(); },
    cancel,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSelection(value: unknown): value is Selection {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'workflow': return true;
    case 'step': return typeof value.stepId === 'string';
    case 'processor': return typeof value.processorId === 'string' && typeof value.stepId === 'string';
    case 'cache': return typeof value.cacheId === 'string';
    default: return false;
  }
}

function isDraft(value: unknown): value is InspectorDraft {
  return isRecord(value) && Array.isArray(value.trail) && value.trail.every(isTarget);
}

function designParts(design: unknown, edits: unknown): { design?: Draft; edits?: EntityEdits } {
  const draft = parseDraft(design);
  const parsed = parseEdits(edits);
  return { ...(draft !== null ? { design: draft } : {}), ...(parsed !== null ? { edits: parsed } : {}) };
}

/** One Undo step as the session kept it: a draft, or creating or removing an assignment (2026-10-23); null when it is neither. */
function parseStep(value: unknown): HistoryStep | null {
  if (!isRecord(value) || !Object.hasOwn(value, 'assignment')) return parseDraft(value);
  const a = value.assignment;
  if (!isRecord(a) || typeof a.stepId !== 'string' || a.stepId === '') return null;
  const side = (v: unknown) => (v === null ? null : toOp(v));
  const before = side(a.before), after = side(a.after);
  if ((a.before !== null && before === null) || (a.after !== null && after === null)) return null;
  return { assignment: { stepId: a.stepId, before, after } };
}

function historyPart(value: unknown): { history?: { past: HistoryStep[]; future: HistoryStep[] } } {
  if (!isRecord(value) || !Array.isArray(value.past) || !Array.isArray(value.future)) return {};
  const steps = (list: unknown[]) => list.map(parseStep).filter((x): x is HistoryStep => x !== null);
  const past = steps(value.past), future = steps(value.future);
  return past.length > 0 || future.length > 0 ? { history: { past, future } } : {};
}

function isView(value: unknown): value is SavedView {
  const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
  const size = (n: unknown) => n === undefined || (finite(n) && (n as number) > 0);
  return isRecord(value) && finite(value.x) && finite(value.y) && finite(value.zoom) && (value.zoom as number) > 0 && typeof value.followFit === 'boolean'
    && size(value.width) && size(value.height);
}
