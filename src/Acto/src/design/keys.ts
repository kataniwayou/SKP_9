/** Ctrl/Cmd+Z is undo, Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y is redo; left to the browser while typing in a field. */
export function undoRedoKey(e: KeyboardEvent): 'undo' | 'redo' | null {
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null;
  const tag = t?.tagName?.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return null;
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  const k = e.key.toLowerCase();
  if (k === 'z') return e.shiftKey ? 'redo' : 'undo';
  if (k === 'y' && !e.shiftKey) return 'redo';
  return null;
}

const typing = (e: KeyboardEvent) => {
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null;
  const tag = t?.tagName?.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!t?.isContentEditable;
};

/** Ctrl/Cmd+V pastes; left to the browser while typing in a field. */
export function pasteKey(e: KeyboardEvent): boolean {
  if (typing(e) || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return false;
  return e.key.toLowerCase() === 'v';
}

export const NUDGE = 8;
const ARROWS: Record<string, { dx: number; dy: number }> = {
  ArrowLeft: { dx: -NUDGE, dy: 0 }, ArrowRight: { dx: NUDGE, dy: 0 }, ArrowUp: { dx: 0, dy: -NUDGE }, ArrowDown: { dx: 0, dy: NUDGE },
};

/** An arrow key moves what is picked by 8 px; left alone while typing or with a modifier held. */
export function nudgeKey(e: KeyboardEvent): { dx: number; dy: number } | null {
  if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return null;
  const d = ARROWS[e.key];
  return d ? { ...d } : null;
}
