import type { SavedView } from '../canvas/savedView';
import { parseDraft, type Draft } from '../design/draft';
import { EMPTY_EDITS, parseEdits, type EntityEdits } from '../design/design';
import { historyOf } from '../design/history';
import { parseLayout, type SavedLayout } from '../dock/layoutPersistence';
import { EMPTY_INSPECTOR, type InspectorDraft } from '../store/inspector';
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
 * unsaved design (plan 8 §3.2).
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
}

export interface Session {
  version: typeof SESSION_VERSION;
  docs: SessionDoc[];
  activeId: string | null;
  showDetails: boolean;
  /** The dock with its documents (`captureLayout(…, { keepDocuments: true })`); null: the page's default. */
  dock: SavedLayout | null;
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
    });
  }
  const activeId = typeof value.activeId === 'string' && docs.some((d) => d.workflowId === value.activeId)
    ? value.activeId : docs[0]?.workflowId ?? null;
  return { version: SESSION_VERSION, docs, activeId, showDetails: value.showDetails === true, dock: parseLayout(value.dock) };
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

/** The session for the current state: views of documents that are no longer open are dropped. */
export function sessionOf(state: StudioState, views: ReadonlyMap<string, SavedView>, dock: SavedLayout | null): Session {
  return {
    version: SESSION_VERSION,
    docs: state.docs.map((d) => ({
      workflowId: d.workflowId, name: d.name, version: d.version, selection: d.selection, view: views.get(d.workflowId) ?? null,
      ...(d.inspector.trail.length > 0 ? { draft: { trail: d.inspector.trail } } : {}),
      ...(designDirty(d) ? { design: d.design.draft, edits: d.edits } : {}),
    })),
    activeId: state.activeId,
    showDetails: state.showDetails,
    dock,
  };
}

/** The store's first state: every document from the session, loading again, with its selection. */
export function restoredState(session: Session | null): StudioState {
  if (session === null) return INITIAL_STATE;
  return {
    docs: session.docs.map((d) => ({ workflowId: d.workflowId, name: d.name, version: d.version, status: { kind: 'loading' }, selection: d.selection,
      inspector: { ...EMPTY_INSPECTOR, trail: d.draft?.trail ?? [] },
      picks: picksOf(d.selection),
      design: historyOf(d.design),
      edits: d.edits ?? EMPTY_EDITS,
      stored: null,
      restored: d.design !== undefined || d.edits !== undefined,
      saving: false,
      errors: null,
    })),
    activeId: session.activeId,
    showDetails: session.showDetails,
    output: [],
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

function isView(value: unknown): value is SavedView {
  const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
  return isRecord(value) && finite(value.x) && finite(value.y) && finite(value.zoom) && (value.zoom as number) > 0 && typeof value.followFit === 'boolean';
}
