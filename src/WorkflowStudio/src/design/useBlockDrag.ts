import { useEffect, useRef, type MutableRefObject } from 'react';
import type { NodeChange, OnNodeDrag, OnNodesChange } from '@xyflow/react';
import type { StudioDocument } from '../app/document';
import { NEW_WIRE_PREFIX, type Circuit, type End } from '../circuit/circuit';
import { SPHERE_NODE_ID } from '../layout/nodeIds';
import { PMID, snap, STEP_H, STEP_W, type Point } from '../layout/geometry';
import type { Selection } from '../store/selection';
import { nodePickIds, wirePickIds, type Pick } from '../store/picks';
import { selectionFromClick } from '../canvas/selection';
import type { DesignProps } from './designProps';
import { circuitOf, moveGroup, type Draft } from './draft';
import { guideBoxes, NO_GUIDES, SNAP_REACH_PX, snapToGuides, type Guides } from './guides';
import { nodeBox } from './hit';
import { newId } from './ids';
import { commitSplit, splitAt, splitTone, type Split } from './split';

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
  /**
   * A step with no wires dragged alone (plan 10 §4.6): it splits a wire whose run it is released on. Its family judges
   * the split, against the circuit as the drag found it (worked out once: judging reuses what it knows of it); `split`
   * is the wire under it now and the verdict there.
   */
  splitter: { step: string; condition: number; circuit: Circuit } | null;
  split: Split | null;
  cancelled: boolean;
  /** Set when the drag picked a block that was not picked: the Inspector follows after the drop. */
  selectAfter: Selection | null | undefined;
  /** The picks back as they were before the drag (Escape, or a refused split). */
  unpick: () => void;
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
  /** A step with no wires held over a wire's run: the wire, marked for a split, and the verdict (plan 10 §4.6). */
  split?: Split | null;
}

/**
 * The held drag's picked wires that go along whole, drawn dashed where the release puts them: every end on a held block
 * (a step, or the hub), open, or on a wire that goes along itself. One with an end on a block that stays is rerouted on
 * release, so nothing is drawn for it while held (review 2026-10-22).
 */
export function carried(circuit: Circuit, held: Held): string[] {
  const memo = new Map<string, boolean>();
  const goes = (id: string): boolean => {
    if (memo.has(id)) return memo.get(id)!;
    memo.set(id, false); // a wire hosted round a loop does not go along
    const w = circuit[id];
    const ends = (e: End): boolean => (e.on === 'step' ? held.ids.includes(e.step) : e.on === 'hub' ? held.ids.includes(SPHERE_NODE_ID)
      : e.on === 'open' ? true : held.wires.includes(e.host) && goes(e.host));
    const ok = w !== undefined && held.wires.includes(id) && ends(w.tail) && ends(w.head);
    memo.set(id, ok);
    return ok;
  };
  return held.wires.filter(goes);
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
      drag.current.unpick();
    };
    owner?.addEventListener('keydown', escape, true);
    // the picked wires go with the picked blocks (a block that was not picked moves alone); one gone after an undo is skipped
    const circuit = circuitOf(saved, design.draft);
    const wires = picked ? wirePickIds(design.picks).filter((id) => Object.hasOwn(circuit, id)) : [];
    // a step with no wires, alone, splits a wire it is dropped on (Visio, plan 10 §4.6)
    const lone = ids.length === 1 && wires.length === 0 ? doc.graph.steps.get(ids[0]!) : undefined;
    const wired = lone && Object.values(circuit).some((w) => [w.tail, w.head].some((e) => e.on === 'step' && e.step === lone.id));
    const splitter = lone && !wired ? { step: lone.id, condition: lone.entryCondition, circuit } : null;
    const at = pressAt.current, z = zoom();
    // a touch drag has no clientX on the event itself: its first touch has
    const p = 'touches' in event ? event.touches[0] : event;
    const lag = at && p && Number.isFinite(p.clientX) && Number.isFinite(p.clientY) && z > 0
      ? { x: (p.clientX - at.x) / z, y: (p.clientY - at.y) / z } : { x: 0, y: 0 };
    drag.current = {
      primary: node.id, ids, wires, lag,
      start: new Map(ids.map((id) => { const b = nodeBox(doc, id)!; return [id, { x: b.x, y: b.y }] as const; })),
      base: design.draft, preview: null, splitter, split: null, cancelled: false,
      selectAfter: picked ? undefined : selectionFromClick(node, target, doc.graph),
      unpick: () => { if (!picked) design.onPick(before); },
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
    const s = d.splitter && d.preview ? d.start.get(d.splitter.step)! : null;
    d.split = s && d.splitter
      ? splitAt(shown.current, d.splitter.circuit, { x: s.x + dx, y: s.y + dy, w: STEP_W, h: STEP_H }, d.splitter.step, d.splitter.condition, d.splitter.step)
      : null;
    setHeld(d.preview && { draft: d.preview, ids: d.ids, wires: d.wires, dx, dy, split: d.split });
  };

  const onNodeDragStop: OnNodeDrag = () => {
    const d = end();
    if (!d) return;
    // the click that ends a drag must not re-pick; dropped once this input's events are done
    suppressNodeClick.current = true;
    const view = pressed.current?.ownerDocument.defaultView ?? window;
    view.setTimeout(() => { suppressNodeClick.current = false; }, 0);
    if (d.cancelled) return;
    // on a wire that refuses the split, nothing moves (plan 10 §4.6); on one that takes it, the wire splits in the same step
    if (d.preview && d.split && d.splitter) {
      // refused: nothing moves, and as for Escape the picks go back as they were (review 2026-10-22)
      if (splitTone(d.split.why) === 'no') { d.unpick(); return; }
      design.onCommit(commitSplit(saved, shown.current, d.preview, d.split, d.splitter.step, `${NEW_WIRE_PREFIX}${newId()}`));
    } else if (d.preview) design.onCommit(d.preview);
    if (d.selectAfter !== undefined) onSelect?.(d.selectAfter, [{ kind: 'node', id: d.primary }]);
  };

  const notePress = (target: Element, at?: Point) => { pressed.current = target; pressAt.current = at ?? null; };
  return { notePress, onNodeDragStart, onNodesChange, onNodeDragStop, dragging };
}
