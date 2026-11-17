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
