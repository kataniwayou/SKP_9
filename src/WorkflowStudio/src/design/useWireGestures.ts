import { useEffect, useMemo, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { StudioDocument } from '../app/document';
import { clampLanding, PMID, SPHERE_R, STEP_W, type Point } from '../layout/geometry';
import { WORKFLOW_SOURCE } from '../layout/ports';
import { dragSegment, endsOf, nearestSegment, normalize, shapeFromPoints, type Bends } from '../layout/shape';
import type { WireRoute } from '../layout/wires';
import type { DesignGestures } from './DesignContext';
import type { DesignProps } from './designProps';
import { addWire, reattach, setShape, wireId, type Draft } from './draft';
import { blockAt } from './hit';
import { canWire, type DropVerdict } from './rules';

/** The block under a dragged wire end: its outline (ok), why (the drop rule's verdict) and where the pointer is, for the label. */
export interface DropHint {
  id: string;
  ok: boolean;
  why: DropVerdict;
  /** A new wire, not a re-attached end: an allowed drop says "connect here". */
  newWire: boolean;
  /** The pointer, in flow coordinates. */
  at: Point;
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
  const { screenToFlowPosition } = useReactFlow();
  // the dragged end's line, and the outline of the block under it (spec §4.4)
  const [ghost, setGhost] = useState<{ from: Point; to: Point } | null>(null);
  const [hint, setHint] = useState<DropHint | null>(null);
  // the way a dragged run moves, for its double-arrow cursor: a horizontal run (even k) moves up and down
  const [resize, setResize] = useState<'ns' | 'ew' | null>(null);
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
    const ends = endsOf(wire.points);
    const bends: Bends = existing?.bends ?? shapeFromPoints(wire.points);
    const targetY = shown.current.placement.steps.get(wire.target)?.y ?? 0;
    let latest: { bends: Bends | null; landing: number | null } = { bends: existing?.bends ?? null, landing: existing?.landing ?? null };
    setResize(k % 2 === 0 ? 'ns' : 'ew');
    run(e, (p) => {
      const r = dragSegment(bends, k, p, ends);
      latest = 'landingY' in r
        ? { bends: bends.xs.length > 0 ? bends : null, landing: clampLanding(r.landingY - targetY) }
        : { bends: r.bends, landing: latest.landing };
      setPreview(setShape(base, wire.id, latest));
    }, (cancelled, moved) => {
      setPreview(null);
      if (cancelled || !moved) return;
      const ty = latest.landing !== null ? targetY + latest.landing : ends.ty;
      const tidy = latest.bends ? normalize({ ...ends, ty }, latest.bends) : null;
      const next = setShape(base, wire.id, { bends: tidy, landing: latest.landing });
      // dragged back where it was: no step
      if (JSON.stringify(next.routes[wire.id] ?? null) === JSON.stringify(base.routes[wire.id] ?? null)) return;
      d.onCommit(next);
    });
  };

  /**
   * Drags a wire end from `from` (spec §4.4, option "a"): the block under the pointer is outlined green
   * when `verdict` allows the drop and red when not; `current` (the end's own block) is not outlined.
   * Dropped on an allowed block, `done` commits; anywhere else, refused, or back on `current`, nothing
   * changes and no step is made.
   */
  const dropGesture = (e: ReactPointerEvent, from: Point, current: string | null, verdict: (over: string) => DropVerdict, done: (over: string) => void, newWire = false) => {
    let over: string | null = null;
    setResize(null);
    run(e, (p) => {
      setGhost({ from, to: p });
      over = blockAt(shown.current, p);
      if (over === null || over === current) setHint(null);
      else { const why = verdict(over); setHint({ id: over, ok: why === 'ok', why, newWire, at: p }); }
    }, (cancelled) => {
      setGhost(null);
      setHint(null);
      if (cancelled || over === null || over === current || verdict(over) !== 'ok') return;
      done(over);
    });
  };

  /** Drags a picked wire's arrow head or start dot onto another block; the wire becomes automatic (spec §4.4). */
  const startEnd = (wire: WireRoute, end: 'source' | 'target', e: ReactPointerEvent) => {
    const d = designRef.current;
    if (!d || e.button !== 0) return;
    const ends = endsOf(wire.points);
    // the ghost runs from the end that stays
    const from = end === 'target' ? { x: ends.sx, y: ends.sy } : { x: ends.tx, y: ends.ty };
    const current = end === 'target' ? wire.target : wire.source;
    dropGesture(e, from, current,
      (over) => (end === 'target' ? canWire(shown.current, wire.source, over, wire.id) : canWire(shown.current, over, wire.target, wire.id)),
      (over) => {
        const id = end === 'target' ? wireId(wire.source, over) : wireId(over, wire.target);
        d.onCommit(reattach(d.draft, saved, wire.id, end, over), { picks: [{ kind: 'wire', id }] });
      });
  };

  /** Draws a new wire from a step's output side or the hub (spec §4.5); it is automatic and becomes the pick. */
  const startNew = (source: string, e: ReactPointerEvent) => {
    const d = designRef.current;
    if (!d || e.button !== 0) return;
    const { placement } = shown.current;
    const at = placement.steps.get(source);
    const from = source === WORKFLOW_SOURCE
      ? { x: placement.sphere.cx + SPHERE_R, y: placement.sphere.cy }
      : { x: (at?.x ?? 0) + STEP_W, y: (at?.y ?? 0) + PMID };
    dropGesture(e, from, null, (over) => canWire(shown.current, source, over), (over) => {
      d.onCommit(addWire(d.draft, saved, source, over), { picks: [{ kind: 'wire', id: wireId(source, over) }] });
    }, true);
  };

  /** The press point in flow coordinates (React Flow's own transform, so a pop-out's window works too). */
  const flowPointOf = (e: ReactPointerEvent): Point => screenToFlowPosition({ x: e.clientX, y: e.clientY }, { snapToGrid: false });
  const latestRef = useRef({ startSegment, startNew, flowPointOf });
  latestRef.current = { startSegment, startNew, flowPointOf };

  // stable, so every wire does not re-render with each canvas render
  const gestures = useMemo<DesignGestures>(() => ({
    wirePointerDown(wireId, e) {
      const d = designRef.current;
      if (!d || e.button !== 0 || !d.picks.some((p) => p.kind === 'wire' && p.id === wireId)) return;
      const wire = shown.current.wires.find((w) => w.id === wireId);
      if (!wire) return;
      // dragging a picked wire's body drags its nearest run, and never detaches it (spec §4.2)
      const bends = d.draft.routes[wireId]?.bends ?? shapeFromPoints(wire.points);
      const { startSegment: start, flowPointOf } = latestRef.current;
      start(wire, nearestSegment(endsOf(wire.points), bends, flowPointOf(e)), e);
    },
    portPointerDown(source, e) {
      latestRef.current.startNew(source, e);
    },
  }), [shown]);

  // a run drag's cursor only while that drag runs; an end drag or new wire keeps the closed hand
  return { gestures, startSegment, startEnd, ghost, hint, active, running, resize: active ? resize : null };
}
