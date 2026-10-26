import { useEffect, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent } from 'react';
import { useReactFlow, useStore } from '@xyflow/react';
import type { StudioDocument } from '../app/document';
import { selectionForPicks } from '../canvas/selection';
import { pickKey, type Pick } from '../store/picks';
import type { Selection } from '../store/selection';
import type { DesignProps } from './designProps';
import { itemsInRect, rectOf, type FlowRect } from './hit';

/** Below this many screen pixels a press on empty canvas is a click, not a rectangle. */
const BAND_START = 4;

/** Blocks, wires and a picked wire's handles are drawn inside React Flow's pane (v12), so empty canvas is the pane less them. */
const onEmptyCanvas = (target: Element) =>
  target.closest('.react-flow__pane') !== null && target.closest('.react-flow__node, .react-flow__edge, .react-flow__handle, .design-handle, .nx-port') === null;

/**
 * The rectangle on empty canvas (spec §3.2; the user, 2026-10-22): a left-button drag that does not start on a block or
 * a wire picks what it touches, wholly or in part (the user's, 2026-10-26); with Shift it adds. With Ctrl held the drag is React Flow's pan instead (`ctrl`:
 * Ctrl is held, so the canvas shows the closed hand), as are the middle button and Space+drag.
 */
export function useRubberBand(
  shown: MutableRefObject<StudioDocument>,
  design: DesignProps | undefined,
  onSelect: ((selection: Selection | null, picks?: Pick[]) => void) | undefined,
  suppressPaneClick: MutableRefObject<boolean>,
): { band: FlowRect | null; banding: boolean; ctrl: boolean; pressing: () => boolean; onPointerDownCapture: (e: ReactPointerEvent) => void } {
  const { screenToFlowPosition } = useReactFlow();
  const domNode = useStore((s) => s.domNode);
  const [band, setBand] = useState<FlowRect | null>(null);
  const space = useRef(false);
  const [ctrl, setCtrl] = useState(false);
  // the window the canvas is drawn in (a pop-out has its own); a press from another one rebinds the keys
  const [owner, setOwner] = useState<Document | null>(null);
  const keysOn = owner ?? domNode?.ownerDocument ?? null;
  // the running rectangle's teardown, so an unmount never leaves its listeners behind (they would swallow Escape)
  const running = useRef<(() => void) | null>(null);
  useEffect(() => () => { running.current?.(); running.current = null; }, []);

  useEffect(() => {
    if (keysOn === null) return;
    const down = (e: KeyboardEvent) => { if (e.key === ' ') space.current = true; if (e.key === 'Control') setCtrl(true); };
    const up = (e: KeyboardEvent) => { if (e.key === ' ') space.current = false; if (e.key === 'Control') setCtrl(false); };
    // a Ctrl let go in another window (Alt+Tab) sends no keyup here
    const blur = () => setCtrl(false);
    const win = keysOn.defaultView;
    keysOn.addEventListener('keydown', down);
    keysOn.addEventListener('keyup', up);
    win?.addEventListener('blur', blur);
    return () => {
      keysOn.removeEventListener('keydown', down); keysOn.removeEventListener('keyup', up); win?.removeEventListener('blur', blur);
      space.current = false; setCtrl(false);
    };
  }, [keysOn]);

  const onPointerDownCapture = (e: ReactPointerEvent) => {
    const target = e.target as Element;
    const doc = target.ownerDocument;
    if (doc !== keysOn) setOwner(doc);
    if (!design || !onSelect || e.button !== 0 || e.ctrlKey || space.current || !onEmptyCanvas(target)) return;
    const picked = design.picks;
    const start = { x: e.clientX, y: e.clientY };
    const a = screenToFlowPosition(start);
    let moved = false;
    running.current?.();
    const stop = () => {
      doc.removeEventListener('pointermove', move);
      doc.removeEventListener('pointerup', up);
      doc.removeEventListener('pointercancel', cancel);
      doc.removeEventListener('keydown', key, true);
      running.current = null;
      setBand(null);
    };
    // the click that ends the drag must not clear the picks; a release off the pane fires no pane click,
    // so the flag is dropped once this input's events are done
    const swallowPaneClick = () => {
      suppressPaneClick.current = true;
      (doc.defaultView ?? window).setTimeout(() => { suppressPaneClick.current = false; }, 0);
    };
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < BAND_START) return;
      moved = true;
      setBand(rectOf(a, screenToFlowPosition({ x: ev.clientX, y: ev.clientY })));
    };
    const cancel = () => stop();
    // Escape cancels the rectangle and keeps the picks (spec §3.2, §5.3); it goes no further, so the
    // studio's Escape does not clear the selection. The button is still down: its release picks nothing
    // and its closing click is swallowed. A press that has not moved yet is a click, not a drag: its Escape
    // is the studio's as usual
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || !moved) return;
      ev.preventDefault();
      ev.stopPropagation();
      stop();
      const released = () => {
        doc.removeEventListener('pointerup', released, true);
        doc.removeEventListener('pointercancel', released, true);
        swallowPaneClick();
      };
      doc.addEventListener('pointerup', released, true);
      doc.addEventListener('pointercancel', released, true);
    };
    const up = (ev: PointerEvent) => {
      stop();
      if (!moved) return;
      swallowPaneClick();
      const inside = itemsInRect(shown.current, rectOf(a, screenToFlowPosition({ x: ev.clientX, y: ev.clientY })));
      const picks = ev.shiftKey ? [...picked, ...inside.filter((p) => !picked.some((q) => pickKey(q) === pickKey(p)))] : inside;
      onSelect(selectionForPicks(picks, null, shown.current.graph), picks);
    };
    doc.addEventListener('pointermove', move);
    doc.addEventListener('pointerup', up);
    doc.addEventListener('pointercancel', cancel);
    doc.addEventListener('keydown', key, true);
    running.current = stop;
  };

  // `banding`: the rectangle has moved (the canvas keeps the arrow then: the closed hand is the pan's, 2026-10-22)
  // `pressing`: a press on empty canvas is down (a rectangle, or a click not yet released)
  return { band, banding: band !== null, ctrl, pressing: () => running.current !== null, onPointerDownCapture };
}
