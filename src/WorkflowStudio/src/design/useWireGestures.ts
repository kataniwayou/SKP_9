import { useEffect, useMemo, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { StudioDocument } from '../app/document';
import { clearBends, clearPath, clearRun } from '../layout/detour';
import { clampLanding, PMID, snap, STEP_W, type Point } from '../layout/geometry';
import { WORKFLOW_SOURCE, type SourceId } from '../layout/ports';
import { route, type Box, type Pt } from '../layout/router';
import { dragSegment, endsOf, nearestSegment, normalize, shapeFromPoints, type Bends, type WireShape } from '../layout/shape';
import { CACHE_NODE_PREFIX, SPHERE_NODE_ID } from '../layout/nodeIds';
import { blockBoxes, portOf, SPHERE_BOX_ID, stepBoxId, type WireRoute } from '../layout/wires';
import type { DesignGestures } from './DesignContext';
import type { DesignProps } from './designProps';
import { addLoose, addWire, attachLoose, LOOSE_PREFIX, loosen, moveLoose, reattach, setShape, wireId, type Draft } from './draft';
import { blockAt, wireAt } from './hit';
import { newId } from './ids';
import { canJoin, canWire, type DropVerdict, type JoinVerdict, type Refusal } from './rules';

/** The block or line under a dragged wire end: its outline or halo (tone), why (the drop rule's verdict) and where the pointer is, for the label. */
export interface DropHint {
  /** The block (node id) or, when `line`, the wire under the pointer; null over empty canvas. */
  id: string | null;
  /** Over a wire's line, not a block (plan 7). */
  line: boolean;
  /** green: the drop attaches; grey: the wire becomes loose there (plan 8 §5); red: it snaps back. */
  tone: 'ok' | 'loose' | 'no';
  /** 'move': a wire end back on its own step slides its contact point there; 'here': a tail back on its own step stays. */
  why: DropVerdict | 'move' | 'here' | JoinVerdict | Refusal;
  /** A new wire, not a re-attached end: an allowed drop says "connect here". */
  newWire: boolean;
  /** The pointer, in flow coordinates. */
  at: Point;
}

/** A dragged wire end's wire, right-angled from its fixed end to the pointer; `wire` null: a new wire. */
export interface WireGhost {
  wire: string | null;
  /** The dragged arrow of a joined wire moves its branch, not its own line (plan 7 §6.2). */
  part?: 'branch';
  points: Pt[];
}

const boxOf = (source: SourceId) => (source === WORKFLOW_SOURCE ? SPHERE_BOX_ID : stepBoxId(source));

/**
 * Where a dragged wire's free end is drawn (spec §4.4): at the pointer on empty canvas; over a block, on
 * its border, never inside it. A wire lands on a block's left side (a step's landing band) and leaves a
 * block's right side (a step's port, the hub's middle). `over` is the block `blockAt` found under the
 * pointer (node id, the drop reach included), so the end snaps exactly where the drop is judged (plan 7
 * §6.1a); `box` is that block's router id, or '' on empty canvas.
 */
export function freeEnd(p: Point, end: 'source' | 'target', boxes: Box[], over: string | null): { x: number; y: number; box: string } {
  const id = over === null ? null : over === SPHERE_NODE_ID || over.startsWith(CACHE_NODE_PREFIX) ? over : stepBoxId(over);
  const b = id === null ? undefined : boxes.find((x) => x.id === id);
  if (!b) return { x: p.x, y: p.y, box: '' };
  const isStep = b.id.startsWith('step:');
  const along = (v: number) => b.y + Math.min(Math.max(snap(v - b.y), 16), b.h - 16);
  if (end === 'target') return { x: b.x, y: isStep ? b.y + clampLanding(p.y - b.y) : along(p.y), box: b.id };
  return { x: b.x + b.w, y: isStep ? b.y + PMID : b.id === SPHERE_BOX_ID ? b.y + b.h / 2 : along(p.y), box: b.id };
}

/** Which run of the dragged shape is the one under the pointer (`dragSegment`'s run k of a shape with n verticals). */
function draggedRun(n: number, k: number): { vertical: boolean; index: number } {
  if (n === 0 || k === 0) return { vertical: false, index: 0 };
  return k % 2 === 1 ? { vertical: true, index: (k - 1) / 2 } : { vertical: false, index: k / 2 - 1 };
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
 * Editing wires (spec §4.2-§4.5): dragging a picked wire's run square, or its body, moves that run (the
 * first drag makes the wire manual, the last run slides the landing); dragging an end dot re-attaches
 * that end; dragging from a block's connection point draws a new wire. Each finished drag is one history
 * step; Escape cancels it (spec §5.3).
 */
export function useWireGestures(
  saved: StudioDocument,
  shown: MutableRefObject<StudioDocument>,
  design: DesignProps | undefined,
  setPreview: (d: Draft | null) => void,
) {
  const [active, setActive] = useState(false);
  const { run, abort, running } = useGesture(setActive);
  const { screenToFlowPosition, getZoom } = useReactFlow();
  // the dragged end's line, and the outline of the block under it (spec §4.4)
  const [ghost, setGhost] = useState<WireGhost | null>(null);
  const [hint, setHint] = useState<DropHint | null>(null);
  // the drag's double-arrow cursor: a horizontal run (even k) moves up and down; an end leaves its block sideways;
  // a joined wire's contact moves any way along lines (four-way, plan 7 §6.2)
  const [resize, setResize] = useState<'ns' | 'ew' | 'move' | null>(null);
  const designRef = useRef(design);
  designRef.current = design;

  // design mode ending mid-drag drops the drag and its preview
  const designOff = design === undefined;
  useEffect(() => {
    if (designOff) { abort(); setPreview(null); setGhost(null); setHint(null); }
  }, [designOff]); // abort and setPreview read refs and React state setters: no need to re-run for them

  /** Drags run k of a wire (spec §4.2): the first drag makes the wire manual; the last run slides the landing. */
  const startSegment = (wire: WireRoute, k: number, e: ReactPointerEvent) => {
    const d = designRef.current;
    if (!d || e.button !== 0) return;
    const base = d.draft;
    const existing = base.routes[wire.id];
    // a joined wire's runs are its own line's, from its start to its contact (plan 7 §6.2)
    const ends = wire.joint?.ownEnds ?? endsOf(wire.points);
    const bends: Bends = existing?.bends ?? shapeFromPoints(wire.joint?.own ?? wire.points);
    // a joined wire's last own run ends on its host: it does not slide a landing
    if (wire.joint && k === 2 * bends.xs.length) return;
    // a run drag keeps the wire's junction
    const contact = existing?.contact ?? null;
    const targetY = shown.current.placement.steps.get(wire.target)?.y ?? 0;
    // a dragged wire goes around the blocks, never through one (spec §4.2)
    const boxes = blockBoxes(shown.current.placement);
    let latest: WireShape = { bends: existing?.bends ?? null, landing: existing?.landing ?? null, contact };
    setResize(k % 2 === 0 ? 'ns' : 'ew');
    run(e, (p) => {
      const r = dragSegment(bends, k, p, ends);
      if ('landingY' in r) {
        const landing = clampLanding(r.landingY - targetY);
        latest = { bends: bends.xs.length > 0 ? clearBends({ ...ends, ty: targetY + landing }, bends, boxes) : null, landing, contact };
      } else {
        // the run under the pointer is pushed off any block it would lie on; the rest detours around blocks
        const run = clearRun(r.bends, ends, draggedRun(bends.xs.length, k), boxes);
        latest = { bends: clearBends(ends, run, boxes), landing: latest.landing, contact };
      }
      setPreview(setShape(base, wire.id, latest));
    }, (cancelled, moved) => {
      setPreview(null);
      if (cancelled || !moved) return;
      // a joined wire's own line ends at its contact: its landing is the branch's, not this line's
      const ty = wire.joint ? ends.ty : latest.landing !== null ? targetY + latest.landing : ends.ty;
      const tidy = latest.bends ? normalize({ ...ends, ty }, latest.bends) : null;
      const next = setShape(base, wire.id, { bends: tidy, landing: latest.landing, contact });
      // dragged back where it was: no step
      if (JSON.stringify(next.routes[wire.id] ?? null) === JSON.stringify(base.routes[wire.id] ?? null)) return;
      d.onCommit(next);
    });
  };

  /** What a line under a dragged arrow end does (plan 7 §6.1): joins it when the rule allows. */
  interface LineDrop {
    /** May the wire join this host? */
    verdict: (host: string) => JoinVerdict;
    /** The draft while hovering an allowed line: the wire drawn joined there. */
    preview: (host: string, at: number) => Draft;
    done: (host: string, at: number) => void;
  }

  /**
   * Drags a wire end, drawn as `path` to the pointer (plan 8 §5). Over a block `verdict` decides: green when the
   * drop attaches, grey "loose wire" when it would make the wire loose (only when `loose` is given), red when it
   * snaps back; `current` (the end's own block) is green with the `selfWhy` label and runs `onSelf`. With no
   * block, a wire's line within the drop reach is judged by `line` (absent: lines are no drop target), and empty
   * canvas makes the wire loose. On release: `done`, `line.done`, `onSelf`, `loose`, or nothing (it snaps back).
   */
  const dropGesture = (e: ReactPointerEvent, o: {
    wire: string | null; path: (p: Point, over: string | null) => Pt[]; current: string | null; verdict: (over: string) => DropVerdict;
    done: (over: string, p: Point) => void;
    /** Dropped back on `current`; required whenever `current` is set. */
    onSelf?: (p: Point) => void;
    /** The label over `current`: 'move' (a head slides its contact) or 'here' (a tail stays where it starts). */
    selfWhy?: 'move' | 'here';
    /** What a wire's line under the pointer does: joins (`LineDrop`) or refuses (a start); absent, lines are not drop targets. */
    line?: LineDrop | Refusal;
    /** Released where it attaches to nothing: the wire becomes loose there (plan 8 §5); absent, it snaps back. */
    loose?: (p: Point) => void;
    /** A joined wire's arrow: the ghost is its branch (plan 7 §6.2). */
    part?: 'branch';
  }) => {
    let over: string | null = null;
    let onLine: { id: string; at: number } | null = null;
    let at: Point = { x: 0, y: 0 };
    const newWire = o.wire === null;
    // the drawn end snaps to the very block the drop is judged over: one hit test (plan 7 §6.1a)
    const ghost = (p: Point) => setGhost({ wire: o.wire, part: o.part, points: o.path({ x: snap(p.x), y: snap(p.y) }, over) });
    const hintFor = (id: string | null, line: boolean, why: DropHint['why'], p: Point): DropHint | null => {
      if (why === 'ok' || why === 'move' || why === 'here') return { id, line, tone: 'ok', why, newWire, at: p };
      if (why === 'loose') return o.loose ? { id, line, tone: 'loose', why, newWire, at: p } : id === null ? null : { id, line, tone: 'no', why, newWire, at: p };
      return id === null ? null : { id, line, tone: 'no', why, newWire, at: p };
    };
    run(e, (p) => {
      at = p;
      // a block counts from the drop reach outside its border, like a line (plan 7 §6.1a)
      over = blockAt(shown.current, p, DROP_REACH / getZoom());
      // a block wins over a line; the dragged wire itself is never the drop target
      onLine = over === null && o.line !== undefined ? wireAt(shown.current, p, DROP_REACH / getZoom(), o.wire) : null;
      if (onLine && typeof o.line === 'object') {
        const why = o.line.verdict(onLine.id);
        setHint(hintFor(onLine.id, true, why, p));
        // an allowed line: the wire is drawn joined there (the preview) instead of the ghost
        if (why === 'ok') { setGhost(null); setPreview(o.line.preview(onLine.id, onLine.at)); return; }
      } else if (onLine) setHint(hintFor(onLine.id, true, o.line as Refusal, p));
      else if (over === null) setHint(hintFor(null, false, 'loose', p));
      else if (over === o.current) setHint(hintFor(over, false, o.selfWhy ?? 'move', p));
      else setHint(hintFor(over, false, o.verdict(over), p));
      setPreview(null);
      ghost(p);
    }, (cancelled) => {
      setGhost(null);
      setHint(null);
      setPreview(null);
      if (cancelled) return;
      const end = { x: snap(at.x), y: snap(at.y) };
      if (onLine && typeof o.line === 'object') {
        const why = o.line.verdict(onLine.id);
        if (why === 'ok') o.line.done(onLine.id, onLine.at);
        else if (why === 'loose') o.loose?.(end);
        return;
      }
      if (onLine) return; // a start over a line snaps back
      if (over === null) { o.loose?.(end); return; }
      if (over === o.current) { o.onSelf?.(at); return; }
      const why = o.verdict(over);
      if (why === 'ok') o.done(over, at);
      else if (why === 'loose') o.loose?.(end);
    });
  };

  /** A head released where it attaches to nothing: the wire leaves the wiring, loose from its source there (plan 8 §5). */
  const loosenAt = (d: DesignProps, base: Draft, wire: WireRoute) => (p: Point) => {
    const id = newId();
    d.onCommit(loosen(base, saved, wire.id, id, p), { picks: [{ kind: 'wire', id: `${LOOSE_PREFIX}${id}` }] });
  };

  /** A new wire from `from` (its source's port) to the pointer, right-angled around the blocks: the ghost of a new or a loose wire. */
  const fromPort = (source: SourceId, from: Point, boxes: Box[]) => (p: Point, over: string | null) => {
    const f = freeEnd(p, 'target', boxes, over);
    return clearPath(route(from.x, from.y, f.x, f.y, boxOf(source), f.box, 0, boxes), boxes);
  };

  /**
   * Drags a picked wire's end square (spec §4.4). Onto another block: the wire re-attaches there, automatic,
   * its arrow landing where it was dropped. Back onto its own step: the arrow's contact point moves there.
   * A head released where it attaches to nothing makes the wire loose there (plan 8 §5); a tail never does:
   * it snaps back, a loose wire always keeps its source.
   */
  const startEnd = (wire: WireRoute, end: 'source' | 'target', e: ReactPointerEvent) => {
    const d = designRef.current;
    if (!d || e.button !== 0) return;
    const base = d.draft;
    const ends = endsOf(wire.points);
    const boxes = blockBoxes(shown.current.placement);
    // the wire itself follows the pointer, right-angled from the end that stays: it leaves a source and lands heading right
    const path = end === 'target'
      ? (p: Point, over: string | null) => { const f = freeEnd(p, 'target', boxes, over); return clearPath(route(ends.sx, ends.sy, f.x, f.y, boxOf(wire.source), f.box, 0, boxes), boxes); }
      : (p: Point, over: string | null) => { const f = freeEnd(p, 'source', boxes, over); return clearPath(route(f.x, f.y, ends.tx, ends.ty, f.box, stepBoxId(wire.target), 0, boxes), boxes); };
    const landingAt = (step: string, p: Point) => clampLanding(p.y - (shown.current.placement.steps.get(step)?.y ?? 0));
    const current = end === 'target' ? wire.target : wire.source;
    // joined on a line (plan 7 §6.1): its own line automatic, its landing kept
    const joined = (host: string, at: number) => setShape(base, wire.id, { bends: null, landing: base.routes[wire.id]?.landing ?? null, contact: { host, at: snap(at) } });
    // a joined wire's contact square: the four-way cursor (plan 7 §6.2)
    setResize(wire.joint && end === 'target' ? 'move' : 'ew');
    // a loose wire keeps its source, so a tail never makes one: where a head would be loose, a tail cannot start
    const startOnly = (v: DropVerdict): DropVerdict => (v === 'loose' ? 'cannotStart' : v);
    dropGesture(e, {
      wire: wire.id, path, current,
      verdict: (over) => (end === 'target' ? canWire(shown.current, wire.source, over, wire.id) : startOnly(canWire(shown.current, over, wire.target, wire.id))),
      done: (over, p) => {
        const id = end === 'target' ? wireId(wire.source, over) : wireId(over, wire.target);
        const next = reattach(d.draft, saved, wire.id, end, over);
        d.onCommit(end === 'target' ? setShape(next, id, { bends: null, landing: landingAt(over, p) }) : next, { picks: [{ kind: 'wire', id }] });
      },
      onSelf: end === 'target' ? (p) => {
        // its own step: the contact point slides along the landing band; the shape it had stays
        const landing = landingAt(wire.target, p);
        // a joined wire's contact square back on its own step: the wire is plain again (plan 7 §6.3)
        if (wire.joint) { d.onCommit(setShape(base, wire.id, { bends: null, landing, contact: null }), { picks: [{ kind: 'wire', id: wire.id }] }); return; }
        const step = shown.current.placement.steps.get(wire.target);
        if (!step || step.y + landing === ends.ty) return;
        d.onCommit(setShape(d.draft, wire.id, { bends: d.draft.routes[wire.id]?.bends ?? null, landing }), { picks: [{ kind: 'wire', id: wire.id }] });
      } : () => {}, // a tail back on its own step: its start is fixed to the step's output port, so nothing changes
      selfWhy: end === 'target' ? 'move' : 'here',
      loose: end === 'target' ? loosenAt(d, base, wire) : undefined,
      // only an arrow end joins a line; a start stays on a block
      line: end === 'target' ? {
        verdict: (host) => canJoin(shown.current, wire.id, host),
        preview: joined,
        done: (host, at) => d.onCommit(joined(host, at), { picks: [{ kind: 'wire', id: wire.id }] }),
      } : 'start',
    });
  };

  /** Drags a joined wire's arrow (its branch end) to another step: re-attached, its contact kept (plan 7 §6.2). */
  const startArrow = (wire: WireRoute, e: ReactPointerEvent) => {
    const d = designRef.current;
    if (!d || e.button !== 0 || !wire.joint?.split) return;
    const base = d.draft;
    const shape = base.routes[wire.id];
    // the branch leaves the split dot: it follows the pointer from there
    const [sx, sy] = wire.joint.split;
    const boxes = blockBoxes(shown.current.placement);
    const landingAt = (step: string, p: Point) => clampLanding(p.y - (shown.current.placement.steps.get(step)?.y ?? 0));
    setResize('ew');
    dropGesture(e, {
      wire: wire.id,
      path: (p, over) => { const f = freeEnd(p, 'target', boxes, over); return clearPath(route(sx, sy, f.x, f.y, '', f.box, 0, boxes), boxes); },
      current: wire.target,
      verdict: (over) => canWire(shown.current, wire.source, over, wire.id),
      done: (over, p) => {
        const id = wireId(wire.source, over);
        const next = reattach(base, saved, wire.id, 'target', over);
        // the contact is kept; on a step of another colour it is ignored (drawn plain, plan 7 §5.2)
        d.onCommit(setShape(next, id, { bends: shape?.bends ?? null, landing: landingAt(over, p), contact: shape?.contact ?? null }), { picks: [{ kind: 'wire', id }] });
      },
      // back on its own step: the arrow's landing moves there; at the height it already has, no step
      onSelf: (p) => {
        const landing = landingAt(wire.target, p);
        const step = shown.current.placement.steps.get(wire.target);
        const tip = wire.joint!.branch[wire.joint!.branch.length - 1];
        if (!step || (tip && step.y + landing === tip[1])) return;
        d.onCommit(setShape(base, wire.id, { bends: shape?.bends ?? null, landing, contact: shape?.contact ?? null }), { picks: [{ kind: 'wire', id: wire.id }] });
      },
      // the arrow ignores lines (only the contact square joins one); released where it attaches to nothing, the wire is loose
      loose: loosenAt(d, base, wire),
      part: 'branch',
    });
  };

  /** Draws a new wire from a step's output side or the hub (spec §4.5); it is automatic and becomes the pick. */
  const startNew = (source: string, e: ReactPointerEvent) => {
    const d = designRef.current;
    if (!d || e.button !== 0) return;
    const { placement } = shown.current;
    const from = portOf(placement, source) ?? { x: STEP_W, y: PMID };
    const boxes = blockBoxes(placement);
    setResize(null);
    dropGesture(e, {
      wire: null, path: fromPort(source, from, boxes), current: null,
      verdict: (over) => canWire(shown.current, source, over),
      done: (over) => d.onCommit(addWire(d.draft, saved, source, over), { picks: [{ kind: 'wire', id: wireId(source, over) }] }),
      // a new wire ignores lines (it can be joined afterwards by its arrow); released where it attaches to nothing,
      // it is kept as a loose wire from its source (plan 8 §5)
      loose: (p) => {
        const id = newId();
        d.onCommit(addLoose(d.draft, id, source, p), { picks: [{ kind: 'wire', id: `${LOOSE_PREFIX}${id}` }] });
      },
    });
  };

  /**
   * Drags a loose wire's open end (plan 8 §5): onto a step it may wire to, it becomes an ordinary wire; anywhere
   * else its end moves there; back on its own source it snaps back ("same step").
   */
  const startLoose = (looseId: string, e: ReactPointerEvent) => {
    const d = designRef.current;
    if (!d || e.button !== 0) return;
    const base = d.draft;
    const l = base.loose[looseId];
    if (!l) return;
    const { placement } = shown.current;
    const from = portOf(placement, l.source) ?? { x: STEP_W, y: PMID };
    const boxes = blockBoxes(placement);
    setResize(null);
    dropGesture(e, {
      wire: null, path: fromPort(l.source, from, boxes), current: null,
      verdict: (over) => canWire(shown.current, l.source, over),
      done: (over) => d.onCommit(attachLoose(base, saved, looseId, over), { picks: [{ kind: 'wire', id: wireId(l.source, over) }] }),
      loose: (p) => d.onCommit(moveLoose(base, looseId, p), { picks: [{ kind: 'wire', id: `${LOOSE_PREFIX}${looseId}` }] }),
    });
  };

  /** The press point in flow coordinates (React Flow's own transform, so a pop-out's window works too). */
  const flowPointOf = (e: ReactPointerEvent): Point => screenToFlowPosition({ x: e.clientX, y: e.clientY }, { snapToGrid: false });
  const latestRef = useRef({ startSegment, startNew, startLoose, flowPointOf });
  latestRef.current = { startSegment, startNew, startLoose, flowPointOf };

  // stable, so every wire does not re-render with each canvas render
  const gestures = useMemo<DesignGestures>(() => ({
    wirePointerDown(wireId, e, part = 'own') {
      // the branch is automatic: it has no runs to drag (plan 7)
      if (part === 'branch') return;
      const d = designRef.current;
      if (!d || e.button !== 0 || !d.picks.some((p) => p.kind === 'wire' && p.id === wireId)) return;
      const wire = shown.current.wires.find((w) => w.id === wireId);
      if (!wire) return;
      // dragging a picked wire's body drags its nearest run, and never detaches it (spec §4.2)
      const bends = d.draft.routes[wireId]?.bends ?? shapeFromPoints(wire.joint?.own ?? wire.points);
      const { startSegment: start, flowPointOf } = latestRef.current;
      start(wire, nearestSegment(wire.joint?.ownEnds ?? endsOf(wire.points), bends, flowPointOf(e)), e);
    },
    portPointerDown(source, e) {
      latestRef.current.startNew(source, e);
    },
    looseEndPointerDown(looseId, e) {
      latestRef.current.startLoose(looseId, e);
    },
  }), [shown]);

  // a run or end drag's cursor only while that drag runs; a new wire keeps the closed hand
  return { gestures, startSegment, startEnd, startArrow, ghost, hint, active, running, resize: active ? resize : null };
}
