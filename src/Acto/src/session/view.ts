import type { BoardWorkflow } from '../board/loadBoard';
import type { Selection } from '../board/selection';

export interface SavedView { x: number; y: number; zoom: number; selection: Selection | null }

const KEY = 'acto.view';

const isStr = (v: unknown): v is string => typeof v === 'string';

function parseSelection(v: unknown): Selection | null {
  if (typeof v !== 'object' || v === null) return null;
  const s = v as Record<string, unknown>;
  if (!isStr(s.workflowId)) return null;
  if (s.kind === 'workflow') return { kind: 'workflow', workflowId: s.workflowId };
  if (s.kind === 'step' && isStr(s.stepId)) return { kind: 'step', workflowId: s.workflowId, stepId: s.stepId };
  if (s.kind === 'wire' && isStr(s.wireId)) return { kind: 'wire', workflowId: s.workflowId, wireId: s.wireId };
  return null;
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

/** The selection if its target is still on the board, else null. */
export function keepExistingSelection(sel: Selection | null, workflows: BoardWorkflow[]): Selection | null {
  if (sel === null) return null;
  const w = workflows.find((x) => x.graph.workflow.id === sel.workflowId);
  if (!w) return null;
  if (sel.kind === 'step') return w.stepIds.includes(sel.stepId) ? sel : null;
  if (sel.kind === 'wire') return w.wires.some((x) => x.id === sel.wireId) ? sel : null;
  return sel;
}
