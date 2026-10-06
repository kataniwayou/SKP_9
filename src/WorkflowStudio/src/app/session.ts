import type { SavedView } from '../canvas/savedView';
import { parseLayout, type SavedLayout } from '../dock/layoutPersistence';
import type { Selection } from '../store/selection';
import { INITIAL_STATE, type StudioState } from '../store/studioState';

/**
 * The page as the user left it (spec §6.1, amended 2026-10-06): a refresh keeps the open documents,
 * the dock and each document's selection and view. One localStorage entry, separate from Window ›
 * Save's named layout. Documents are fetched again on load: only where things were is kept.
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

/** The session for the current state: views of documents that are no longer open are dropped. */
export function sessionOf(state: StudioState, views: ReadonlyMap<string, SavedView>, dock: SavedLayout | null): Session {
  return {
    version: SESSION_VERSION,
    docs: state.docs.map((d) => ({ workflowId: d.workflowId, name: d.name, version: d.version, selection: d.selection, view: views.get(d.workflowId) ?? null })),
    activeId: state.activeId,
    showDetails: state.showDetails,
    dock,
  };
}

/** The store's first state: every document from the session, loading again, with its selection. */
export function restoredState(session: Session | null): StudioState {
  if (session === null) return INITIAL_STATE;
  return {
    docs: session.docs.map((d) => ({ workflowId: d.workflowId, name: d.name, version: d.version, status: { kind: 'loading' }, selection: d.selection })),
    activeId: session.activeId,
    showDetails: session.showDetails,
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

function isView(value: unknown): value is SavedView {
  const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
  return isRecord(value) && finite(value.x) && finite(value.y) && finite(value.zoom) && (value.zoom as number) > 0 && typeof value.followFit === 'boolean';
}
