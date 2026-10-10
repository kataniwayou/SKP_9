import { useEffect, useMemo, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { StudioDocument } from '../app/document';
import { selectionForPicks } from '../canvas/selection';
import { togglePick, type Pick } from '../store/picks';
import type { Selection } from '../store/selection';
import { addCircuitWire, freeWithout, NEW_WIRE_PREFIX, openJoinedOn, sameEnd, setBends, setEnd, type Circuit, type End, type Side } from '../circuit/circuit';
import { endPointOf, hubStart, type WireRoute } from '../layout/circuitRoute';
import { clearBends, clearRun, legPath } from '../layout/detour';
import { clampLanding, PMID, snap, STEP_W, type Point } from '../layout/geometry';
import { WORKFLOW_SOURCE, type SourceId } from '../layout/ports';
import { simplify, type Box, type Pt } from '../layout/router';
import { dragSegment, normalize, pointsOfShape, shapeFromPoints, type Bends } from '../layout/shape';
import { coreFrom, legsPath, moveLegs, startLegs, type Legs } from '../layout/wireMove';
import { LineIndex } from '../layout/overlaps';
import { blockBoxes, portOf } from '../layout/wires';
import type { DesignGestures } from './DesignContext';
import type { DesignProps } from './designProps';
import { circuitOf, removeWires, withCircuit, type Draft } from './draft';
import { landBody, type BodyLanding } from './bodyDrop';
import { landWires, type RunLanding, type WireRun } from './keyBody';
import { cutPaths, cutTargets, cutWire, holdDrawn, squareAt, squaresOf, type Square } from './cut';
import { applyDrop, endOf, judgeDrop, pointOfTarget, roleOf, targetOf, toneOf, type DropTarget, type Verdict } from './drop';
import { blockAt, wireAt } from './hit';
import { overlapJudge } from './overlapJudge';
import { newId } from './ids';

/** What a dragged wire end is over (plan 9 §6): the block outlined or the line haloed (tone), the verdict, and where the pointer is, for the label. */
export interface DropHint {
  /** The block (node id) or, when `line`, the wire under the pointer; null over empty canvas. */
  id: string | null;
  /** Over a wire's line, not a block. */
  line: boolean;
  /** Green: the end connects or joins; grey: it is or stays open; red: it snaps back. */
  tone: 'ok' | 'move' | 'no';
  why: Verdict;
  /** The pointer (a body drag: the end), in flow coordinates. */
  at: Point;
}

/**
 * A dragged end's wire, from the end that stays to the pointer; `wire` null: a new wire being drawn. Over one of its
 * own squares (the user's rule, 2026-10-09): `gone`, the part released there would cut away; `faded`, the whole wire
 * would be deleted.
 */
export interface WireGhost {
  wire: string | null;
  points: Pt[];
  gone?: Pt[];
  faded?: boolean;
}

/** An end square's drag over its own wire's squares: what it is over, what the canvas shows, what a release does. */
interface OwnSquares {
  at: (p: Point) => Square | null;
  preview: (s: Square) => WireGhost;
  done: (s: Square) => void;
}

/** Which run of the dragged shape is the one under the pointer (`dragSegment`'s run k of a shape with n verticals). */
function draggedRun(n: number, k: number): { vertical: boolean; index: number } {
  if (n === 0 || k === 0) return { vertical: false, index: 0 };
  return k % 2 === 1 ? { vertical: true, index: (k - 1) / 2 } : { vertical: false, index: k / 2 - 1 };
}

/** A dragged end's wire, right-angled around the blocks from the end that stays (`from`) to where the moving end is drawn (`legPath`). */
function ghostPath(from: Point, to: Point, side: Side, boxes: Box[], avoid?: (pts: Pt[]) => number): Pt[] {
  return side === 'head' ? legPath(from, to, boxes, avoid) : legPath(to, from, boxes, avoid);
}

/** Below this many screen pixels a press is a click, not a drag. */
const MOVE_START = 3;

/** How far outside a block's border or a line (screen px) a dragged end already counts as over it. */
const DROP_REACH = 8;

export interface Gesture {
  run: (e: ReactPointerEvent, onMove: (p: Point) => void, onEnd: (cancelled: boolean, moved: boolean) => void) => void;
  /** Drops the running gesture, if any: its listeners go and `onEnd` never runs. */
  abort: () => void;
  /** A gesture is running (read at once, not on the next render). */
  running: () => boolean;
}

/**
 * Runs one pointer gesture on the press's own document (a pop-out's included, spec §6.3): moves until
 * the button is released; Escape or a pointer cancel cancels. `onMove` gets flow coordinates (not
 * snapped: the shape snaps); `onEnd(cancelled, moved)` always runs, except when the canvas unmounts or
 * design mode ends mid-gesture: then the listeners are removed and nothing is committed.
 */
export function useGesture(setActive: (on: boolean) => void): Gesture {
  const { screenToFlowPosition } = useReactFlow();
  // the running gesture's teardown, so an unmount never leaves its listeners behind (they would swallow Escape)
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => { stop.current?.(); stop.current = null; }, []);

  const run: Gesture['run'] = (e, onMove, onEnd) => {
    e.preventDefault();
    e.stopPropagation();
    stop.current?.();
    const doc = (e.currentTarget as Element).ownerDocument;
    const view = doc.defaultView ?? window;
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    setActive(true);
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < MOVE_START) return;
      moved = true;
      onMove(screenToFlowPosition({ x: ev.clientX, y: ev.clientY }, { snapToGrid: false }));
    };
    const detach = () => {
      doc.removeEventListener('pointermove', move);
      doc.removeEventListener('pointerup', up);
      doc.removeEventListener('pointercancel', cancel);
      doc.removeEventListener('keydown', key, true);
      stop.current = null;
    };
    const finish = (cancelled: boolean) => {
      detach();
      setActive(false);
      if (moved || buttonDown) {
        // the click that ends a drag lands on whatever is under the pointer (the pane clears the picks, a
        // wire re-picks): swallowed once, and dropped once this input's events are done. After an Escape
        // the button is still down: the swallow waits for its release, so the picks stay (spec §5.3)
        const swallow = (ev: MouseEvent) => { ev.stopPropagation(); doc.removeEventListener('click', swallow, true); };
        doc.addEventListener('click', swallow, true);
        const drop = () => view.setTimeout(() => doc.removeEventListener('click', swallow, true), 0);
        if (buttonDown) {
          const released = () => {
            doc.removeEventListener('pointerup', released, true);
            doc.removeEventListener('pointercancel', released, true);
            drop();
          };
          doc.addEventListener('pointerup', released, true);
          doc.addEventListener('pointercancel', released, true);
        } else drop();
      }
      onEnd(cancelled, moved);
    };
    // only Escape ends a gesture with the button still down
    let buttonDown = false;
    const up = () => finish(false);
    const cancel = () => finish(true);
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation(); // the dock's Escape must not also run
      buttonDown = true;
      finish(true);
    };
    doc.addEventListener('pointermove', move);
    doc.addEventListener('pointerup', up);
    doc.addEventListener('pointercancel', cancel);
    doc.addEventListener('keydown', key, true);
    stop.current = () => { detach(); setActive(false); };
  };
  return { run, abort: () => stop.current?.(), running: () => stop.current !== null };
}

/**
 * Editing wires (spec §4.2-§4.5; plan 9 §6; the user's drag rules, 2026-10-08): dragging a picked wire's run square
 * moves that run (the first drag makes the wire manual, the last run slides its head); dragging any wire's body moves
 * the whole wire, detached from everything; dragging either end square moves that end with one corner, onto a step
 * side, the hub, another wire or nothing, as the circuit allows; dragging from a block's connection point draws a new
 * wire. Each finished drag is one history step; Escape cancels it (spec §5.3).
 */
export function useWireGestures(
  saved: StudioDocument,
  shown: MutableRefObject<StudioDocument>,
  design: DesignProps | undefined,
  setPreview: (d: Draft | null) => void,
  /** What a click on a wire selects (the canvas's own), for a body press that moved less than a grid step. */
  onSelect?: (selection: Selection | null, picks?: Pick[]) => void,
) {
  const [active, setActive] = useState(false);
  const { run, abort, running } = useGesture(setActive);
  const { screenToFlowPosition, getZoom } = useReactFlow();
  const [ghost, setGhost] = useState<WireGhost | null>(null);
  // one per dragged end: an end square's drag has one, a body drag one per end (rule B, 2026-10-09)
  const [hints, setHints] = useState<DropHint[]>([]);
  // the drag's cursor: a horizontal run (even k) moves up and down, a vertical one sideways; an end square any way (rule 14)
  const [resize, setResize] = useState<'ns' | 'ew' | 'move' | null>(null);
  const designRef = useRef(design);
  designRef.current = design;

  // design mode ending mid-drag drops the drag and its preview
  const designOff = design === undefined;
  useEffect(() => {
    if (designOff) { abort(); setPreview(null); setGhost(null); setHints([]); }
  }, [designOff]); // abort and setPreview read refs and React state setters: no need to re-run for them

  /**
   * Drags run k of a wire (spec §4.2): the first drag makes the wire manual. The last run slides its head: along its
   * step's input side (clamped, spec §4.2), or an open head up and down; a head on a junction has no last run to drag.
   * A shape that lies on a wire it may not share a line with (the user's rule 2, 2026-10-09) is a short circuit: the
   * label says so and, released there, the run snaps back.
   */
  const startSegment = (wire: WireRoute, k: number, e: ReactPointerEvent) => {
    const d = designRef.current;
    if (!d || e.button !== 0) return;
    const base = d.draft;
    const circuit = circuitOf(saved, base);
    if (!Object.hasOwn(circuit, wire.id)) return;
    const rec = circuit[wire.id]!;
    const ends = wire.core.ends;
    const bends = rec.bends ?? shapeFromPoints(wire.core.points);
    if (rec.head.on === 'wire' && k === 2 * bends.xs.length) return;
    const step = rec.head.on === 'step' ? shown.current.placement.steps.get(rec.head.step) : undefined;
    const headAt = (y: number): End => (rec.head.on === 'step' ? { on: 'step', step: rec.head.step, y } : rec.head.on === 'open' ? { on: 'open', x: rec.head.x, y } : rec.head);
    // a dragged wire goes around the blocks, never through one (spec §4.2)
    const boxes = blockBoxes(shown.current.placement);
    let latest: { bends: Bends | null; headY: number | null } = { bends: rec.bends ?? null, headY: null };
    const shapedCircuit = (s: { bends: Bends | null; headY: number | null }): Circuit => {
      const moved = s.headY === null ? circuit : setEnd(circuit, wire.id, 'head', headAt(s.headY));
      return setBends(moved, wire.id, s.bends);
    };
    const shaped = (s: { bends: Bends | null; headY: number | null }): Draft => withCircuit(base, saved, shapedCircuit(s));
    // each move judges the core as it would be drawn (a lead from the hub or a junction does not move); the nets do not change
    const judge = overlapJudge(shown.current, wire.id, circuit);
    let short = false;
    setResize(k % 2 === 0 ? 'ns' : 'ew');
    run(e, (p) => {
      const r = dragSegment(bends, k, p, ends);
      if ('landingY' in r) {
        const headY = step ? clampLanding(r.landingY - step.y) : r.landingY;
        const ty = step ? step.y + headY : headY;
        latest = { bends: bends.xs.length > 0 ? clearBends({ ...ends, ty }, bends, boxes) : null, headY };
      } else {
        // the run under the pointer is pushed off any block it would lie on; the rest detours around blocks
        const moved = clearRun(r.bends, ends, draggedRun(bends.xs.length, k), boxes);
        latest = { bends: clearBends(ends, moved, boxes), headY: latest.headY };
      }
      const ty = latest.headY === null ? ends.ty : step ? step.y + latest.headY : latest.headY;
      const core = latest.bends ? pointsOfShape({ ...ends, ty }, latest.bends) : [[ends.sx, ends.sy], [ends.tx, ty]] as Pt[];
      const now = latest;
      short = judge(simplify(core), () => shapedCircuit(now));
      setHints(short ? [{ id: null, line: false, tone: 'no', why: 'short', at: p }] : []);
      setPreview(shaped(latest));
    }, (cancelled, moved) => {
      setPreview(null);
      setHints([]);
      if (cancelled || !moved || short) return;
      const ty = latest.headY === null ? ends.ty : step ? step.y + latest.headY : latest.headY;
      const tidy = latest.bends ? normalize({ ...ends, ty }, latest.bends) : null;
      const next = shaped({ bends: tidy, headY: latest.headY });
      // dragged back where it was: no step
      if (JSON.stringify(next.wires?.[wire.id]) === JSON.stringify(rec)) return;
      d.onCommit(next);
    });
  };

  /**
   * Drags one end of wire `id` (plan 9 §6). Each move finds what the pointer is over (a block within the drop reach
   * wins over a line; the dragged wire's own line counts except its run at the dragged end), judges the drop on
   * `circuit` (and, with `overlaps`, the path drawn: lying on a wire it may not share a line with is a short circuit,
   * the user's rule 2), and draws the wire there (`path`; `step` sees the pointer first). Released: `done` with an allowed
   * target; a refused one snaps back. With `own` (an end square's drag), one of the wire's own squares under the pointer
   * comes first: "cut here" or "delete wire", and released there `own.done` (the user's rule, 2026-10-09).
   */
  const dropGesture = (e: ReactPointerEvent, o: {
    id: string; ghost: string | null; side: Side; circuit: Circuit; path: (t: DropTarget) => Pt[]; done: (t: DropTarget) => void;
    step?: (p: Point) => void; own?: OwnSquares;
    /** The drop drawn as `path` would lie on a wire it may not share a line with (rule 2): "short circuit", it snaps back. */
    overlaps?: (t: DropTarget, path: Pt[]) => boolean;
  }) => {
    let target: DropTarget | null = null;
    let verdict: Verdict = 'move';
    let square: Square | null = null;
    run(e, (p) => {
      o.step?.(p);
      square = o.own?.at(p) ?? null;
      if (square && o.own) {
        verdict = square.kind === 'run' ? 'cut' : 'deleteWire';
        setHints([{ id: null, line: false, tone: toneOf(verdict), why: verdict, at: p }]);
        setGhost(o.own.preview(square));
        return;
      }
      const reach = DROP_REACH / getZoom();
      const over = blockAt(shown.current, p, reach);
      const line = over === null ? wireAt(shown.current, p, reach, { id: o.id, side: o.side }) : null;
      target = targetOf(shown.current, o.circuit, p, over, line);
      verdict = judgeDrop(shown.current, o.circuit, o.id, o.side, target);
      const path = o.path(target);
      if (toneOf(verdict) !== 'no' && o.overlaps?.(target, path)) verdict = 'short';
      setHints([{ id: line ? line.id : over, line: line !== null, tone: toneOf(verdict), why: verdict, at: p }]);
      setGhost({ wire: o.ghost, points: path });
    }, (cancelled) => {
      setGhost(null);
      setHints([]);
      if (cancelled) return;
      if (square && o.own) { o.own.done(square); return; }
      if (target === null || toneOf(verdict) === 'no') return;
      o.done(target);
    });
  };

  /**
   * Drags a picked wire's end square (plan 9 §6; the user's rule C, 2026-10-09), with the four-way cursor: its tail or
   * its head, connected or open. The end draws its wire like a pen around corners (`Legs`): it follows the pointer with
   * one corner (an L), each 90 degree turn of the pointer fixes the corner where it turned and starts a new leg, and
   * back past a corner takes it away. Released over nothing (or a cache) the end is open there and the wire keeps the
   * drawn shape. Over a step side, the hub or a wire the drop is judged as before (a direction-less wire's end takes
   * the role the side gives it, rule D): allowed, the end is there, the corners drawn kept and only the last leg routed
   * in (a wire that was automatic, with no corner fixed in this drag, stays automatic); refused, it snaps back. A drop
   * where the end already is changes nothing. An end dropped open detaches the wire: the ends joined on it open where
   * they are drawn (spec §2.2-6). The wire keeps its id and stays picked. Released on one of the wire's own squares, as
   * they were when the drag began (the user's rule, 2026-10-09): on a run square the wire is cut there, everything
   * from it to this end gone, the wire open there; on its other end square the whole wire is deleted.
   */
  const startEnd = (wire: WireRoute, side: Side, e: ReactPointerEvent) => {
    const d = designRef.current;
    if (!d || e.button !== 0) return;
    const base = d.draft;
    const circuit = circuitOf(saved, base);
    if (!Object.hasOwn(circuit, wire.id)) return;
    const rec = circuit[wire.id]!;
    const was = rec[side];
    // the other end, as drawn
    const [sx, sy] = side === 'head' ? wire.points[0]! : wire.points[wire.points.length - 1]!;
    // where the other end's core starts (for a dragged head) or ends (for a dragged tail): the bends are drawn from there
    const { ends } = wire.core;
    const fixed: Pt = side === 'head' ? [ends.sx, ends.sy] : [ends.tx, ends.ty];
    // drawn from the end that stays to the dragged end; `stored` turns such a path to the wire's own order and back
    const stored = (pts: readonly Pt[]): Pt[] => (side === 'head' ? [...pts] : [...pts].reverse());
    let legs: Legs = startLegs(stored(wire.points), flowPointOf(e));
    const boxes = blockBoxes(shown.current.placement);
    // the leg the router draws into a contact keeps off the other wires (rule 2), as the router does
    const others = new LineIndex();
    for (const x of shown.current.wires) if (x.id !== wire.id) others.add(x.id, x.points);
    const avoid = (pts: Pt[]): number => others.count(pts, () => true);
    /** The bends of a path drawn from the end that stays (`oriented`), its lead before the core left out. */
    const bendsOf = (oriented: readonly Pt[]) => shapeFromPoints(stored(coreFrom(oriented, fixed)));
    // an automatic wire with no corner fixed in this drag is routed again onto a step, the hub or a line (as before)
    const keepShape = () => rec.bends !== undefined || legs.drawn;
    /** The path into target `t` from the end that stays (a hub's lead at the dragged end apart), and that lead. */
    const into = (t: DropTarget): { core: Pt[]; lead: Pt[] } => {
      // the end this one is once dropped: a direction-less wire's end takes the role the side or the hub gives it
      const role: Side = freeWithout(rec, side) ? roleOf(t) ?? side : side;
      const a = legs.path[legs.path.length - 1]!;
      let start = pointOfTarget(shown.current, t), lead: Pt[] = [];
      if (t.on === 'hub') {
        // as the wire will be drawn there: a shape kept starts at the ring point on the grid (`hubStart`)
        const { cx, cy } = shown.current.placement.sphere;
        const h = hubStart(cx, cy, t.angle, keepShape() ? a[0] : null);
        start = h.start;
        lead = [...h.lead].reverse();
      }
      if (!keepShape()) {
        const leg = ghostPath({ x: sx, y: sy }, start, role, boxes, avoid);
        return { core: role === 'head' ? leg : [...leg].reverse(), lead };
      }
      // the last leg: on along the anchor's way when it is vertical, then square into the contact from the side a wire
      // takes it (a head from the left, a tail to the right), so the corner drawn there stays; otherwise routed as a
      // wire leaves its tail (from the anchor to a head, from a tail to the anchor)
      const square = legs.axis === 'v' && (t.on === 'wire' || (role === 'head' ? a[0] <= start.x : a[0] >= start.x));
      const leg = ghostPath({ x: a[0], y: a[1] }, start, role, boxes, avoid);
      const fromAnchor: Pt[] = square ? [[a[0], start.y], [start.x, start.y]] : role === 'head' ? leg : [...leg].reverse();
      return { core: simplify([...legs.path, ...fromAnchor]), lead };
    };
    // the wire's own squares as they are now, but the one being dragged: what it may be released on to cut the wire
    const shape = rec.bends ?? shapeFromPoints(wire.core.points);
    const zoomK = 1 / getZoom();
    const squares = cutTargets(squaresOf(wire, shape, zoomK), side);
    const own: OwnSquares = {
      at: (p) => squareAt(squares, p, zoomK),
      preview: (q) => {
        if (q.kind === 'end') return { wire: wire.id, points: wire.points, gone: wire.points, faded: true };
        const { kept, gone } = cutPaths(wire, shape, side, q.k);
        return { wire: wire.id, points: kept, gone };
      },
      done: (q) => {
        const pointOf = endPointOf(shown.current.wires);
        if (q.kind === 'end') { d.onCommit(removeWires(base, saved, [wire.id], pointOf), { picks: [] }); return; }
        const cut = cutWire(circuit, wire.id, side, wire, shape, q.k, pointOf, shown.current.placement);
        d.onCommit(withCircuit(base, saved, cut), { picks: [{ kind: 'wire', id: wire.id }] });
      },
    };
    /** The circuit a drop on `t` makes (any verdict but a refusal). */
    const dropped = (t: DropTarget): Circuit => {
      const end = endOf(t);
      let next: Circuit;
      if (t.on === 'open') {
        next = setEnd(circuit, wire.id, side, end);
        const bends = bendsOf(legsPath(legs));
        next = setBends(next, wire.id, bends.xs.length > 0 ? bends : null);
        // the other end stays where it is drawn: an automatic end on a step or the hub is held there (`held`), or
        // the fan-out or the landing rule would move it once this end has gone (the user's rule: the other points
        // stay); it goes back to automatic when this end connects again
        next = holdDrawn(next, wire.id, side === 'head' ? 'tail' : 'head', { x: sx, y: sy }, shown.current.placement);
      } else {
        // the corners drawn are kept and only the last leg routed in (rule C); a direction-less wire the drop turns
        // round turns its bends with it (rule D)
        const keep = keepShape() ? bendsOf(into(t).core) : undefined;
        const place = { routes: shown.current.wires, ctx: { placement: shown.current.placement, steps: shown.current.graph.steps } };
        next = applyDrop(circuit, wire.id, side, t, place, keep === undefined ? undefined : keep.xs.length > 0 ? keep : null).circuit;
      }
      // a host detached (an end dropped open): the ends joined on it open where they are drawn (spec §2.2-6)
      if (was.on !== 'open' && end.on === 'open') next = openJoinedOn(next, [wire.id], endPointOf(shown.current.wires));
      return next;
    };
    // a drop that keeps the drawn shape lies where it is drawn: on a wire it may not share a line with it is a short
    // circuit (rule 2); one the router draws again takes a free track by itself
    const judge = overlapJudge(shown.current, wire.id, circuit);
    const overlaps = (t: DropTarget, path: Pt[]): boolean => (t.on === 'open' || keepShape()) && judge(path, () => dropped(t));
    setResize('move');
    dropGesture(e, {
      id: wire.id, ghost: wire.id, side, circuit, own, overlaps,
      step: (p) => { legs = moveLegs(legs, p); },
      path: (t) => {
        if (t.on === 'open') return stored(legsPath(legs));
        const { core, lead } = into(t);
        return stored(simplify([...core, ...lead]));
      },
      done: (t) => {
        if (sameEnd(was, endOf(t))) return;
        d.onCommit(withCircuit(base, saved, dropped(t)), { picks: [{ kind: 'wire', id: wire.id }] });
      },
    });
  };

  /**
   * Drags a wire by its body (the user's rules B and D, 2026-10-09), any wire, picked or not, with the closed hand: the
   * whole wire moves rigidly, its drawn path frozen and shifted by the pointer's movement snapped to the grid, and
   * detached from everything, connected ends too (`landBody`): the closed hand never stretches a leg. Each end is
   * judged over what is under it as an end square's is, with its label and outline; one over a contact it may take
   * shifts the wire exactly onto it (the end that got there first decides), and released, every end over a contact
   * it may take connects (the wire has no direction while moved: the sides decide it); the others stay open. Moved
   * back exactly where it was, it is as it was. The ends joined on it open where they are drawn. A press that does not
   * move is a click: it only picks the wire; so does one that moves less than a grid step (a wobbly click, whose click
   * the gesture swallows), as a click would, Ctrl toggling it. Released, one history step, and the wire is the pick;
   * Escape puts it back.
   */
  const startBody = (wire: WireRoute, e: ReactPointerEvent) => {
    const d = designRef.current;
    if (!d || e.button !== 0) return;
    const base = d.draft;
    const circuit = circuitOf(saved, base);
    if (!Object.hasOwn(circuit, wire.id)) return;
    const from = flowPointOf(e);
    const points = wire.points;
    const judge = overlapJudge(shown.current, wire.id, circuit);
    // the joined ends open where they are drawn now, not where the preview has moved their host to
    const drawnAt = endPointOf(shown.current.wires);
    let landing: (BodyLanding & { rawX: number; rawY: number }) | null = null;
    // a grid step was made: from then on the press is a drag, even back where it began
    let travelled = false;
    const toggle = e.ctrlKey;
    setResize(null);
    run(e, (p) => {
      // `|| 0`: a snapped -0 is no move
      const dx = snap(p.x - from.x) || 0, dy = snap(p.y - from.y) || 0;
      if (dx !== 0 || dy !== 0) travelled = true;
      if (!travelled || (landing && landing.rawX === dx && landing.rawY === dy)) return;
      const l = landBody(shown.current, circuit, wire.id, points, drawnAt, dx, dy, landing?.first ?? null, DROP_REACH / getZoom(), judge);
      landing = { ...l, rawX: dx, rawY: dy };
      // shifted back exactly where it was: drawn as it was
      setPreview(l.dx === 0 && l.dy === 0 ? null : withCircuit(base, saved, l.preview));
      setHints(l.ends.map((x) => ({ id: x.id, line: x.line, tone: toneOf(x.verdict), why: x.verdict, at: x.at })));
    }, (cancelled, pressMoved) => {
      setPreview(null);
      setHints([]);
      if (cancelled) return;
      const pick: Pick = { kind: 'wire', id: wire.id };
      if (landing === null || (landing.dx === 0 && landing.dy === 0)) {
        // moved, but not a grid step, or back exactly where it was: the click is swallowed, so this picks the wire as
        // the click would have (a wobble's Ctrl toggles it)
        if (pressMoved && onSelect) {
          const picks = toggle && !travelled ? togglePick(d.picks, pick) : [pick];
          onSelect(selectionForPicks(picks, null, shown.current.graph), picks);
        }
        return;
      }
      d.onCommit(withCircuit(base, saved, landing.result), { picks: [pick] });
    });
  };

  /**
   * Draws a new wire from a step's output or the hub (spec §4.5): automatic at its tail, its head judged as any head
   * (plan 9 §6); released on nothing it is a grey wire open at its head. It becomes the pick.
   */
  const startNew = (source: SourceId, e: ReactPointerEvent) => {
    const d = designRef.current;
    if (!d || e.button !== 0) return;
    const base = d.draft;
    const { placement } = shown.current;
    const from = portOf(placement, source) ?? { x: STEP_W, y: PMID };
    const id = `${NEW_WIRE_PREFIX}${newId()}`;
    const tail: End = source === WORKFLOW_SOURCE ? { on: 'hub', angle: null } : { on: 'step', step: source, y: null };
    const circuit = addCircuitWire(circuitOf(saved, base), id, { tail, head: { on: 'open', x: from.x, y: from.y } });
    const boxes = blockBoxes(placement);
    setResize(null);
    dropGesture(e, {
      id, ghost: null, side: 'head', circuit,
      path: (t) => ghostPath(from, pointOfTarget(shown.current, t), 'head', boxes),
      done: (t) => d.onCommit(withCircuit(base, saved, setEnd(circuit, id, 'head', endOf(t))), { picks: [{ kind: 'wire', id }] }),
    });
  };

  /** The press point in flow coordinates (React Flow's own transform, so a pop-out's window works too). */
  function flowPointOf(e: ReactPointerEvent): Point {
    return screenToFlowPosition({ x: e.clientX, y: e.clientY }, { snapToGrid: false });
  }
  // ---- arrows with only wires picked: the closed hand's drag, driven by the keys (the user's rule, 2026-10-10) ----
  // the held run (an arrow down, nothing committed since its last press) and the last released one (a later press
  // goes on from it while the wires are still as it left them)
  const keyHeld = useRef<RunLanding | null>(null);
  const keyLast = useRef<WireRun | null>(null);
  const keys = useMemo(() => ({
    /**
     * An arrow press (or its repeat) moves the picked wires `ids` one more step: as a pointer move of the closed hand,
     * the moved wires and each end's hint (the step's frame, "connect here") are shown, nothing committed. False when no
     * picked wire can move.
     */
    move(ids: readonly string[], ddx: number, ddy: number): boolean {
      const d = designRef.current;
      if (!d) return false;
      const held = keyHeld.current;
      const l = landWires(saved, shown.current, d.draft, ids, ddx, ddy, held?.run ?? keyLast.current, held !== null, DROP_REACH / getZoom());
      if (l === null) return false;
      keyHeld.current = l;
      setPreview(l.still ? null : withCircuit(l.run.base, saved, l.preview));
      setHints(l.ends.map((x) => ({ id: x.id, line: x.line, tone: toneOf(x.verdict), why: x.verdict, at: x.at })));
      return true;
    },
    /** The arrow is let go: as the closed hand's release, every end over a contact it may take connects; one history step per run. */
    release() {
      const l = keyHeld.current;
      if (l === null) return;
      keyHeld.current = null;
      keyLast.current = l.run;
      setPreview(null);
      setHints([]);
      const d = designRef.current;
      if (d && l.next !== d.draft) d.onCommit(l.next, { merge: 'nudge' });
    },
    /** Escape while an arrow is held: as the drag's Escape, what the held presses did since the last release is dropped. */
    cancel(): boolean {
      if (keyHeld.current === null) return false;
      keyHeld.current = null;
      setPreview(null);
      setHints([]);
      return true;
    },
  }), [saved, shown, setPreview, getZoom]);

  const latestRef = useRef({ startBody, startNew });
  latestRef.current = { startBody, startNew };

  // stable, so every wire does not re-render with each canvas render
  const gestures = useMemo<DesignGestures>(() => ({
    wirePointerDown(wireId, e) {
      const wire = shown.current.wires.find((w) => w.id === wireId);
      // any wire's body, picked or not, moves the whole wire (the user's rule, 2026-10-08); a click only picks it
      if (wire) latestRef.current.startBody(wire, e);
    },
    portPointerDown(source, e) {
      latestRef.current.startNew(source, e);
    },
  }), [shown]);

  // a run or end drag's cursor only while that drag runs; a body drag and a new wire keep the closed hand
  return { gestures, startSegment, startEnd, ghost, hints, active, running, resize: active ? resize : null, keys };
}
