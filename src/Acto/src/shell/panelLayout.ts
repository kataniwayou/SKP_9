/** The panels that can be hidden; the board never is. */
export type PanelId = 'toolbox' | 'inspector' | 'output' | 'chat';
export const PANEL_IDS: readonly PanelId[] = ['toolbox', 'inspector', 'output', 'chat'];
export type Hidden = Record<PanelId, boolean>;

/**
 * Which panels are hidden, and the layout from before "Board only" (`saved`, null when not in board only).
 * Restore puts `saved` back exactly; showing a panel from its tab ends Board only and drops `saved` [user, 2026-11-23].
 */
export interface PanelLayout { hidden: Hidden; saved: Hidden | null }

export const NONE_HIDDEN: Hidden = { toolbox: false, inspector: false, output: false, chat: false };
export const ALL_HIDDEN: Hidden = { toolbox: true, inspector: true, output: true, chat: true };
export const DEFAULT_LAYOUT: PanelLayout = { hidden: NONE_HIDDEN, saved: null };
const KEY = 'acto.hidden';

function readHidden(v: unknown): Hidden | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const out = { ...NONE_HIDDEN };
  for (const k of PANEL_IDS) out[k] = o[k] === true;
  return out;
}

export function readLayout(storage: Storage | null): PanelLayout {
  if (!storage) return DEFAULT_LAYOUT;
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const p: unknown = JSON.parse(raw);
    if (typeof p !== 'object' || p === null) return DEFAULT_LAYOUT;
    const o = p as Record<string, unknown>;
    return { hidden: readHidden(o.hidden) ?? NONE_HIDDEN, saved: readHidden(o.saved) };
  } catch { return DEFAULT_LAYOUT; }
}

export function writeLayout(storage: Storage | null, l: PanelLayout): void {
  if (!storage) return;
  try { storage.setItem(KEY, JSON.stringify(l)); } catch { /* no persistence */ }
}

export const hidePanel = (l: PanelLayout, id: PanelId): PanelLayout => ({ ...l, hidden: { ...l.hidden, [id]: true } });
/** Showing a panel from its tab ends Board only: the button reads "Board only" again [user, 2026-11-23]. */
export const showPanel = (l: PanelLayout, id: PanelId): PanelLayout => ({ hidden: { ...l.hidden, [id]: false }, saved: null });
/** Board only hides every panel and keeps the layout it replaced; pressed again (Restore layout) it puts that back. */
export const toggleBoardOnly = (l: PanelLayout): PanelLayout =>
  l.saved ? { hidden: l.saved, saved: null } : { hidden: ALL_HIDDEN, saved: l.hidden };
