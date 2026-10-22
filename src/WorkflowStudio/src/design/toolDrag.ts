import { useSyncExternalStore } from 'react';
import type { StudioDocument } from '../app/document';
import type { Point } from '../layout/geometry';
import type { Id } from '../model/graph';
import type { Circuit } from '../circuit/circuit';
import { DROP_REACH, toneOf } from './drop';
import { guideBoxes, NO_GUIDES, SNAP_REACH_PX, snapToGuides, type Guides } from './guides';
import { splitTone } from './split';
import { judgeTool, landingBox, type ToolItem, type ToolVerdict } from './toolDrop';

/**
 * A workflow canvas that takes Toolbox drops (2026-10-11): its element (what the pointer is over), its workflow, how a
 * screen point maps to its flow coordinates, and what it shows now (to judge a drop as the canvas would draw it).
 */
export interface DropTarget {
  workflowId: Id;
  el: Element;
  toFlow: (client: Point) => Point;
  shown: () => StudioDocument;
  /** The circuit it shows (a Wire tile over a contact is judged as a dragged wire end there, 2026-10-20). */
  circuit?: () => Readonly<Circuit>;
}

/** A Toolbox drag in progress: the tile, the pointer (screen), and the canvas under it with the verdict there. */
export interface ToolDragState {
  item: ToolItem;
  client: Point;
  /**
   * `flow`: where the drop lands (a block's pointer point moved by the guides it snaps to, so `landingBox` of it is the
   * snapped box); `guides`: the dynamic grid shown meanwhile (plan 10).
   */
  over: { target: DropTarget; flow: Point; verdict: ToolVerdict; saving: boolean; reach: number; guides: Guides } | null;
}

/**
 * Where a Wire tile's ghost has its arrow tip, from the pointer (screen px): the ghost is centred on the pointer and drawn
 * 120 px wide from the 120-wide art, whose tip is at x 106. The tip, not the pointer, is what touches a contact (the
 * user's request, 2026-10-21).
 */
export const WIRE_TIP: Point = { x: 46, y: 0 };
/** Where its tail's ring is, from the pointer (screen px): the art's ring at x 10. It touches a contact too (2026-10-21). */
export const WIRE_TAIL: Point = { x: -50, y: 0 };

/**
 * The screen points a drag of `item` is judged at, first to last: a wire's tip, then its tail's ring (the first that
 * touches a contact wins; touching none, the tip is where a free wire lands); anything else at the pointer.
 */
const hotSpots = (item: ToolItem, client: Point): Point[] =>
  item.kind === 'wire'
    ? [WIRE_TIP, WIRE_TAIL].map((o) => ({ x: client.x + o.x, y: client.y + o.y }))
    : [client];

/**
 * A block tile over a canvas (plan 10, Visio's dynamic grid): its box centred on `p`, unrounded, snapped to the guides
 * within `reach` (flow px); `p` moved on each axis a guide caught, so `landingBox` lands it there (the others it rounds to
 * the grid). Null for a tile that lands no block (a wire, a processor).
 */
function onGrid(shown: StudioDocument, item: ToolItem, p: Point, reach: number): { flow: Point; guides: Guides } | null {
  const box = landingBox(item, p);
  if (!box) return null;
  const g = snapToGuides({ id: '', x: p.x - box.w / 2, y: p.y - box.h / 2, w: box.w, h: box.h }, guideBoxes(shown), reach);
  return { flow: { x: g.hit.x ? g.x + box.w / 2 : p.x, y: g.hit.y ? g.y + box.h / 2 : p.y }, guides: { lines: g.lines, gaps: g.gaps } };
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
    const item = state.item;
    let over: ToolDragState['over'] = null;
    for (const [k, hot] of hotSpots(item, client).entries()) {
      const target = targetAt(doc, hot);
      if (!target) continue;
      const flow = target.toFlow(hot);
      // the drop reach of a dragged wire end: DROP_REACH screen px, in flow px at this zoom
      const perPx = Math.abs(target.toFlow({ x: hot.x + 1, y: hot.y }).x - flow.x);
      const reach = DROP_REACH * perPx;
      const wiring = target.circuit ? { circuit: target.circuit(), reach } : undefined;
      let verdict = judgeTool(target.shown(), item, flow, wiring);
      // a step over a wire (plan 10 §4.6) lands on the grid too, and is judged again where it lands
      const snapped = verdict.kind === 'place' || verdict.kind === 'split' ? onGrid(target.shown(), item, flow, SNAP_REACH_PX * perPx) : null;
      if (snapped && item.kind === 'step') verdict = judgeTool(target.shown(), item, snapped.flow, wiring);
      const here = { target, flow: snapped?.flow ?? flow, verdict, saving: isSaving(target.workflowId), reach, guides: snapped?.guides ?? NO_GUIDES };
      // on a contact (connect, join, or refused there) this point decides; else only the first point (a wire's tip) counts
      if (here.verdict.kind === 'wire') { over = here; break; }
      if (k === 0) over = here;
    }
    state = { ...state, client, over };
    emit();
  },
  end(): { item: ToolItem; workflowId: Id; at: Point; reach: number } | null {
    const s = state;
    state = null;
    emit();
    if (!s?.over || s.over.saving) return null;
    const v = s.over.verdict;
    if (v.kind === 'noStep' || v.kind === 'linked' || (v.kind === 'wire' && toneOf(v.why) === 'no') || (v.kind === 'split' && splitTone(v.why) === 'no')) return null;
    return { item: s.item, workflowId: s.over.target.workflowId, at: s.over.flow, reach: s.over.reach };
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
