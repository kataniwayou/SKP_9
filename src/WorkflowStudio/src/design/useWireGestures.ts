import type { Id } from '../model/graph';
import { SPHERE_NODE_ID } from '../layout/nodeIds';
import type { Dir } from './autoConnect';
import { useEffect, useMemo, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { StudioDocument } from '../app/document';
import { selectionForPicks } from '../canvas/selection';
import { togglePick, type Pick } from '../store/picks';
import type { Selection } from '../store/selection';
import { addCircuitWire, freeWithout, NEW_WIRE_PREFIX, openJoinedOn, sameEnd, setBends, setEnd, type Circuit, type End, type Side } from '../circuit/circuit';
import { contactOn, endPointOf, hubStart, routeCircuit, type WireRoute } from '../layout/circuitRoute';
import { clearBends, clearDragged, clearRun, legPath } from '../layout/detour';
import { clampLanding, GRID, PMID, snap, STEP_W, type Point } from '../layout/geometry';
import { WORKFLOW_SOURCE, type SourceId } from '../layout/ports';
import { simplify, type Box, type Pt } from '../layout/router';
import { nearestOn } from '../layout/junctions';
import { dragSegment, normalize, pointsOfShape, shapeFromPoints, type Bends } from '../layout/shape';
import { coreFrom, legsPath, moveLegs, startLegs, type Legs } from '../layout/wireMove';
import { LineIndex } from '../layout/overlaps';
import { blockBoxes, portOf } from '../layout/wires';
import type { DesignGestures } from './DesignContext';
import type { DesignProps } from './designProps';
import { circuitOf, removeWires, withCircuit, type Draft } from './draft';
import { landBody, type BodyLanding } from './bodyDrop';
import { landWires, type RunLanding, type WireRun } from './keyBody';
import { cornerDiag, cutPaths, cutTargets, cutWire, holdDrawn, squareAt, squaresOf, type Square } from './cut';
import { applyDrop, DROP_REACH, endOf, LINE_REACH, judgeDrop, pointOfTarget, roleOf, targetOf, toneOf, type DropTarget, type Verdict } from './drop';
import { blockAt, wireAt } from './hit';
import { overlapJudge } from './overlapJudge';
import { guideAt, landingBoxes, landingMarks, pickSnap, ranked, runGapMarks, snapRun, spaceLanding, spaceRuns, type Candidate, type RunGuide } from './runSnap';
import { onceEach, SNAP_REACH_PX, type GapMark, type GuideBox } from './guides';
import { mayShare } from '../layout/overlaps';
import { netsOf } from '../circuit/families';
import { newId } from './ids';

/** What a dragged wire end is over (plan 9 Â§6): the block outlined or the line haloed (tone), the verdict, and where the pointer is, for the label. */
export interface DropHint {
  /** The block (node id) or, when `line`, the wire under the pointer; null over empty canvas. */
  id: string | null;
  /** Over a wire's line, not a block. */
  line: boolean;
  /** Green: the end connects or joins; grey: it is or stays open; red: it snaps back. */
  tone: 'ok' | 'move' | 'no';
  why: Verdict;
  /** Where the end would land (a step side, the hub's ring, a wire's line), drawn as Visio's square; null when open. */
  contact?: Point | null;
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
  /** The stretches the new route would share with wires it may not share a line with (a short circuit), drawn red. */
  shorts?: Pt[][];
  /**
   * A wire moved whole (Visio's body drag, `shots/ui3-wire-body-held.png`; the user's ruling, 2026-10-22): the wire stays
   * as it is and a faded copy of it, its own art, lies on `points`, where the release puts it.
   */
  body?: boolean;
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


export interface Gesture {
  run: (e: ReactPointerEvent, onMove: (p: Point) => void, onEnd: (cancelled: boolean, moved: boolean) => void) => void;
  /** Drops the running gesture, if any: its listeners go and `onEnd` never runs. */
  abort: () => void;
  /** A gesture is running (read at once, not on the next render). */
  running: () => boolean;
}

/**
 * Runs one pointer gesture on the press's own document (a pop-out's included, spec Â§6.3): moves until
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
        // the button is still down: the swallow waits for its release, so the picks stay (spec Â§5.3)
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
 * Editing wires (spec Â§4.2-Â§4.5; plan 9 Â§6; the user's drag rules, 2026-10-08): dragging a picked wire's run square
 * moves that run (the first drag makes the wire manual, the last run slides its head); dragging any wire's body moves
 * the whole wire, detached from everything; dragging either end square moves that end with one corner, onto a step
 * side, the hub, another wire or nothing, as the circuit allows; dragging from a block's connection point draws a new
 * wire. Each finished drag is one history step; Escape cancels it (spec Â§5.3).
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
  // the drag's cursor (Visio's, plan 10 phase 2): a horizontal run (even k) moves up and down, a vertical one sideways; an
  // end being placed (a dragged end, a new wire) the crosshair; a whole wire moved the four-way arrow
  const [resize, setResize] = useState<'ns' | 'ew' | 'nwse' | 'nesw' | 'move' | 'cross' | null>(null);
  // a dragged run's alignment guide (plan 10 phase 2, Visio's): the line it snapped to, across the run's own axis; a
  // dragged end's: one per axis it snapped on
  const [runGuides, setRunGuides] = useState<RunGuide[]>([]);
  // the equal-gap marks of a dragged run, or of a wire moved whole (as a block's, the user's 2026-10-23)
  const [runGaps, setRunGaps] = useState<GapMark[]>([]);
  const designRef = useRef(design);
  designRef.current = design;

  // design mode ending mid-drag drops the drag and its preview
  const designOff = design === undefined;
  useEffect(() => {
    if (designOff) { abort(); setPreview(null); setGhost(null); setHints([]); setRunGuides([]); setRunGaps([]); }
  }, [designOff]); // abort and setPreview read refs and React state setters: no need to re-run for them

  /**
   * Drags runs of a wire by a circle (spec §4.2; the user's rules, 2026-10-26): a run's circle moves its run across, a
   * corner's both runs that meet there (`runs`, the corner diagonally); the first drag makes the wire manual. The last
   * run slides its head: along its step's input side (clamped, spec §4.2), or an open head up and down. The first run
   * slides its tail along its step's output side the same way (the user's, 2026-10-25); a tail on the hub gets a jog
   * instead. An end on a junction slides along its host with the run that reaches it (`joint`; the user's, 2026-10-26).
   * A straight wire has no circle (it moves whole). A shape
   * that lies on a wire it may not share a line with (the user's rule 2, 2026-10-09) is a short circuit: the label says
   * so and, released there, the run snaps back.
   */
  const startRuns = (wire: WireRoute, runs: readonly number[], e: ReactPointerEvent) => {
    const d = designRef.current;
    if (!d || e.button !== 0) return;
    const base = d.draft;
    const circuit = circuitOf(saved, base);
    if (!Object.hasOwn(circuit, wire.id)) return;
    const rec = circuit[wire.id]!;
    const ends = wire.core.ends;
    const bends = rec.bends ?? shapeFromPoints(wire.core.points);
    const n = bends.xs.length;
    if (n === 0 || simplify(pointsOfShape(ends, bends)).length <= 2) return;
    // an end on a junction (the user's, 2026-10-26: it slides, never anchored): onto a level host the wire drops one jog
    // off the line (a lead between its core and the contact), so its upright nearest the contact carries it along the
    // host as far as it moves; onto an upright host the level run that meets it carries it up and down
    type Joint = { side: Side; host: string; line: Pt[]; level: boolean; run: number; contact: Pt };
    const joint = (side: Side): Joint | null => {
      const o = rec[side];
      const host = o.on === 'wire' ? shown.current.wires.find((x) => x.id === o.host) : undefined;
      if (o.on !== 'wire' || !host) return null;
      const contact = side === 'head' ? wire.points[wire.points.length - 1]! : wire.points[0]!;
      const [ex, ey] = side === 'head' ? [ends.tx, ends.ty] : [ends.sx, ends.sy];
      const level = ex !== contact[0] || ey !== contact[1];
      const run = side === 'head' ? (level ? 2 * n - 1 : 2 * n) : level ? 1 : 0;
      return { side, host: o.host, line: [...host.points], level, run, contact };
    };
    const joints = [joint('head'), joint('tail')].filter((j): j is Joint => j !== null);
    // a head on a level host's last run is its lead's: never dragged
    if (runs.some((r) => r < 0 || r > 2 * n || (rec.head.on === 'wire' && r === 2 * n && !joints.some((j) => j.side === 'head' && j.run === r)))) return;
    const step = rec.head.on === 'step' ? shown.current.placement.steps.get(rec.head.step) : undefined;
    const headAt = (y: number): End => (rec.head.on === 'step' ? { on: 'step', step: rec.head.step, y } : rec.head.on === 'open' ? { on: 'open', x: rec.head.x, y } : rec.head);
    // the run that slides a step-glued tail: the first
    const source = rec.tail.on === 'step' ? shown.current.placement.steps.get(rec.tail.step) : undefined;
    const tailStep = rec.tail.on === 'step' ? rec.tail.step : null;
    const slidesTail = source !== undefined || joints.some((j) => j.side === 'tail' && j.run === 0);
    // a dragged wire goes around the blocks, never through one (spec §4.2)
    const boxes = blockBoxes(shown.current.placement);
    // a junction end slid: how far along its host it is now (`at`), and where (`p`)
    type Slid = { at: number; p: Pt } | null;
    type Shaped = { bends: Bends | null; headY: number | null; tailY: number | null; headJ: Slid; tailJ: Slid };
    let latest: Shaped = { bends: rec.bends ?? null, headY: null, tailY: null, headJ: null, tailJ: null };
    const shapedCircuit = (s: Shaped): Circuit => {
      let moved = s.headY === null ? circuit : setEnd(circuit, wire.id, 'head', headAt(s.headY));
      if (s.tailY !== null && tailStep !== null) moved = setEnd(moved, wire.id, 'tail', { on: 'step', step: tailStep, y: s.tailY });
      for (const j of joints) {
        const at = j.side === 'head' ? s.headJ : s.tailJ;
        if (at) moved = setEnd(moved, wire.id, j.side, { on: 'wire', host: j.host, at: at.at });
      }
      return setBends(moved, wire.id, s.bends);
    };
    const shaped = (s: Shaped): Draft => withCircuit(base, saved, shapedCircuit(s));
    // where the shape's ends are: the tail and the head as slid (a junction end along its host)
    const slid = (s: Shaped) => {
      const h = joints.find((j) => j.side === 'head'), t = joints.find((j) => j.side === 'tail');
      return {
        sx: s.tailJ && t?.level ? s.tailJ.p[0] : ends.sx,
        sy: s.tailJ && !t?.level ? s.tailJ.p[1] : s.tailY === null ? ends.sy : source ? source.y + s.tailY : s.tailY,
        tx: s.headJ && h?.level ? s.headJ.p[0] : ends.tx,
        ty: s.headJ && !h?.level ? s.headJ.p[1] : s.headY === null ? ends.ty : step ? step.y + s.headY : s.headY,
      };
    };
    // each move judges the core as it would be drawn (a lead from the hub or a junction does not move); the nets do not change
    // a run dragged by hand: lying on another net's wire is a short circuit, automatic or not (the user's ruling, 2026-10-20)
    const judge = overlapJudge(shown.current, wire.id, circuit, 'strict');
    let short = false;
    const corner = runs.length > 1;
    const k = runs[0]!;
    setResize(corner ? cornerDiag(pointsOfShape(ends, bends), Math.max(...runs)) : k % 2 === 0 ? 'ns' : 'ew');
    const axis = k % 2 === 0 ? 'y' : 'x';
    const manual = setBends(circuit, wire.id, bends);
    const share = mayShare(manual, netsOf(manual, (s) => shown.current.graph.steps.get(s)?.entryCondition));
    // the run that slides a step-glued end: its step's processor middle (where the router lands it), not every grid
    // line of the side, which the grid already gives (final review 2026-10-21)
    const slidesHead = !corner && step !== undefined && k === 2 * n;
    const slidesOwnTail = !corner && source !== undefined && k === 0;
    const landings = slidesHead ? [step.y + PMID] : slidesOwnTail ? [source.y + PMID] : [];
    // the other wires' ends on that side, for the run that slides an end along it
    const side = slidesHead && rec.head.on === 'step' ? landingBoxes(shown.current, wire.id, rec.head.step, 'in')
      : slidesOwnTail && tailStep !== null ? landingBoxes(shown.current, wire.id, tailStep, 'out') : [];
    const reach = SNAP_REACH_PX / getZoom();
    // the other wires as drawn, for the red stretches of a short circuit (the user's rule 2: red where it lies on them)
    const others = new LineIndex();
    for (const w of shown.current.wires) if (w.id !== wire.id) others.add(w.id, w.points);
    // the shape a pointer at `p` gives: each run under it moved (the last first, so the first's jog leaves the others'
    // places), pushed off any block it would lie on, the rest detouring around blocks
    const shapeAt = (p: Point): { state: Shaped; core: Pt[] } => {
      let b = bends, headY: number | null = null, tailY: number | null = null;
      for (const r of [...runs].sort((x, y) => y - x)) {
        const out = dragSegment(b, r, p, ends, slidesTail);
        if ('landingY' in out) headY = step ? clampLanding(out.landingY - step.y) : out.landingY;
        else if ('tailY' in out) tailY = source ? clampLanding(out.tailY - source.y) : out.tailY;
        else b = clearRun(out.bends, ends, draggedRun(n, r), boxes);
      }
      // a junction end carried by its run: where that run now crosses its host, the nearest point on the host's line
      let headJ: Slid = null, tailJ: Slid = null;
      for (const j of joints) {
        if (!runs.includes(j.run)) continue;
        const i = j.side === 'head' ? b.xs.length - 1 : b.xs.length - n;
        const v = j.level ? j.contact[0] + b.xs[i]! - bends.xs[j.side === 'head' ? n - 1 : 0]! : j.side === 'head' ? headY! : tailY!;
        const near = nearestOn([j.line], j.level ? [v, j.contact[1]] : [j.contact[0], v]);
        if (j.side === 'head') headJ = { at: near.at, p: near.p }; else tailJ = { at: near.at, p: near.p };
      }
      const at = slid({ bends: null, headY, tailY, headJ, tailJ });
      const state: Shaped = { bends: clearBends(at, b, boxes), headY, tailY, headJ, tailJ };
      return { state, core: state.bends ? pointsOfShape(at, state.bends) : [[at.sx, at.sy], [at.tx, at.ty]] as Pt[] };
    };
    const i = axis === 'x' ? 0 : 1;
    // a run lies at `v` across the axis: the snap held (the run was not pushed off a block it would lie along)
    const lies = (core: Pt[], v: number) => core.some((a, j) => j > 0 && a[i] === v && core[j - 1]![i] === v && a[1 - i] !== core[j - 1]![1 - i]);
    // the run's stretch along its axis, as it is now (a run moved across keeps it)
    const runPts = pointsOfShape(ends, bends);
    const lo = runPts[k]![1 - i], hi = runPts[k + 1]![1 - i];
    run(e, (pointer) => {
      let shape: { state: Shaped; core: Pt[] };
      if (corner) {
        // a corner moves both ways on the grid, with no guide
        shape = shapeAt(pointer);
      } else {
        // Visio's guide (plan 10 phase 2): the run snaps to block edges and centres, the end step's processor middle (the
        // run that slides an end) and any wire's parallel runs, within 12 screen px (the user's, 2026-10-23), and an equal
        // gap to its neighbours (as blocks have): the nearest that holds is taken, the run on its line and no short
        // circuit (`pickSnap`), so a tie with a line it may not take never hides one it may
        const v = axis === 'x' ? pointer.x : pointer.y;
        // the run that slides an end on a step: spaced among the other wires' ends on that side too (the user's, 2026-10-23)
        const cands = ranked(v, snapRun(v, axis, shown.current, wire.id, reach, landings).all,
          [...spaceRuns(v, lo, hi, axis, shown.current, wire.id, reach), ...spaceLanding(v, side, reach)]);
        const shortOf = (x: { state: Shaped; core: Pt[] }) => judge(simplify(x.core), () => shapedCircuit(x.state));
        const kept = pickSnap(cands, (at) => shapeAt(axis === 'x' ? { x: at, y: pointer.y } : { x: pointer.x, y: at }),
          (x, at) => lies(x.core, at), shortOf, () => shapeAt(pointer), (at) => Math.abs(at - v) <= GRID / 2);
        shape = kept.shape;
        // the guide of the line it snapped to, or of one it may not take (a short circuit), shown unsnapped
        const lined = kept.at !== null && !kept.spaced ? kept.at : kept.at === null ? kept.near : null;
        setRunGuides(lined === null ? [] : [guideAt(lined, axis, shown.current, wire.id, [lo, hi])]);
        // the equal-gap marks wherever the run lands evenly spaced, snapped or not (as a block's), but on a short circuit
        const landed = kept.at ?? snap(v);
        setRunGaps(!shortOf(shape) && lies(shape.core, landed) ? onceEach([...runGapMarks(landed, lo, hi, axis, shown.current, wire.id), ...landingMarks(landed, side)]) : []);
      }
      latest = shape.state;
      const now = latest;
      short = judge(simplify(shape.core), () => shapedCircuit(now));
      setHints(short ? [{ id: null, line: false, tone: 'no', why: 'short', at: pointer }] : []);
      // Visio's: the wire stays put and its new route is drawn dashed; nothing is rerouted until release (plan 10)
      const drawn = routeCircuit(shapedCircuit(now), { placement: shown.current.placement, steps: shown.current.graph.steps }).find((x) => x.id === wire.id);
      const shorts = short && drawn ? [...others.stretches(drawn.points, (x) => !share(wire.id, x)).values()].flat().map((st) => [...st]) : [];
      setGhost(drawn ? { wire: wire.id, points: [...drawn.points], ...(shorts.length > 0 ? { shorts } : {}) } : null);
    }, (cancelled, moved) => {
      setGhost(null);
      setHints([]);
      setRunGuides([]);
      setRunGaps([]);
      if (cancelled || !moved || short) return;
      const tidy = latest.bends ? normalize(slid(latest), latest.bends) : null;
      const next = shaped({ ...latest, bends: tidy });
      // dragged back where it was: no step
      if (JSON.stringify(next.wires?.[wire.id]) === JSON.stringify(rec)) return;
      d.onCommit(next);
    });
  };
  /** A run's circle: that run (the user's rule 1, 2026-10-26). */
  const startSegment = (wire: WireRoute, k: number, e: ReactPointerEvent) => startRuns(wire, [k], e);
  /** A corner's circle (core point `c`): the two runs that meet there, diagonally (the user's, 2026-10-26). */
  const startCorner = (wire: WireRoute, c: number, e: ReactPointerEvent) => startRuns(wire, [c - 1, c], e);

  /**
   * Drags one end of wire `id` (plan 9 Â§6). Each move finds what the pointer is over (a block within the drop reach
   * wins over a line; the dragged wire's own line counts except its run at the dragged end), judges the drop on
   * `circuit` (and, with `overlaps`, the path drawn: lying on a wire it may not share a line with is a short circuit,
   * the user's rule 2), and draws the wire there (`path`; `step` sees the pointer first). Released: `done` with an allowed
   * target; a refused one snaps back. With `own` (an end square's drag), one of the wire's own squares under the pointer
   * comes first: "cut here" or "delete wire", and released there `own.done` (the user's rule, 2026-10-09).
   */
  type Aimed = { over: string | null; line: { id: string; at: number } | null; target: DropTarget };
  /**
   * A contact lines up and spaces along it (the user's, 2026-10-23: guides regardless of the contact area): a step side's
   * landing height with block lines, a step's processor middle and any wire's level runs, or evenly among the other
   * wires' landings on that side; a point a wire joins on, along that wire, with the lines across it. The nearest that
   * stays on the same contact, lands exactly there (a landing is on the grid) and is a drop it takes (`takes`: no
   * refusal, no short circuit) is taken; null when none is.
   */
  const contactSnap = (t: DropTarget, p: Point, aim: (q: Point) => Aimed, own: string, takes: (t: DropTarget) => boolean): (Aimed & { guides: RunGuide[]; gaps: GapMark[] }) | null => {
    if (t.on !== 'step' && t.on !== 'wire') return null;
    const doc = shown.current;
    const c = pointOfTarget(doc, t);
    const reach = SNAP_REACH_PX / getZoom();
    let axis: 'x' | 'y' = 'y';
    let side: GuideBox[] = [];
    let landing: number[] = [];
    if (t.on === 'step') {
      side = landingBoxes(doc, own, t.step, t.side);
      const st = doc.placement.steps.get(t.step);
      landing = st ? [st.y + PMID] : [];
    } else {
      const host = doc.wires.find((w) => w.id === t.host);
      axis = host && !contactOn(host.points, t.at).vertical ? 'x' : 'y';
    }
    const v = axis === 'x' ? c.x : c.y;
    const along: [number, number] = axis === 'x' ? [c.y, c.y] : [c.x, c.x];
    const same = (a: DropTarget) => a.on === t.on && (a.on === 'step' ? t.on === 'step' && a.step === t.step && a.side === t.side : a.on === 'wire' && t.on === 'wire' && a.host === t.host);
    for (const k of ranked(v, snapRun(v, axis, doc, own, reach, landing).all, spaceLanding(v, side, reach))) {
      const a = k.at === v ? { over: null, line: null, target: t } as Aimed : aim(axis === 'x' ? { x: p.x + (k.at - v), y: p.y } : { x: p.x, y: p.y + (k.at - v) });
      if (!same(a.target)) continue;
      const q = pointOfTarget(doc, a.target);
      // exactly there, and a drop it takes: never onto another wire's landing (a short circuit) or a refusal
      if ((axis === 'x' ? q.x : q.y) !== k.at || !takes(a.target)) continue;
      const kept = k.at === v ? { ...aim(p), target: t } : a;
      return { ...kept, guides: k.spaced ? [] : [guideAt(k.at, axis, doc, own, along)], gaps: side.length > 0 ? landingMarks(k.at, side) : [] };
    }
    // no snap: the marks where it is already evenly spaced (a drop it takes)
    const gaps = side.length > 0 && takes(t) ? landingMarks(v, side) : [];
    return gaps.length > 0 ? { ...aim(p), target: t, guides: [], gaps } : null;
  };

  const dropGesture = (e: ReactPointerEvent, o: {
    id: string; ghost: string | null; side: Side; circuit: Circuit; path: (t: DropTarget) => Pt[]; done: (t: DropTarget) => void;
    /**
     * Sees the pointer first. It may offer snaps (an end on alignment guides and equal gaps), best first: each a point
     * `at` with its `guides` and equal-gap marks (`gaps`). The first whose end lands on open canvas is taken, only when
     * the end at the pointer does too; `use` says which (-1: none). None taken: the guides of `near` (lines it may not
     * take, short circuits) show unsnapped.
     */
    step?: (p: Point) => { options: { at: Point; guides: RunGuide[]; gaps: GapMark[] }[]; near: RunGuide[]; use: (taken: number) => void } | void; own?: OwnSquares;
    /** The drop drawn as `path` would lie on a wire it may not share a line with (rule 2): "short circuit", it snaps back. */
    overlaps?: (t: DropTarget, path: Pt[]) => boolean;
    /** Released where it was pressed (an AutoConnect arrow's click, plan 10 phase 6): this instead of a drop. */
    click?: () => void;
  }) => {
    let target: DropTarget | null = null;
    let verdict: Verdict = 'move';
    let square: Square | null = null;
    run(e, (p) => {
      const snapped = o.step?.(p);
      square = o.own?.at(p) ?? null;
      if (square && o.own) {
        snapped?.use(-1);
        setRunGuides([]);
        setRunGaps([]);
        verdict = square.kind === 'run' ? 'cut' : 'deleteWire';
        setHints([{ id: null, line: false, tone: toneOf(verdict), why: verdict, at: p }]);
        setGhost(o.own.preview(square));
        return;
      }
      const reach = DROP_REACH / getZoom();
      const aim = (q: Point): Aimed => {
        const over = blockAt(shown.current, q, reach);
        const line = over === null ? wireAt(shown.current, q, LINE_REACH / getZoom(), { id: o.id, side: o.side }) : null;
        return { over, line, target: targetOf(shown.current, o.circuit, q, over, line) };
      };
      const plain = aim(p);
      // a snap only on open canvas (the user's, 2026-10-23): a contact is judged at the pointer and takes its own point;
      // the first snap whose end lands on open canvas too
      let taken = -1;
      let chosen: Aimed = plain;
      if (snapped && plain.target.on === 'open') {
        for (const [j, opt] of snapped.options.entries()) {
          const a = aim(opt.at);
          if (a.target.on === 'open') { taken = j; chosen = a; break; }
        }
      }
      snapped?.use(taken);
      // a contact (a step side, a wire it joins) lines up and spaces too, along it (the user's, 2026-10-23)
      const at = chosen.target.on === 'step' || chosen.target.on === 'wire' ? contactSnap(chosen.target, p, aim, o.id, (x) => toneOf(judgeDrop(shown.current, o.circuit, o.id, o.side, x)) !== 'no' && !o.overlaps?.(x, o.path(x))) : null;
      if (at) chosen = at;
      const { over, line } = chosen;
      target = chosen.target;
      setRunGuides(at ? at.guides : taken >= 0 ? snapped!.options[taken]!.guides : chosen.target.on === 'open' ? snapped?.near ?? [] : []);
      setRunGaps(at ? at.gaps : taken >= 0 ? snapped!.options[taken]!.gaps : []);
      verdict = judgeDrop(shown.current, o.circuit, o.id, o.side, target);
      const path = o.path(target);
      if (toneOf(verdict) !== 'no' && o.overlaps?.(target, path)) verdict = 'short';
      const contact = target.on === 'open' ? null : pointOfTarget(shown.current, target);
      setHints([{ id: line ? line.id : over, line: line !== null, tone: toneOf(verdict), why: verdict, at: p, contact }]);
      setGhost({ wire: o.ghost, points: path });
    }, (cancelled, moved) => {
      setGhost(null);
      setHints([]);
      setRunGuides([]);
      setRunGaps([]);
      if (cancelled) return;
      if (!moved && o.click) { o.click(); return; }
      if (square && o.own) { o.own.done(square); return; }
      if (target === null || toneOf(verdict) === 'no') return;
      o.done(target);
    });
  };

  /**
   * Drags a picked wire's end square (plan 9 Â§6; the user's rule C, 2026-10-09), with the four-way cursor: its tail or
   * its head, connected or open. The end draws its wire like a pen around corners (`Legs`): it follows the pointer with
   * one corner (an L), each 90 degree turn of the pointer fixes the corner where it turned and starts a new leg, and
   * back past a corner takes it away. Released over nothing (or a cache) the end is open there and the wire keeps the
   * drawn shape. Over a step side, the hub or a wire the drop is judged as before (a direction-less wire's end takes
   * the role the side gives it, rule D): allowed, the end is there, the corners drawn kept and only the last leg routed
   * in (a wire that was automatic, with no corner fixed in this drag, stays automatic); refused, it snaps back. A drop
   * where the end already is changes nothing. An end dropped open detaches the wire: the ends joined on it open where
   * they are drawn (spec Â§2.2-6). The wire keeps its id and stays picked. Released on one of the wire's own squares, as
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
    // released open, the leg drawn goes around the blocks (spec Â§4.2): out of the end that stays the way the wire left it
    const out = legs.axis === 'h' ? (legs.dir > 0 ? 0 : 2) : (legs.dir > 0 ? 1 : 3);
    // the leg the router draws into a contact keeps off the other wires (rule 2), as the router does
    const others = new LineIndex();
    for (const x of shown.current.wires) if (x.id !== wire.id) others.add(x.id, x.points);
    const avoid = (pts: Pt[]): number => others.count(pts, () => true);
    // the wires this one may share a line with (rule 2), and how much of a path lies on the others
    const share = mayShare(circuit, netsOf(circuit, (st) => shown.current.graph.steps.get(st)?.entryCondition));
    const strays = (pts: Pt[]): number => others.count(pts, (x) => !share(wire.id, x));
    // where wires land on the steps: each processor middle
    const landings = [...shown.current.placement.steps.values()].map((st) => st.y + PMID);
    /**
     * The path an end released open lies on, from the end that stays: as the pen drew it, its leg around any block it
     * would go through (2026-10-11); when that way lies on another wire, the leg routed as into a contact (on a track
     * no other wire lies on, rule 2) if that one lies on fewer.
     */
    const openPath = (): Pt[] => {
      const pen = legsPath(legs);
      const around = clearDragged(pen, legs.floor, out, boxes);
      if (around === pen || avoid(around) === 0) return around;
      const [ax, ay] = keepShape() ? legs.path[legs.path.length - 1]! : [sx, sy];
      const leg = ghostPath({ x: ax, y: ay }, { x: legs.end[0], y: legs.end[1] }, side, boxes, avoid);
      const routed = simplify([...(keepShape() ? legs.path : [[sx, sy] as Pt]), ...(side === 'head' ? leg : [...leg].reverse())]);
      return avoid(routed) < avoid(around) ? routed : around;
    };
    /** The bends of a path drawn from the end that stays (`oriented`), its lead before the core left out. */
    const bendsOf = (oriented: readonly Pt[]) => shapeFromPoints(stored(coreFrom(oriented, fixed)));
    // an automatic wire with no corner fixed in this drag is routed again onto a step or a line (as before); onto the hub
    // no corner fixed in this drag counts (the user, 2026-10-22): an end moved round the ring draws none, so it moves there
    // freely, and a wire with a shape of its own keeps that shape (an end joined on it stays where it was, rule D)
    const keepShape = (t?: DropTarget) => rec.bends !== undefined || (t?.on !== 'hub' && legs.drawn);
    /** The corners the drop keeps: onto the hub only the wire's own, none fixed in this drag. */
    const penOf = (t: DropTarget): Pt[] => (t.on === 'hub' ? legs.path.slice(0, legs.floor) : legs.path);
    /** The path into target `t` from the end that stays (a hub's lead at the dragged end apart), and that lead. */
    const into = (t: DropTarget): { core: Pt[]; lead: Pt[] } => {
      // the end this one is once dropped: a direction-less wire's end takes the role the side or the hub gives it
      const role: Side = freeWithout(rec, side) ? roleOf(t) ?? side : side;
      const pen = penOf(t);
      const a = pen[pen.length - 1]!;
      let start = pointOfTarget(shown.current, t), lead: Pt[] = [];
      if (t.on === 'hub') {
        // as the wire will be drawn there: a shape kept starts at the ring point on the grid (`hubStart`)
        const { cx, cy } = shown.current.placement.sphere;
        const h = hubStart(cx, cy, t.angle, keepShape(t) ? a[0] : null);
        start = h.start;
        lead = [...h.lead].reverse();
      }
      if (!keepShape(t)) {
        const leg = ghostPath({ x: sx, y: sy }, start, role, boxes, avoid);
        return { core: role === 'head' ? leg : [...leg].reverse(), lead };
      }
      // the last leg: on along the anchor's way when it is vertical, then square into the contact from the side a wire
      // takes it (a head from the left, a tail to the right), so the corner drawn there stays; otherwise routed as a
      // wire leaves its tail (from the anchor to a head, from a tail to the anchor)
      const square = t.on !== 'hub' && legs.axis === 'v' && (t.on === 'wire' || (role === 'head' ? a[0] <= start.x : a[0] >= start.x));
      const leg = ghostPath({ x: a[0], y: a[1] }, start, role, boxes, avoid);
      const fromAnchor: Pt[] = square ? [[a[0], start.y], [start.x, start.y]] : role === 'head' ? leg : [...leg].reverse();
      return { core: simplify([...pen, ...fromAnchor]), lead };
    };
    // the wire's own squares as they are now, but the one being dragged: what it may be released on to cut the wire
    const shape = rec.bends ?? shapeFromPoints(wire.core.points);
    const zoomK = 1 / getZoom();
    const squares = cutTargets(squaresOf(wire, shape, zoomK, true), side);
    const own: OwnSquares = {
      at: (p) => squareAt(squares, p, zoomK),
      preview: (q) => {
        // over its other end square the whole wire goes: faded, with no new route to preview
        if (q.kind !== 'run') return { wire: wire.id, points: [], gone: wire.points, faded: true };
        const { kept, gone } = cutPaths(wire, shape, side, q.k);
        return { wire: wire.id, points: kept, gone };
      },
      done: (q) => {
        const pointOf = endPointOf(shown.current.wires);
        if (q.kind !== 'run') { d.onCommit(removeWires(base, saved, [wire.id], pointOf), { picks: [] }); return; }
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
        const bends = bendsOf(openPath());
        next = setBends(next, wire.id, bends.xs.length > 0 ? bends : null);
        // the other end stays where it is drawn: an automatic end on a step or the hub is held there (`held`), or
        // the fan-out or the landing rule would move it once this end has gone (the user's rule: the other points
        // stay); it goes back to automatic when this end connects again
        next = holdDrawn(next, wire.id, side === 'head' ? 'tail' : 'head', { x: sx, y: sy }, shown.current.placement);
      } else {
        // the corners drawn are kept and only the last leg routed in (rule C); a direction-less wire the drop turns
        // round turns its bends with it (rule D)
        const keep = keepShape(t) ? bendsOf(into(t).core) : t.on === 'hub' ? null : undefined;
        const place = { routes: shown.current.wires, ctx: { placement: shown.current.placement, steps: shown.current.graph.steps } };
        next = applyDrop(circuit, wire.id, side, t, place, keep === undefined || keep === null ? keep : keep.xs.length > 0 ? keep : null).circuit;
      }
      // a host detached (an end dropped open): the ends joined on it open where they are drawn (spec Â§2.2-6)
      if (was.on !== 'open' && end.on === 'open') next = openJoinedOn(next, [wire.id], endPointOf(shown.current.wires));
      return next;
    };
    // a drop that keeps the drawn shape lies where it is drawn: on a wire it may not share a line with it is a short
    // circuit (rule 2); one the router draws again takes a free track by itself
    const judge = overlapJudge(shown.current, wire.id, circuit);
    // what a drop on a contact draws once committed (2026-10-20: the label and the ghost show exactly that, so a drop that
    // reads "join here" never commits a route lying on another wire): the circuit it makes, routed; one per pointer spot
    let routed: { key: string; points: Pt[] | null } | null = null;
    const committed = (t: DropTarget): Pt[] | null => {
      const key = JSON.stringify([t, legs.path, legs.end]);
      if (routed?.key !== key) {
        const r = routeCircuit(dropped(t), { placement: shown.current.placement, steps: shown.current.graph.steps }).find((x) => x.id === wire.id);
        routed = { key, points: r ? [...r.points] : null };
      }
      return routed.points;
    };
    const overlaps = (t: DropTarget, path: Pt[]): boolean => judge(path, () => dropped(t));
    setResize('cross');
    dropGesture(e, {
      id: wire.id, ghost: wire.id, side, circuit, own, overlaps,
      step: (p) => {
        // Visio's guides (the user's, 2026-10-23): the end snaps on each axis to block edges and centres, a step's processor
        // middle and any wire's parallel runs, within 12 screen px; the last leg it draws (upright when the leg before is
        // level, level when it is upright) keeps equal gaps as a run does, whichever is nearer; a snap that would lay it on
        // a wire it may not share a line with, where the plain drag would not, is dropped
        const reach = SNAP_REACH_PX / getZoom();
        const plain = moveLegs(legs, p);
        // the last leg: across `leg` at the end, from the corner it leaves to the end
        const corner = plain.path[plain.path.length - 1]!;
        const leg: 'x' | 'y' = plain.axis === 'h' ? 'x' : 'y';
        const from = leg === 'x' ? corner[1] : corner[0], to = leg === 'x' ? p.y : p.x;
        // each axis's snaps, nearest first: alignments, and equal gaps for the axis the last leg lies across
        const on = (axis: 'x' | 'y', v: number): Candidate[] =>
          ranked(v, snapRun(v, axis, shown.current, wire.id, reach, axis === 'y' ? landings : []).all,
            axis === leg ? spaceRuns(v, from, to, axis, shown.current, wire.id, reach) : []).slice(0, 3);
        const xs = on('x', p.x), ys = on('y', p.y);
        if (xs.length === 0 && ys.length === 0) { legs = plain; return; }
        // both axes first, then one alone: a snap on one axis that fails (on a contact, a short circuit) keeps the other's
        const combos: [Candidate | null, Candidate | null][] = [
          ...xs.flatMap((x) => ys.map((y) => [x, y] as [Candidate, Candidate])),
          ...xs.map((x) => [x, null] as [Candidate, null]), ...ys.map((y) => [null, y] as [null, Candidate]),
        ];
        const plainStrays = strays(legsPath(plain));
        const options: { at: Point; guides: RunGuide[]; gaps: GapMark[]; legs: Legs }[] = [];
        // the guides of the nearest snap it may not take only for a short circuit: shown unsnapped, regardless of colour
        let near: RunGuide[] = [];
        for (const [cx, cy] of combos) {
          const held = moveLegs(legs, p, [cx?.at ?? snap(p.x), cy?.at ?? snap(p.y)]);
          if (strays(legsPath(held)) > 0 && plainStrays === 0) {
            if (near.length === 0) {
              for (const [axis, c, along] of [['x', cx, held.end[1]], ['y', cy, held.end[0]]] as const) {
                if (c !== null && !c.spaced) near.push(guideAt(c.at, axis, shown.current, wire.id, [along, along]));
              }
            }
            continue;
          }
          const [ex, ey] = held.end;
          const guides: RunGuide[] = [];
          for (const [axis, c, along] of [['x', cx, ey], ['y', cy, ex]] as const) {
            if (c !== null && !c.spaced) guides.push(guideAt(c.at, axis, shown.current, wire.id, [along, along]));
          }
          // the last leg's equal-gap marks wherever it lands evenly spaced, whichever snap took it there (the user's,
          // 2026-10-25: an alignment at the same place hid them), as a dragged run's are; its own stretch as it lands
          const [g0, g1] = leg === 'x' ? [corner[1], ey] : [corner[0], ex];
          const gaps = runGapMarks(leg === 'x' ? ex : ey, g0, g1, leg, shown.current, wire.id);
          options.push({ at: { x: ex, y: ey }, guides, gaps, legs: held });
        }
        if (options.length === 0 && near.length === 0) { legs = plain; return; }
        return { options, near, use: (taken) => { legs = taken < 0 ? plain : options[taken]!.legs; } };
      },
      path: (t) => {
        if (t.on === 'open') return stored(openPath());
        const drawn = toneOf(judgeDrop(shown.current, circuit, wire.id, side, t)) === 'no' ? null : committed(t);
        if (drawn) return drawn;
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
   * Drags a wire by its body (the user's rules B and D, 2026-10-09), any wire, picked or not, with Visio's four-way arrow: the
   * whole wire moves rigidly, its drawn path frozen and shifted by the pointer's movement snapped to the grid, and
   * detached from everything, connected ends too (`landBody`): a body drag never stretches a leg. The wire stays as it is,
   * and a faded copy of it shows where it lands until release (Visio's, the user's ruling 2026-10-22). Each end is
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
    // `key`: the grid move and the guided shift it was worked out for
    let landing: (BodyLanding & { key: string }) | null = null;
    // a grid step was made: from then on the press is a drag, even back where it began
    let travelled = false;
    const toggle = e.ctrlKey;
    const others = new LineIndex();
    for (const w of shown.current.wires) if (w.id !== wire.id) others.add(w.id, w.points);
    // Visio's guides for a wire moved whole (the user's, 2026-10-23): with no end over a contact, the wire shifts so its
    // nearest run or end lines up, on each axis within 12 screen px, with a block edge or centre, a step's processor
    // middle or any wire's parallel run, or so a run keeps an equal gap to its neighbours (as blocks do), whichever is
    // nearer; a shift that lays it on a wire it may not share a line with, where the plain move would not, is dropped
    const shares = mayShare(circuit, netsOf(circuit, (st) => shown.current.graph.steps.get(st)?.entryCondition));
    const strays = (pts: readonly Pt[]): number => others.count([...pts], (x) => !shares(wire.id, x));
    const landings = [...shown.current.placement.steps.values()].map((st) => st.y + PMID);
    const path = simplify([...points]);
    type Run = { v: number; lo: number; hi: number };
    // the wire's runs across each axis (x: its vertical runs), and its coordinates there: those runs and its two ends
    const runsOf = (i: 0 | 1): Run[] => path.flatMap((a, j) => {
      const b = path[j - 1];
      return b && b[i] === a[i] && b[1 - i] !== a[1 - i] ? [{ v: a[i]!, lo: b[1 - i]!, hi: a[1 - i]! }] : [];
    });
    const runs = { x: runsOf(0), y: runsOf(1) };
    const coords = { x: [path[0]![0], path[path.length - 1]![0], ...runs.x.map((r) => r.v)], y: [path[0]![1], path[path.length - 1]![1], ...runs.y.map((r) => r.v)] };
    type Guided = { shift: number; at: number; spaced: Run | null };
    /** The shifts on `axis` that line a coordinate up or space a run evenly, moved by `raw` (`across` the other way), nearest first. */
    const guided = (axis: 'x' | 'y', raw: number, across: number): Guided[] => {
      const reach = SNAP_REACH_PX / getZoom();
      const found: (Guided & { d: number })[] = [];
      const consider = (from: number, to: number, spaced: Run | null) => {
        if (!found.some((f) => f.shift === to - from)) found.push({ shift: to - from, at: to, spaced, d: Math.abs(to - (from + raw)) });
      };
      for (const v of new Set(coords[axis])) for (const at of snapRun(v + raw, axis, shown.current, wire.id, reach, axis === 'y' ? landings : []).all) consider(v, at, null);
      for (const r of runs[axis]) for (const at of spaceRuns(r.v + raw, r.lo + across, r.hi + across, axis, shown.current, wire.id, reach)) consider(r.v, at, r);
      // a stable sort: an alignment stays before a gap as near
      return found.sort((a, b) => a.d - b.d).slice(0, 2);
    };
    const open = (l: BodyLanding) => l.ends.every((x) => x.target.on === 'open');
    /**
     * The equal-gap marks where the moved wire lands, whichever snap took it there (the user's, 2026-10-25: a shift that
     * both lines up and spaces showed only its line, and one onto a contact nothing): each of its runs evenly spaced among
     * its neighbours, and each end on a step side among that side's other landings.
     */
    const bodyGaps = (l: BodyLanding): GapMark[] => {
      const pts = simplify([...l.points]);
      const marks: GapMark[] = [];
      for (let j = 1; j < pts.length; j++) {
        const a = pts[j - 1]!, b = pts[j]!;
        if (a[0] === b[0] && a[1] !== b[1]) marks.push(...runGapMarks(a[0], a[1], b[1], 'x', shown.current, wire.id));
        else if (a[1] === b[1] && a[0] !== b[0]) marks.push(...runGapMarks(a[1], a[0], b[0], 'y', shown.current, wire.id));
      }
      for (const e of l.ends) {
        if (e.target.on === 'step' && toneOf(e.verdict) === 'ok') marks.push(...landingMarks(e.at.y, landingBoxes(shown.current, wire.id, e.target.step, e.target.side)));
      }
      return onceEach(marks);
    };
    setResize('move');
    run(e, (p) => {
      const rx = p.x - from.x, ry = p.y - from.y;
      // `|| 0`: a snapped -0 is no move
      const dx = snap(rx) || 0, dy = snap(ry) || 0;
      if (dx !== 0 || dy !== 0) travelled = true;
      if (!travelled) return;
      const gxs = guided('x', rx, dy), gys = guided('y', ry, dx);
      const key = JSON.stringify([dx, dy, gxs.map((g) => g.shift), gys.map((g) => g.shift)]);
      if (landing?.key === key) return;
      const reach = DROP_REACH / getZoom();
      let l = landBody(shown.current, circuit, wire.id, points, drawnAt, dx, dy, landing?.first ?? null, reach, judge);
      if (!open(l)) {
        // an end over a step side: the wire shifted up or down so that end lands evenly spaced among the side's other
        // landings (the user's, 2026-10-25: as an end square's), the nearest that keeps every end it connects
        const snapReach = SNAP_REACH_PX / getZoom();
        const on = (x: BodyLanding) => x.ends.filter((e) => toneOf(e.verdict) === 'ok').map((e) => JSON.stringify(e.target.on === 'step' ? [e.target.step, e.target.side] : e.target.on));
        const was = on(l);
        const shifts = l.ends.flatMap((e) => {
          if (e.target.on !== 'step' || toneOf(e.verdict) !== 'ok') return [];
          const y0 = (e.side === 'tail' ? points[0]! : points[points.length - 1]!)[1]!;
          return spaceLanding(y0 + ry, landingBoxes(shown.current, wire.id, e.target.step, e.target.side), snapReach).map((at) => at - y0);
        }).sort((a, b) => Math.abs(a - ry) - Math.abs(b - ry));
        for (const sy of shifts) {
          if (sy === l.dy) break;
          const g = landBody(shown.current, circuit, wire.id, points, drawnAt, l.dx, sy, landing?.first ?? null, reach, judge);
          if (g.dy === sy && JSON.stringify(on(g)) === JSON.stringify(was)) { l = g; break; }
        }
      }
      const guides: RunGuide[] = [];
      if ((gxs.length > 0 || gys.length > 0) && open(l)) {
        // both axes first, then one alone: a shift on one axis that fails (an end on a contact, a short circuit) keeps the other's
        const combos: [Guided | null, Guided | null][] = [
          ...gxs.flatMap((x) => gys.map((y) => [x, y] as [Guided, Guided])),
          ...gxs.map((x) => [x, null] as [Guided, null]), ...gys.map((y) => [null, y] as [null, Guided]),
        ];
        const plainStrays = strays(l.points);
        // the guides of the nearest shift it may not take only for a short circuit: shown unsnapped, regardless of colour
        let near: RunGuide[] | null = null;
        let taken = false;
        for (const [gx, gy] of combos) {
          const g = landBody(shown.current, circuit, wire.id, points, drawnAt, gx ? gx.shift : dx, gy ? gy.shift : dy, null, reach, judge);
          if (!open(g)) continue;
          if (strays(g.points) > 0 && plainStrays === 0) {
            if (near === null) {
              near = [];
              for (const [axis, h] of [['x', gx], ['y', gy]] as const) {
                if (h === null || h.spaced) continue;
                const i = axis === 'x' ? 1 : 0;
                const vs = g.points.map((q) => q[i]!);
                near.push(guideAt(h.at, axis, shown.current, wire.id, [Math.min(...vs), Math.max(...vs)]));
              }
            }
            continue;
          }
          taken = true;
          l = g;
          // a line for an alignment (a spaced run's marks are measured below, where it lands)
          const show = (axis: 'x' | 'y', h: Guided) => {
            if (h.spaced) return;
            // over the moved wire's whole stretch the other way
            const i = axis === 'x' ? 1 : 0;
            const vs = g.points.map((q) => q[i]!);
            guides.push(guideAt(h.at, axis, shown.current, wire.id, [Math.min(...vs), Math.max(...vs)]));
          };
          if (gx) show('x', gx);
          if (gy) show('y', gy);
          break;
        }
        if (!taken && near) guides.push(...near);
      }
      landing = { ...l, key };
      setRunGuides(guides);
      setRunGaps(bodyGaps(l));
      setHints(l.ends.map((x) => ({ id: x.id, line: x.line, tone: toneOf(x.verdict), why: x.verdict, at: x.at })));
      // shifted back exactly where it was: drawn as it was
      if (l.dx === 0 && l.dy === 0) { setGhost(null); return; }
      // Visio's: the wire stays as it is, and a faded copy of it lies where it lands; nothing is rerouted until release
      const drawn = routeCircuit(l.preview, { placement: shown.current.placement, steps: shown.current.graph.steps }).find((x) => x.id === wire.id);
      // a short circuit: the stretches it would share with wires it may not share a line with, red (the user's rule 2)
      const share = mayShare(l.preview, netsOf(l.preview, (st) => shown.current.graph.steps.get(st)?.entryCondition));
      const shorts = drawn && l.ends.some((x) => x.verdict === 'short') ? [...others.stretches(drawn.points, (x) => !share(wire.id, x)).values()].flat().map((st) => [...st]) : [];
      setGhost(drawn ? { wire: wire.id, points: [...drawn.points], body: true, ...(shorts.length > 0 ? { shorts } : {}) } : null);
    }, (cancelled, pressMoved) => {
      setGhost(null);
      setHints([]);
      setRunGuides([]);
      setRunGaps([]);
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
   * Draws a new wire from a step's output or the hub (spec Â§4.5): automatic at its tail, its head judged as any head
   * (plan 9 Â§6); released on nothing it is a grey wire open at its head. It becomes the pick.
   */
  const startNew = (source: SourceId, e: ReactPointerEvent, click?: () => void) => {
    const d = designRef.current;
    if (!d || e.button !== 0) return;
    const base = d.draft;
    const { placement } = shown.current;
    const from = portOf(placement, source) ?? { x: STEP_W, y: PMID };
    const id = `${NEW_WIRE_PREFIX}${newId()}`;
    const tail: End = source === WORKFLOW_SOURCE ? { on: 'hub', angle: null } : { on: 'step', step: source, y: null };
    const circuit = addCircuitWire(circuitOf(saved, base), id, { tail, head: { on: 'open', x: from.x, y: from.y } });
    const boxes = blockBoxes(placement);
    setResize('cross');
    dropGesture(e, {
      id, ghost: null, side: 'head', circuit,
      path: (t) => ghostPath(from, pointOfTarget(shown.current, t), 'head', boxes),
      done: (t) => d.onCommit(withCircuit(base, saved, setEnd(circuit, id, 'head', endOf(t))), { picks: [{ kind: 'wire', id }] }),
      ...(click ? { click } : {}),
    });
  };

  /**
   * Draws a new wire into step `step`'s input from the pointer (an AutoConnect left arrow dragged, plan 10 phase 6): its
   * head automatic on the input, its tail judged as any tail; released on nothing it is open there. Released where it
   * was pressed, `click` instead.
   */
  const startInto = (step: Id, e: ReactPointerEvent, click: () => void) => {
    const d = designRef.current;
    if (!d || e.button !== 0) return;
    const base = d.draft;
    const { placement } = shown.current;
    const at = placement.steps.get(step);
    if (!at) return;
    const into = { x: at.x, y: at.y + PMID };
    const id = `${NEW_WIRE_PREFIX}${newId()}`;
    const circuit = addCircuitWire(circuitOf(saved, base), id, { tail: { on: 'open', x: into.x, y: into.y }, head: { on: 'step', step, y: null } });
    const boxes = blockBoxes(placement);
    setResize('cross');
    dropGesture(e, {
      id, ghost: null, side: 'tail', circuit, click,
      path: (t) => ghostPath(into, pointOfTarget(shown.current, t), 'tail', boxes),
      done: (t) => d.onCommit(withCircuit(base, saved, setEnd(circuit, id, 'tail', endOf(t))), { picks: [{ kind: 'wire', id }] }),
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

  const latestRef = useRef({ startBody, startNew, startInto });
  latestRef.current = { startBody, startNew, startInto };
  // the AutoConnect arrow under the pointer (plan 10 phase 6): the canvas previews what its click does
  const [autoHover, setAutoHover] = useState<{ id: string; dir: Dir } | null>(null);

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
    arrowPointerDown(id, dir, e) {
      // dragged, a wire as from a connection point; a click, Visio's AutoConnect
      const click = () => { setAutoHover(null); designRef.current?.onAutoConnect?.(id, dir); };
      if (dir === 'left') latestRef.current.startInto(id, e, click);
      else latestRef.current.startNew(id === SPHERE_NODE_ID ? WORKFLOW_SOURCE : id, e, click);
    },
    arrowHover(at) {
      setAutoHover(at);
    },
  }), [shown]);

  // a drag's cursor only while that drag runs (a run's double arrow, an end's crosshair, a body's four-way arrow)
  return { gestures, startSegment, startCorner, startEnd, ghost, hints, runGuides, runGaps, active, running, resize: active ? resize : null, keys, autoHover };
}
