import { browserStorage } from '../dock/layoutPersistence';
import { browserTabStorage, createSaver } from '../app/session';
import type { OutputLevel } from '../store/output';
import type { ChatWire } from './kimi';

/** One thing the chat pane shows, oldest first (2026-10-23). */
export type ChatEntry =
  | { kind: 'user'; text: string }
  | { kind: 'model'; text: string }
  | { kind: 'action'; text: string; ok: boolean }                 // "+ step fetch with processor FileFetcher 1.2.0"
  | { kind: 'output'; text: string; level: OutputLevel; name: string } // an Output line, mirrored
  | { kind: 'problems'; lines: string[] }                          // the pinned problems after an action, when changed
  | { kind: 'note'; text: string; level: OutputLevel };            // "not configured", "cancelled", "lost at refresh"

/** A question the model put to the user: one button per choice. `pin`: the workflow id it names, kept with it so an answer after a tab switch or a refresh acts on that workflow. */
export interface Question { callId: string; text: string; choices: readonly string[]; warnings?: string[]; pin?: string }

export interface ChatState { entries: ChatEntry[]; wire: ChatWire[]; question: Question | null; busy: boolean }

export type ChatAction =
  | { type: 'entries'; add: ChatEntry[] } | { type: 'wire'; add: ChatWire[] } | { type: 'ask'; question: Question | null }
  | { type: 'busy'; on: boolean } | { type: 'newChat' };

export interface ChatStore {
  getState(): ChatState;
  dispatch(action: ChatAction): void;
  subscribe(listener: () => void): () => void;
  /** Writes a pending save now (the page is going away). */
  flush(): void;
}

/** The chat is kept per tab in sessionStorage, mirrored to localStorage, as the session is (app/session.ts). */
export const CHAT_KEY = 'skp.studio.chat';

export const EMPTY_CHAT: ChatState = { entries: [], wire: [], question: null, busy: false };

export const LOST_AT_REFRESH: ChatEntry = { kind: 'note', text: 'The request in flight was lost at refresh', level: 'error' };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isLevel = (v: unknown): v is OutputLevel => v === 'info' || v === 'error';

function parseEntry(v: unknown): ChatEntry | null {
  if (!isRecord(v)) return null;
  switch (v.kind) {
    case 'user': case 'model': return typeof v.text === 'string' ? { kind: v.kind, text: v.text } : null;
    case 'action': return typeof v.text === 'string' && typeof v.ok === 'boolean' ? { kind: 'action', text: v.text, ok: v.ok } : null;
    case 'output':
      return typeof v.text === 'string' && typeof v.name === 'string' && isLevel(v.level) ? { kind: 'output', text: v.text, level: v.level, name: v.name } : null;
    case 'problems': return Array.isArray(v.lines) && v.lines.every((l) => typeof l === 'string') ? { kind: 'problems', lines: v.lines as string[] } : null;
    case 'note': return typeof v.text === 'string' && isLevel(v.level) ? { kind: 'note', text: v.text, level: v.level } : null;
    default: return null;
  }
}

const isWire = (v: unknown): v is ChatWire => isRecord(v) && (v.role === 'system' || v.role === 'user' || v.role === 'assistant' || v.role === 'tool');

function parseQuestion(v: unknown): Question | null {
  if (!isRecord(v) || typeof v.callId !== 'string' || typeof v.text !== 'string') return null;
  if (!Array.isArray(v.choices) || !v.choices.every((c) => typeof c === 'string')) return null;
  const warnings = Array.isArray(v.warnings) && v.warnings.every((w) => typeof w === 'string') ? (v.warnings as string[]) : undefined;
  const pin = typeof v.pin === 'string' ? v.pin : undefined;
  return { callId: v.callId, text: v.text, choices: v.choices as string[], ...(warnings ? { warnings } : {}), ...(pin ? { pin } : {}) };
}

/** The chat as stored; anything unreadable is an empty chat, an unreadable entry is skipped. `busy` is kept as stored. */
export function parseChat(text: string | null): ChatState {
  if (text === null) return EMPTY_CHAT;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return EMPTY_CHAT;
  }
  if (!isRecord(value) || !Array.isArray(value.entries) || !Array.isArray(value.wire)) return EMPTY_CHAT;
  return {
    entries: value.entries.map(parseEntry).filter((e): e is ChatEntry => e !== null),
    wire: value.wire.filter(isWire),
    question: parseQuestion(value.question),
    busy: value.busy === true,
  };
}

function reduce(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'entries': return action.add.length === 0 ? state : { ...state, entries: [...state.entries, ...action.add] };
    case 'wire': return action.add.length === 0 ? state : { ...state, wire: [...state.wire, ...action.add] };
    case 'ask': return { ...state, question: action.question };
    case 'busy': return state.busy === action.on ? state : { ...state, busy: action.on };
    case 'newChat': return EMPTY_CHAT;
  }
}

const read = (s: Storage | null): string | null => { try { return s?.getItem(CHAT_KEY) ?? null; } catch { return null; } };
const write = (s: Storage | null, text: string): boolean => { try { s?.setItem(CHAT_KEY, text); return !!s; } catch { return false; } };

/**
 * The chat's store: getState, dispatch, subscribe, as the studio's. It is written to `tab` (and mirrored to `mirror`)
 * 300 ms after the last change and read back by the next store: the tab's own entry when it has one (a refresh), else
 * the mirror (a new tab). A request cannot outlive the page, so `busy` is never restored: a chat stored busy comes back
 * idle with a note saying so. Never throws.
 */
export function createChatStore(tab: Storage | null, mirror: Storage | null = null): ChatStore {
  const stored = parseChat(read(tab) !== null ? read(tab) : read(mirror));
  let state: ChatState = stored.busy
    ? { ...stored, busy: false, entries: [...stored.entries, LOST_AT_REFRESH] }
    : stored;
  const listeners = new Set<() => void>();
  const save = () => {
    const text = JSON.stringify(state);
    write(mirror, text);
    write(tab, text);
  };
  const saver = createSaver(save);
  // the note is part of the chat from now on: written at once, or the next refresh would add it again
  if (stored.busy) save();
  return {
    getState: () => state,
    dispatch(action) {
      const next = reduce(state, action);
      if (next === state) return;
      state = next;
      saver.schedule();
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    flush: saver.flush,
  };
}

/** The page's chat store: this tab's sessionStorage, mirrored to localStorage. */
export const createPageChatStore = (): ChatStore => createChatStore(browserTabStorage(), browserStorage());
