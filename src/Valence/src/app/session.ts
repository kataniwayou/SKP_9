import { parseLayout, type SavedLayout } from '../dock/layoutPersistence';
import type { CreatedAtom } from './virtual';
import type { Removed } from '../molecule/deletion';
import type { Change, EditChange, History } from './workspace';
import { parseView, type CanvasView } from '../molecule/view';

/**
 * The page as the user left it, as SKP Studio keeps its own (spec §6.1): a refresh keeps the dock, the highlighted
 * workflows, the pinned atom or arrow, and the virtual entities' unapplied edits and deletions with their history. Kept per tab in sessionStorage and mirrored to localStorage under the same key, to seed a new tab or a
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
  /** Deleted in Valence and not applied (spec §6). Optional, so the version stays 1. */
  removed?: Removed;
  /** The shared undo / redo history of edits and deletions (the user, 2026-10-16: kept on refresh). Optional. */
  history?: History;
  /** Made from the Toolbox, not applied (2026-10-17): atoms and drawn arrows. Optional, so the version stays 1. */
  created?: CreatedAtom[];
  added?: string[];
  /** The camera and every atom's place (the user, 2026-10-17: moved atoms were lost on a restart). Optional, so the version stays 1. */
  view?: CanvasView;
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
  const removed = isRecord(value.removed) ? { atoms: strings(value.removed.atoms), arrows: strings(value.removed.arrows) } : null;
  const view = parseView(value.view);
  const history = isRecord(value.history) ? { past: changes(value.history.past), future: changes(value.history.future) } : null;
  return {
    version: SESSION_VERSION, dock: parseLayout(value.dock), highlighted,
    ...(typeof value.pinned === 'string' ? { pinned: value.pinned } : {}),
    ...(Object.keys(edits).length ? { edits } : {}),
    ...(removed && (removed.atoms.length || removed.arrows.length) ? { removed } : {}),
    ...(history && (history.past.length || history.future.length) ? { history } : {}),
    ...(madeOf(value.created).length ? { created: madeOf(value.created) } : {}),
    ...(strings(value.added).length ? { added: strings(value.added) } : {}),
    ...(view ? { view } : {}),
  };
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x !== ''))] : []);
const fieldsOf = (v: unknown): Record<string, string> | null =>
  (isRecord(v) ? Object.fromEntries(Object.entries(v).filter((f): f is [string, string] => typeof f[1] === 'string')) : null);
/** The history's steps that are whole; a malformed one is dropped, not the history. */
function changes(v: unknown): Change[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((c): Change[] => {
    if (!isRecord(c) || typeof c.label !== 'string') return [];
    const edits = Array.isArray(c.edits)
      ? c.edits.flatMap((e): EditChange[] => (isRecord(e) && typeof e.key === 'string' ? [{ key: e.key, before: fieldsOf(e.before), after: fieldsOf(e.after) }] : []))
      : [];
    return [{
      label: c.label,
      ...(edits.length ? { edits } : {}),
      ...(Array.isArray(c.atoms) ? { atoms: strings(c.atoms) } : {}),
      ...(Array.isArray(c.arrows) ? { arrows: strings(c.arrows) } : {}),
      ...(typeof c.merge === 'string' ? { merge: c.merge } : {}),
      ...(madeOf(c.created).length ? { created: madeOf(c.created) } : {}),
      ...(madeOf(c.uncreated).length ? { uncreated: madeOf(c.uncreated) } : {}),
      ...(Array.isArray(c.added) ? { added: strings(c.added) } : {}),
      ...(Array.isArray(c.unadded) ? { unadded: strings(c.unadded) } : {}),
      ...(Array.isArray(c.restored) ? { restored: strings(c.restored) } : {}),
    }];
  });
}

const TYPES_MADE = new Set(['wf', 'step', 'proc', 'schema', 'asg', 'cache']);
/** The made atoms that are whole; a malformed one is dropped. */
function madeOf(v: unknown): CreatedAtom[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((c): CreatedAtom[] => (isRecord(c) && typeof c.key === 'string' && typeof c.id === 'string' && typeof c.type === 'string' && TYPES_MADE.has(c.type)
    && isRecord(c.row) && Array.isArray(c.pos) && c.pos.length === 3 && c.pos.every((n) => typeof n === 'number')
    ? [{ key: c.key, id: c.id, type: c.type as CreatedAtom['type'], row: c.row, pos: [c.pos[0], c.pos[1], c.pos[2]] as CreatedAtom['pos'] }] : []));
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
