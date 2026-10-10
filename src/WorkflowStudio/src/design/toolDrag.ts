import { useSyncExternalStore } from 'react';
import type { StudioDocument } from '../app/document';
import type { Point } from '../layout/geometry';
import type { Id } from '../model/graph';
import { judgeTool, type ToolItem, type ToolVerdict } from './toolDrop';

/**
 * A workflow canvas that takes Toolbox drops (2026-10-11): its element (what the pointer is over), its workflow, how a
 * screen point maps to its flow coordinates, and what it shows now (to judge a drop as the canvas would draw it).
 */
export interface DropTarget {
  workflowId: Id;
  el: Element;
  toFlow: (client: Point) => Point;
  shown: () => StudioDocument;
}

/** A Toolbox drag in progress: the tile, the pointer (screen), and the canvas under it with the verdict there. */
export interface ToolDragState {
  item: ToolItem;
  client: Point;
  over: { target: DropTarget; flow: Point; verdict: ToolVerdict; saving: boolean } | null;
}

const targets = new Set<DropTarget>();
let state: ToolDragState | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

/** A canvas registers while it is in design mode; the returned function unregisters it. */
export function registerDropTarget(t: DropTarget): () => void {
  targets.add(t);
  return () => { targets.delete(t); };
}

/** The canvas under the screen point `client` in `doc` (the window the drag runs in), or null. */
function targetAt(doc: Document, client: Point): DropTarget | null {
  const under = doc.elementFromPoint(client.x, client.y);
  if (!under) return null;
  for (const t of targets) if (t.el.ownerDocument === doc && t.el.contains(under)) return t;
  return null;
}

/**
 * The one drag (pointer-based, not the browser's drag and drop): `start` on a tile's press, `move` with the pointer,
 * `end` on release (the drop, or null when there is nothing to drop on), `cancel` on Escape. `isSaving` says whether a
 * workflow's Save is running: its canvas refuses drops meanwhile.
 */
export const toolDrag = {
  get: (): ToolDragState | null => state,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },
  start(item: ToolItem, client: Point): void {
    state = { item, client, over: null };
    emit();
  },
  move(doc: Document, client: Point, isSaving: (workflowId: Id) => boolean): void {
    if (!state) return;
    const target = targetAt(doc, client);
    if (!target) { state = { ...state, client, over: null }; emit(); return; }
    const flow = target.toFlow(client);
    state = { ...state, client, over: { target, flow, verdict: judgeTool(target.shown(), state.item, flow), saving: isSaving(target.workflowId) } };
    emit();
  },
  end(): { item: ToolItem; workflowId: Id; at: Point } | null {
    const s = state;
    state = null;
    emit();
    if (!s?.over || s.over.saving || s.over.verdict.kind === 'noStep' || s.over.verdict.kind === 'linked') return null;
    return { item: s.item, workflowId: s.over.target.workflowId, at: s.over.flow };
  },
  cancel(): void {
    if (state === null) return;
    state = null;
    emit();
  },
};

/** The drag in progress, for the Toolbox's ghost and each canvas's preview. */
export function useToolDrag(): ToolDragState | null {
  return useSyncExternalStore(toolDrag.subscribe, toolDrag.get, toolDrag.get);
}
