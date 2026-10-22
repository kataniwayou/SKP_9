import { useEffect, useRef, type MutableRefObject } from 'react';
import type { NodeChange, OnNodeDrag, OnNodesChange } from '@xyflow/react';
import type { StudioDocument } from '../app/document';
import { PMID, snap, type Point } from '../layout/geometry';
import type { Selection } from '../store/selection';
import { nodePickIds, wirePickIds, type Pick } from '../store/picks';
import { selectionFromClick } from '../canvas/selection';
import type { DesignProps } from './designProps';
import { circuitOf, moveGroup, type Draft } from './draft';
import { guideBoxes, NO_GUIDES, SNAP_REACH_PX, snapToGuides, type Guides } from './guides';
import { nodeBox } from './hit';

interface Drag {
  primary: string;
  ids: string[];
  /** The picked wires, moved with the blocks as one unit (decision 8, 2026-10-10). */
  wires: string[];
  start: Map<string, Point>;
  /**
   * How far (flow px) the pointer went between the press and React Flow starting the drag (past its threshold): React
   * Flow measures from its start, so the block would lag the pointer by it; added back to every position it reports.
   */
  lag: Point;
  base: Draft;
  preview: Draft | null;
  cancelled: boolean;
  /** Set when the drag picked a block that was not picked: the Inspector follows after the drop. */
  selectAfter: Selection | null | undefined;
  stopEscape: () => void;
}

/**
 * What a held block drag shows (Visio, plan 10 phase 4): the blocks stay put and a faded copy of each moves by (dx, dy);
 * the picked wires that go with them are drawn dashed, moved as much. `draft` is what the release commits; nothing is
 * rerouted until then.
 */
export interface Held {
  draft: Draft;
  ids: string[];
  wires: string[];
  dx: number;
  dy: number;
}

/**
 * Block dragging through React Flow (spec §3.4). The picked blocks move together, snapped to 8 px and
 * onto alignment guides; while held only their copies move, and the wires reroute on release (Visio, plan 10
 * phase 4). A block that was not picked moves alone. Escape cancels; the drop is one history step (spec §5.3).
 *
 * The canvas is controlled and React Flow's changes are never applied: React Flow drags every node with
 * `selected` set (the picks, and before a re-render the old ones), so only the grabbed block's position
 * is read, and every block the drag moves is placed from it.
 */
export interface BlockDrag {
  /**
   * The canvas reports every press here. React Flow starts a drag on the first move past its threshold
   * and hands over that move, whose target is wherever the pointer is then (or the window): the press
   * says which part of the block was grabbed (a processor die picks the processor) and in which window.
   */
  notePress: (target: Element, at?: Point) => void;
  onNodeDragStart?: OnNodeDrag;
  onNodesChange?: OnNodesChange;
  onNodeDragStop?: OnNodeDrag;
  /** A drag is running (from its start until its drop, a cancelled one included). */
  dragging: () => boolean;
}

export function useBlockDrag(
  saved: StudioDocument,
  shown: MutableRefObject<StudioDocument>,
  design: DesignProps | undefined,
  setHeld: (h: Held | null) => void,
  setGuides: (guides: Guides) => void,
  onSelect: ((selection: Selection | null, picks?: Pick[]) => void) | undefined,
  suppressNodeClick: MutableRefObject<boolean>,
  /** Screen px per flow px now: the guides' reach is in screen px (plan 10). */
  zoom: () => number,
): BlockDrag {
  const drag = useRef<Drag | null>(null);
  const pressed = useRef<Element | null>(null);
  const pressAt = useRef<Point | null>(null);
  // a drag React Flow will never stop (the canvas unmounts, or design mode ends mid-drag) must not leave
  // its Escape listener behind: it would swallow every later Escape in that window
  useEffect(() => () => { drag.current?.stopEscape(); drag.current = null; }, []);
  const designOff = design === undefined;
  useEffect(() => {
    if (!designOff || !drag.current) return;
    drag.current.stopEscape();
    drag.current = null;
    setGuides(NO_GUIDES);
    setHeld(null);
  }, [designOff, setGuides, setHeld]);
  const dragging = () => drag.current !== null;
  if (!design) return { notePress: () => {}, dragging };

  const end = () => {
    const d = drag.current;
    drag.current = null;
    d?.stopEscape();
    setGuides(NO_GUIDES);
    setHeld(null);
    return d;
  };

  const onNodeDragStart: OnNodeDrag = (event, node) => {
    end();
    const doc = shown.current;
    if (!nodeBox(doc, node.id)) return;
    const before = [...design.picks];
    const picked = design.picks.some((p) => p.kind === 'node' && p.id === node.id);
    // picks naming blocks that are gone (after an undo) are left out
    const ids = picked ? nodePickIds(design.picks).filter((id) => nodeBox(doc, id) !== null) : [node.id];
    if (!picked) design.onPick([{ kind: 'node', id: node.id }]);
    const press = pressed.current;
    const target = press?.closest('.react-flow__node')?.getAttribute('data-id') === node.id ? press : null;
    const owner = press?.ownerDocument ?? null;
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !drag.current) return;
      e.preventDefault(); // the dock's Escape skips a key already handled
      e.stopPropagation();
      drag.current.cancelled = true;
      setGuides(NO_GUIDES);
      setHeld(null);
      // a block the drag picked is unpicked again: everything goes back (spec §5.3)
      if (!picked) design.onPick(before);
    };
    owner?.addEventListener('keydown', escape, true);
    // the picked wires go with the picked blocks (a block that was not picked moves alone); one gone after an undo is skipped
    const circuit = circuitOf(saved, design.draft);
    const wires = picked ? wirePickIds(design.picks).filter((id) => Object.hasOwn(circuit, id)) : [];
    const at = pressAt.current, z = zoom();
    // a touch drag has no clientX on the event itself: its first touch has
    const p = 'touches' in event ? event.touches[0] : event;
    const lag = at && p && Number.isFinite(p.clientX) && Number.isFinite(p.clientY) && z > 0
      ? { x: (p.clientX - at.x) / z, y: (p.clientY - at.y) / z } : { x: 0, y: 0 };
    drag.current = {
      primary: node.id, ids, wires, lag,
      start: new Map(ids.map((id) => { const b = nodeBox(doc, id)!; return [id, { x: b.x, y: b.y }] as const; })),
      base: design.draft, preview: null, cancelled: false,
      selectAfter: picked ? undefined : selectionFromClick(node, target, doc.graph),
      stopEscape: () => owner?.removeEventListener('keydown', escape, true),
    };
  };

  const onNodesChange: OnNodesChange = (changes: NodeChange[]) => {
    const d = drag.current;
    if (!d || d.cancelled) return;
    const change = changes.find((c) => c.type === 'position' && c.id === d.primary);
    if (!change || change.type !== 'position' || !change.position) return;
    const start = d.start.get(d.primary)!;
    // from the press, not from where React Flow started the drag: the block stays under the pointer (Visio)
    const raw = { x: change.position.x + d.lag.x, y: change.position.y + d.lag.y };
    let dx = snap(raw.x) - start.x, dy = snap(raw.y) - start.y;
    const box = nodeBox(shown.current, d.primary);
    if (box) {
      // Visio's dynamic grid (plan 10): matched at the unrounded position within 12 screen px; an axis no guide caught
      // is rounded to the grid
      const others = guideBoxes(shown.current).filter((b) => !d.ids.includes(b.id));
      const mid = shown.current.placement.steps.has(d.primary) ? { mid: raw.y + PMID } : {};
      const g = snapToGuides({ id: d.primary, x: raw.x, y: raw.y, w: box.w, h: box.h, ...mid }, others, SNAP_REACH_PX / zoom());
      if (g.hit.x) dx = g.x - start.x;
      if (g.hit.y) dy = g.y - start.y;
      setGuides({ lines: g.lines, gaps: g.gaps });
    }
    // back where it started: nothing to show, and the drop makes no step
    const moved = new Map(d.ids.map((id) => { const s = d.start.get(id)!; return [id, { x: s.x + dx, y: s.y + dy }] as const; }));
    d.preview = dx === 0 && dy === 0 ? null : moveGroup(d.base, saved, moved, d.wires, dx, dy);
    setHeld(d.preview && { draft: d.preview, ids: d.ids, wires: d.wires, dx, dy });
  };

  const onNodeDragStop: OnNodeDrag = () => {
    const d = end();
    if (!d) return;
    // the click that ends a drag must not re-pick; dropped once this input's events are done
    suppressNodeClick.current = true;
    const view = pressed.current?.ownerDocument.defaultView ?? window;
    view.setTimeout(() => { suppressNodeClick.current = false; }, 0);
    if (d.cancelled) return;
    if (d.preview) design.onCommit(d.preview);
    if (d.selectAfter !== undefined) onSelect?.(d.selectAfter, [{ kind: 'node', id: d.primary }]);
  };

  const notePress = (target: Element, at?: Point) => { pressed.current = target; pressAt.current = at ?? null; };
  return { notePress, onNodeDragStart, onNodesChange, onNodeDragStop, dragging };
}
