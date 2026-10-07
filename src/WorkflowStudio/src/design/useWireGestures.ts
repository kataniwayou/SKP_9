import { useEffect, useMemo, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { StudioDocument } from '../app/document';
import { clampLanding, type Point } from '../layout/geometry';
import { dragSegment, endsOf, nearestSegment, normalize, shapeFromPoints, type Bends } from '../layout/shape';
import type { WireRoute } from '../layout/wires';
import type { DesignGestures } from './DesignContext';
import type { DesignProps } from './designProps';
import { setShape, type Draft } from './draft';

/** Below this many screen pixels a press is a click, not a drag. */
const MOVE_START = 3;

export interface Gesture {
  run: (e: ReactPointerEvent, onMove: (p: Point) => void, onEnd: (cancelled: boolean, moved: boolean) => void) => void;
  /** Drops the running gesture, if any: its listeners go and `onEnd` never runs. */
  abort: () => void;
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
      if (moved) {
        // the click that ends a drag lands on whatever is under the pointer (the pane clears the picks, a
        // wire re-picks): swallowed once, and dropped once this input's events are done
        const swallow = (ev: MouseEvent) => { ev.stopPropagation(); doc.removeEventListener('click', swallow, true); };
        doc.addEventListener('click', swallow, true);
        view.setTimeout(() => doc.removeEventListener('click', swallow, true), 0);
      }
      onEnd(cancelled, moved);
    };
    const up = () => finish(false);
    const cancel = () => finish(true);
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation(); // the dock's Escape must not also run
      finish(true);
    };
    doc.addEventListener('pointermove', move);
    doc.addEventListener('pointerup', up);
    doc.addEventListener('pointercancel', cancel);
    doc.addEventListener('keydown', key, true);
    stop.current = () => { detach(); setActive(false); };
  };
  return { run, abort: () => stop.current?.() };
}

/**
 * Editing a picked wire (spec §4.2-§4.3): dragging a run's square, or the wire's body, moves that run;
 * the first drag makes the wire manual, the last run slides the landing. Each finished drag is one
 * history step; Escape cancels it (spec §5.3). Task 8 adds end drags and new wires.
 */
export function useWireGestures(
  shown: MutableRefObject<StudioDocument>,
  design: DesignProps | undefined,
  setPreview: (d: Draft | null) => void,
) {
  const [active, setActive] = useState(false);
  const { run, abort } = useGesture(setActive);
  const { screenToFlowPosition } = useReactFlow();
  const designRef = useRef(design);
  designRef.current = design;

  // design mode ending mid-drag drops the drag and its preview
  const designOff = design === undefined;
  useEffect(() => {
    if (designOff) { abort(); setPreview(null); }
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

  /** The press point in flow coordinates (React Flow's own transform, so a pop-out's window works too). */
  const flowPointOf = (e: ReactPointerEvent): Point => screenToFlowPosition({ x: e.clientX, y: e.clientY }, { snapToGrid: false });
  const latestRef = useRef({ startSegment, flowPointOf });
  latestRef.current = { startSegment, flowPointOf };

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
    portPointerDown() { /* Task 8 */ },
  }), [shown]);

  return { gestures, startSegment, active };
}
