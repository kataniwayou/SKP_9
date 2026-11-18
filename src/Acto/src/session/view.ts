import { synced, type Pick, type SelectionState } from '../board/selection';

export interface SavedView { x: number; y: number; zoom: number; selection: SelectionState | null }

const KEY = 'acto.view';

const isStr = (v: unknown): v is string => typeof v === 'string' && v !== '';

function parsePick(v: unknown): Pick | null {
  if (typeof v !== 'object' || v === null) return null;
  const s = v as Record<string, unknown>;
  switch (s.kind) {
    case 'workflow': case 'step': case 'cache': return isStr(s.id) ? { kind: s.kind, id: s.id } : null;
    case 'wire': return isStr(s.from) && isStr(s.to) ? { kind: 'wire', from: s.from, to: s.to } : null;
    case 'entry': return isStr(s.workflowId) && isStr(s.stepId) ? { kind: 'entry', workflowId: s.workflowId, stepId: s.stepId } : null;
    case 'cacheLink': return isStr(s.workflowId) && isStr(s.cacheId) ? { kind: 'cacheLink', workflowId: s.workflowId, cacheId: s.cacheId } : null;
    case 'ghost': return null; // ghosts live in page memory only
    default: return null;
  }
}

function parseSelection(v: unknown): SelectionState | null {
  if (typeof v !== 'object' || v === null) return null;
  const s = v as Record<string, unknown>;
  const workflows = Array.isArray(s.workflows) ? s.workflows.filter(isStr) : isStr(s.workflow) ? [s.workflow] : [];
  const picks = Array.isArray(s.picks) ? s.picks.map(parsePick).filter((p): p is Pick => p !== null) : [];
  // one shape: the selected workflows are the picked triangles (a selection saved before then is brought into it)
  return workflows.length === 0 && picks.length === 0 ? null : synced({ workflows, picks });
}

export function readView(storage: Storage | null): SavedView | null {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (![v.x, v.y, v.zoom].every((n) => typeof n === 'number' && Number.isFinite(n)) || (v.zoom as number) <= 0) return null;
    return { x: v.x as number, y: v.y as number, zoom: v.zoom as number, selection: parseSelection(v.selection) };
  } catch {
    return null;
  }
}

export function writeView(storage: Storage | null, view: SavedView): void {
  try { storage?.setItem(KEY, JSON.stringify(view)); } catch { /* no persistence */ }
}
