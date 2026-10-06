/** The studio's own keys (spec §6.1, §6.2.6). The browser keeps Ctrl+Tab and Ctrl+W, so these avoid them. */
export type KeyCommand = 'switcher' | 'switcherBack' | 'closeDocument' | 'open' | 'escape' | 'start' | 'stop';

export interface KeyLike { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }

export function keyCommand(e: KeyLike): KeyCommand | null {
  const key = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey && key === 'e') return e.shiftKey ? 'switcherBack' : 'switcher';
  if (e.altKey && !mod && key === 'w') return 'closeDocument';
  if (mod && !e.altKey && !e.shiftKey && key === 'o') return 'open';
  if (e.key === 'Escape') return 'escape';
  if (e.key === 'F5') return e.shiftKey ? 'stop' : 'start';
  return null;
}
