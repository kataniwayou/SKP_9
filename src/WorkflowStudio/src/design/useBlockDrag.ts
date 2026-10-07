import { useEffect, useRef, type MutableRefObject } from 'react';
import type { NodeChange, OnNodeDrag, OnNodesChange } from '@xyflow/react';
import type { StudioDocument } from '../app/document';
import { PMID, snap, type Point } from '../layout/geometry';
import type { Selection } from '../store/selection';
import { nodePickIds, type Pick } from '../store/picks';
import { selectionFromClick } from '../canvas/selection';
import type { DesignProps } from './designProps';
import { moveBlocks, type Draft } from './draft';
import { guideBoxes, snapToGuides, type GuideLine } from './guides';
import { nodeBox } from './hit';

interface Drag {
  primary: string;
  ids: string[];
  start: Map<string, Point>;
  base: Draft;
  preview: Draft | null;
  cancelled: boolean;
  /** Set when the drag picked a block that was not picked: the Inspector follows after the drop. */
  selectAfter: Selection | null | undefined;
  stopEscape: () => void;
}

/**
 * Block dragging through React Flow (spec §3.4). The picked blocks move together, snapped to 8 px and
 * onto alignment guides; wires re-route live from the preview draft. A block that was not picked moves
 * alone. Escape cancels; the drop is one history step (spec §5.3).
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
  notePress: (target: Element) => void;
  onNodeDragStart?: OnNodeDrag;
  onNodesChange?: OnNodesChange;
  onNodeDragStop?: OnNodeDrag;
}

export function useBlockDrag(
  saved: StudioDocument,
  shown: MutableRefObject<StudioDocument>,
  design: DesignProps | undefined,
  setPreview: (d: Draft | null) => void,
  setGuides: (lines: GuideLine[]) => void,
  onSelect: ((selection: Selection | null, picks?: Pick[]) => void) | undefined,
  suppressNodeClick: MutableRefObject<boolean>,
): BlockDrag {
  const drag = useRef<Drag | null>(null);
  const pressed = useRef<Element | null>(null);
  // a drag React Flow will never stop (the canvas unmounts, or design mode ends mid-drag) must not leave
  // its Escape listener behind: it would swallow every later Escape in that window
  useEffect(() => () => { drag.current?.stopEscape(); drag.current = null; }, []);
  const designOff = design === undefined;
  useEffect(() => {
    if (!designOff || !drag.current) return;
    drag.current.stopEscape();
    drag.current = null;
    setGuides([]);
    setPreview(null);
  }, [designOff, setGuides, setPreview]);
  if (!design) return { notePress: () => {} };

  const end = () => {
    const d = drag.current;
    drag.current = null;
    d?.stopEscape();
    setGuides([]);
    setPreview(null);
    return d;
  };

  const onNodeDragStart: OnNodeDrag = (_event, node) => {
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
      setGuides([]);
      setPreview(null);
      // a block the drag picked is unpicked again: everything goes back (spec §5.3)
      if (!picked) design.onPick(before);
    };
    owner?.addEventListener('keydown', escape, true);
    drag.current = {
      primary: node.id, ids,
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
    let dx = snap(change.position.x) - start.x, dy = snap(change.position.y) - start.y;
    const box = nodeBox(shown.current, d.primary);
    if (box) {
      const others = guideBoxes(shown.current).filter((b) => !d.ids.includes(b.id));
      const mid = shown.current.placement.steps.has(d.primary) ? { mid: start.y + dy + PMID } : {};
      const g = snapToGuides({ id: d.primary, x: start.x + dx, y: start.y + dy, w: box.w, h: box.h, ...mid }, others);
      dx += g.dx; dy += g.dy;
      setGuides(g.lines);
    }
    // back where it started: nothing to show, and the drop makes no step
    const moved = new Map(d.ids.map((id) => { const s = d.start.get(id)!; return [id, { x: s.x + dx, y: s.y + dy }] as const; }));
    d.preview = dx === 0 && dy === 0 ? null : moveBlocks(d.base, saved, moved);
    setPreview(d.preview);
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

  const notePress = (target: Element) => { pressed.current = target; };
  return { notePress, onNodeDragStart, onNodesChange, onNodeDragStop };
}
