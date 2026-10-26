/**
 * What the user sent in the chat (2026-10-24), oldest first, for ↑ / ↓ in the message box as in Claude Code. Kept in the
 * browser, so it outlives a refresh and New chat; the same message sent twice in a row is kept once.
 */
export const HISTORY_KEY = 'skp.valence.chatHistory';
export const HISTORY_MAX = 100;

export function readHistory(storage: Storage | undefined = globalThis.localStorage): string[] {
  try {
    const v: unknown = JSON.parse(storage?.getItem(HISTORY_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').slice(-HISTORY_MAX) : [];
  } catch {
    return [];
  }
}

/** `history` with `text` added last, unless it already is last; at most HISTORY_MAX, the oldest dropped. */
export function withSent(history: readonly string[], text: string): string[] {
  return (history.at(-1) === text ? [...history] : [...history, text]).slice(-HISTORY_MAX);
}

export function writeHistory(history: readonly string[], storage: Storage | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // a browser that keeps nothing: the history lasts while the page is open
  }
}

/**
 * Where ↑ (-1) or ↓ (+1) takes the box: `at` is the history index shown, null for the user's own draft. Null result:
 * the key is not taken (↑ at the oldest, ↓ on the draft), so the caret moves as usual.
 */
export function stepHistory(length: number, at: number | null, by: -1 | 1): { at: number | null } | null {
  if (by === -1) {
    if (length === 0 || at === 0) return null;
    return { at: at === null ? length - 1 : at - 1 };
  }
  if (at === null) return null;
  return { at: at + 1 >= length ? null : at + 1 };
}
