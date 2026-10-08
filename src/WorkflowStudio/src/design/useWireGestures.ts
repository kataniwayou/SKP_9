import { useEffect, useMemo, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { StudioDocument } from '../app/document';
import { selectionForPicks } from '../canvas/selection';
import { togglePick, type Pick } from '../store/picks';
import type { Selection } from '../store/selection';
import { addCircuitWire, holdEnd, moveWire, NEW_WIRE_PREFIX, openJoinedOn, sameEnd, setBends, setEnd, snapAngle, type Circuit, type End, type Side } from '../circuit/circuit';
import { endPointOf, type WireRoute } from '../layout/circuitRoute';
import { clearBends, clearPath, clearRun } from '../layout/detour';
import { clampLanding, PMID, snap, STEP_W, type Point } from '../layout/geometry';
import { WORKFLOW_SOURCE, type SourceId } from '../layout/ports';
import { route, type Box, type Pt } from '../layout/router';
import { dragSegment, normalize, shapeFromPoints, type Bends } from '../layout/shape';
import { movedEndShape, translatePoints } from '../layout/wireMove';
import { blockBoxes, portOf } from '../layout/wires';
import type { DesignGestures } from './DesignContext';
import type { DesignProps } from './designProps';
import { circuitOf, withCircuit, type Draft } from './draft';
import { endOf, judgeDrop, pointOfTarget, targetOf, toneOf, type DropTarget, type Verdict } from './drop';
import { blockAt, wireAt } from './hit';
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
  /** The pointer, in flow coordinates. */
  at: Point;
}

/** A dragged end's wire, from the end that stays to the pointer; `wire` null: a new wire being drawn. */
export interface WireGhost {
  wire: string | null;
  points: Pt[];
}

/** Which run of the dragged shape is the one under the pointer (`dragSegment`'s run k of a shape with n verticals). */
function draggedRun(n: number, k: number): { vertical: boolean; index: number } {
  if (n === 0 || k === 0) return { vertical: false, index: 0 };
  return k % 2 === 1 ? { vertical: true, index: (k - 1) / 2 } : { vertical: false, index: k / 2 - 1 };
}

/** A dragged end's wire, right-angled around the blocks from the end that stays (`from`) to where the moving end is drawn. */
function ghostPath(from: Point, to: Point, side: Side, boxes: Box[]): Pt[] {
  const [a, b] = side === 'head' ? [from, to] : [to, from];
  return clearPath(route(a.x, a.y, b.x, b.y, '', '', 0, boxes), boxes);
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
  const [hint, setHint] = useState<DropHint | null>(null);
  // the drag's cursor: a horizontal run (even k) moves up and down, a vertical one sideways; an end square any way (rule 14)
  const [resize, setResize] = useState<'ns' | 'ew' | 'move' | null>(null);
  const designRef = useRef(design);
  designRef.current = design;

  // design mode ending mid-drag drops the drag and its preview
  const designOff = design === undefined;
  useEffect(() => {
    if (designOff) { abort(); setPreview(null); setGhost(null); setHint(null); }
  }, [designOff]); // abort and setPreview read refs and React state setters: no need to re-run for them

  /**
   * Drags run k of a wire (spec §4.2): the first drag makes the wire manual. The last run slides its head: along its
   * step's input side (clamped, spec §4.2), or an open head up and down; a head on a junction has no last run to drag.
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
    const shaped = (s: { bends: Bends | null; headY: number | null }): Draft => {
      const moved = s.headY === null ? circuit : setEnd(circuit, wire.id, 'head', headAt(s.headY));
      return withCircuit(base, saved, setBends(moved, wire.id, s.bends));
    };
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
      setPreview(shaped(latest));
    }, (cancelled, moved) => {
      setPreview(null);
      if (cancelled || !moved) return;
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
   * `circuit`, and draws the wire there (`path`). Released: `done` with an allowed target; a refused one snaps back.
   */
  const dropGesture = (e: ReactPointerEvent, o: { id: string; ghost: string | null; side: Side; circuit: Circuit; path: (t: DropTarget) => Pt[]; done: (t: DropTarget) => void }) => {
    let target: DropTarget | null = null;
    let verdict: Verdict = 'move';
    run(e, (p) => {
      const reach = DROP_REACH / getZoom();
      const over = blockAt(shown.current, p, reach);
      const line = over === null ? wireAt(shown.current, p, reach, { id: o.id, side: o.side }) : null;
      target = targetOf(shown.current, o.circuit, p, over, line);
      verdict = judgeDrop(shown.current, o.circuit, o.id, o.side, target);
      setHint({ id: line ? line.id : over, line: line !== null, tone: toneOf(verdict), why: verdict, at: p });
      setGhost({ wire: o.ghost, points: o.path(target) });
    }, (cancelled) => {
      setGhost(null);
      setHint(null);
      if (cancelled || target === null || toneOf(verdict) === 'no') return;
      o.done(target);
    });
  };

  /**
   * Drags a picked wire's end square (plan 9 §6), with the four-way cursor: its tail or its head, connected or open.
   * Over nothing (or a cache) the end follows the pointer with one corner (the user's rule, 2026-10-08): the run at
   * that end keeps its axis up to the pointer, then one perpendicular run goes on to it (`movedEndShape`); released
   * there, the end is open and the wire keeps that shape. Over a step side, the hub or a wire the drop is judged as
   * before: allowed, the end is there and the router draws its way in; refused, it snaps back. A drop where the end
   * already is changes nothing. An end dropped open detaches the wire: the ends joined on it open where they are
   * drawn (spec §2.2-6). The wire keeps its id and stays picked.
   */
  const startEnd = (wire: WireRoute, side: Side, e: ReactPointerEvent) => {
    const d = designRef.current;
    if (!d || e.button !== 0) return;
    const base = d.draft;
    const circuit = circuitOf(saved, base);
    if (!Object.hasOwn(circuit, wire.id)) return;
    const was = circuit[wire.id]![side];
    // the other end, as drawn
    const [sx, sy] = side === 'head' ? wire.points[0]! : wire.points[wire.points.length - 1]!;
    // where the other end's core starts (for a dragged head) or ends (for a dragged tail): the bends are drawn from there
    const { ends } = wire.core;
    const fixed: Pt = side === 'head' ? [ends.sx, ends.sy] : [ends.tx, ends.ty];
    const lShape = (q: Point) => movedEndShape(wire.points, side, q, fixed);
    const boxes = blockBoxes(shown.current.placement);
    setResize('move');
    dropGesture(e, {
      id: wire.id, ghost: wire.id, side, circuit,
      path: (t) => (t.on === 'open' ? lShape(t).points : ghostPath({ x: sx, y: sy }, pointOfTarget(shown.current, t), side, boxes)),
      done: (t) => {
        const end = endOf(t);
        if (sameEnd(was, end)) return;
        let next = setEnd(circuit, wire.id, side, end);
        if (t.on === 'open') {
          const { bends } = lShape(t);
          next = setBends(next, wire.id, bends.xs.length > 0 ? bends : null);
          // the other end stays where it is drawn: an automatic end on a step or the hub is held there (`held`), or
          // the fan-out or the landing rule would move it once this end has gone (the user's rule: the other points
          // stay); it goes back to automatic when this end connects again
          const other: Side = side === 'head' ? 'tail' : 'head';
          const o = circuit[wire.id]![other];
          const at = o.on === 'step' && o.y === null ? shown.current.placement.steps.get(o.step) : undefined;
          if (o.on === 'step' && at) next = holdEnd(next, wire.id, other, { on: 'step', step: o.step, y: sy - at.y });
          else if (o.on === 'hub' && o.angle === null) {
            // the hub takes a tail every 15 degrees: the nearest one to where it leaves the ring
            const { cx, cy } = shown.current.placement.sphere;
            next = holdEnd(next, wire.id, other, { on: 'hub', angle: snapAngle((Math.atan2(sy - cy, sx - cx) * 180) / Math.PI) });
          }
        }
        // a host detached (an end dropped open): the ends joined on it open where they are drawn (spec §2.2-6)
        if (was.on !== 'open' && end.on === 'open') next = openJoinedOn(next, [wire.id], endPointOf(shown.current.wires));
        d.onCommit(withCircuit(base, saved, next), { picks: [{ kind: 'wire', id: wire.id }] });
      },
    });
  };

  /**
   * Drags a wire by its body (the user's rule, 2026-10-08), any wire, picked or not, with the closed hand: the whole
   * wire moves rigidly, its drawn path frozen and shifted by the pointer's movement snapped to the grid. It detaches
   * from everything: both its ends open where the moved path starts and ends, its shape kept as its bends, and the
   * ends joined on it open where they are drawn (`moveWire`). A press that does not move is a click: it only picks
   * the wire; so does one that moves less than a grid step (a wobbly click, whose click the gesture swallows), as a
   * click would, Ctrl toggling it. Released, one history step, and the wire is the pick; Escape puts it back.
   */
  const startBody = (wire: WireRoute, e: ReactPointerEvent) => {
    const d = designRef.current;
    if (!d || e.button !== 0) return;
    const base = d.draft;
    const circuit = circuitOf(saved, base);
    if (!Object.hasOwn(circuit, wire.id)) return;
    const from = flowPointOf(e);
    const points = wire.points;
    // the joined ends open where they are drawn now, not where the preview has moved their host to
    const drawnAt = endPointOf(shown.current.wires);
    let moved: { dx: number; dy: number; circuit: Circuit } | null = null;
    const toggle = e.ctrlKey;
    setResize(null);
    run(e, (p) => {
      // `|| 0`: a snapped -0 is no move
      const dx = snap(p.x - from.x) || 0, dy = snap(p.y - from.y) || 0;
      if (moved && moved.dx === dx && moved.dy === dy) return;
      moved = dx === 0 && dy === 0 ? null : { dx, dy, circuit: moveWire(circuit, wire.id, translatePoints(points, dx, dy), drawnAt) };
      setPreview(moved ? withCircuit(base, saved, moved.circuit) : null);
    }, (cancelled, pressMoved) => {
      setPreview(null);
      if (cancelled) return;
      if (moved === null) {
        // moved, but not a grid step: the click is swallowed, so this picks the wire as the click would have
        if (pressMoved && onSelect) {
          const pick: Pick = { kind: 'wire', id: wire.id };
          const picks = toggle ? togglePick(d.picks, pick) : [pick];
          onSelect(selectionForPicks(picks, null, shown.current.graph), picks);
        }
        return;
      }
      d.onCommit(withCircuit(base, saved, moved.circuit), { picks: [{ kind: 'wire', id: wire.id }] });
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
  return { gestures, startSegment, startEnd, ghost, hint, active, running, resize: active ? resize : null };
}
