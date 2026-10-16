import { parseLayout, type SavedLayout } from '../dock/layoutPersistence';

/**
 * The page as the user left it, as SKP Studio keeps its own (spec §6.1): a refresh keeps the dock, the highlighted
 * workflows, the pinned atom and the virtual entities' unapplied edits. Kept per tab in sessionStorage and mirrored to localStorage under the same key, to seed a new tab or a
 * browser restart. Valence's own key, so its session and SKP Studio's never mix.
 */
export const SESSION_KEY = 'skp.valence.session';
export const SESSION_VERSION = 1;

export interface Session {
  version: typeof SESSION_VERSION;
  /** The dock with its document (`captureLayout(…, { keepDocuments: true })`); null: the page's default. */
  dock: SavedLayout | null;
  /** The workflows the multi-select highlights, by id. */
  highlighted: string[];
  /** The atom pinned in the Inspector. Optional, so the version stays 1. */
  pinned?: string | null;
  /** The virtual entities' edits, not applied (decision 8): field texts by atom key. Optional, so the version stays 1. */
  edits?: Record<string, Record<string, string>>;
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
  const highlighted = Array.isArray(value.highlighted)
    ? [...new Set(value.highlighted.filter((id): id is string => typeof id === 'string' && id !== ''))] : [];
  const edits: Record<string, Record<string, string>> = {};
  if (isRecord(value.edits)) {
    for (const [key, fields] of Object.entries(value.edits)) {
      if (!isRecord(fields)) continue;
      const kept = Object.fromEntries(Object.entries(fields).filter((f): f is [string, string] => typeof f[1] === 'string'));
      if (Object.keys(kept).length) edits[key] = kept;
    }
  }
  return {
    version: SESSION_VERSION, dock: parseLayout(value.dock), highlighted,
    ...(typeof value.pinned === 'string' ? { pinned: value.pinned } : {}),
    ...(Object.keys(edits).length ? { edits } : {}),
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
 * This tab's session: the tab's own entry when it has one (a refresh), else the mirror (a new tab, a browser restart).
 * A tab entry that cannot be used is no session; the mirror is not read in its place. Never throws.
 */
export function readTabSession(tab: Storage | null, mirror: Storage | null): Session | null {
  return readSession(holdsSession(tab) ? tab : mirror);
}

/**
 * Writes the session to the tab and mirrors it. True when the next refresh will find it: the tab took it, or the tab
 * holds no entry (or there is no tab storage) and the mirror took it. Never throws.
 */
export function writeTabSession(tab: Storage | null, mirror: Storage | null, session: Session): boolean {
  const mirrored = writeSession(mirror, session);
  return writeSession(tab, session) || (mirrored && !holdsSession(tab));
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
