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
  target.closest('.react-flow__pane') !== null && target.closest('.react-flow__node, .react-flow__edge, .react-flow__handle, .design-handle') === null;

/**
 * The rectangle on empty canvas (spec §3.2): a left-button drag that does not start on a block or a wire
 * picks what lies wholly inside; with Ctrl it adds. Space+drag stays React Flow's pan.
 */
export function useRubberBand(
  shown: MutableRefObject<StudioDocument>,
  design: DesignProps | undefined,
  onSelect: ((selection: Selection | null, picks?: Pick[]) => void) | undefined,
  suppressPaneClick: MutableRefObject<boolean>,
): { band: FlowRect | null; banding: boolean; onPointerDownCapture: (e: ReactPointerEvent) => void } {
  const { screenToFlowPosition } = useReactFlow();
  const domNode = useStore((s) => s.domNode);
  const [band, setBand] = useState<FlowRect | null>(null);
  const space = useRef(false);
  // the window the canvas is drawn in (a pop-out has its own); a press from another one rebinds the keys
  const [owner, setOwner] = useState<Document | null>(null);
  const keysOn = owner ?? domNode?.ownerDocument ?? null;

  useEffect(() => {
    if (keysOn === null) return;
    const down = (e: KeyboardEvent) => { if (e.key === ' ') space.current = true; };
    const up = (e: KeyboardEvent) => { if (e.key === ' ') space.current = false; };
    keysOn.addEventListener('keydown', down);
    keysOn.addEventListener('keyup', up);
    return () => { keysOn.removeEventListener('keydown', down); keysOn.removeEventListener('keyup', up); space.current = false; };
  }, [keysOn]);

  const onPointerDownCapture = (e: ReactPointerEvent) => {
    const target = e.target as Element;
    const doc = target.ownerDocument;
    if (doc !== keysOn) setOwner(doc);
    if (!design || !onSelect || e.button !== 0 || space.current || !onEmptyCanvas(target)) return;
    const picked = design.picks;
    const start = { x: e.clientX, y: e.clientY };
    const a = screenToFlowPosition(start);
    let moved = false;
    const stop = () => {
      doc.removeEventListener('pointermove', move);
      doc.removeEventListener('pointerup', up);
      doc.removeEventListener('pointercancel', cancel);
      setBand(null);
    };
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < BAND_START) return;
      moved = true;
      setBand(rectOf(a, screenToFlowPosition({ x: ev.clientX, y: ev.clientY })));
    };
    const cancel = () => stop();
    const up = (ev: PointerEvent) => {
      stop();
      if (!moved) return;
      // the click that ends the drag must not clear what it picked; a release off the pane fires no pane
      // click, so the flag is dropped once this input's events are done
      suppressPaneClick.current = true;
      (doc.defaultView ?? window).setTimeout(() => { suppressPaneClick.current = false; }, 0);
      const inside = itemsInRect(shown.current, rectOf(a, screenToFlowPosition({ x: ev.clientX, y: ev.clientY })));
      const picks = ev.ctrlKey ? [...picked, ...inside.filter((p) => !picked.some((q) => pickKey(q) === pickKey(p)))] : inside;
      onSelect(selectionForPicks(picks, null, shown.current.graph), picks);
    };
    doc.addEventListener('pointermove', move);
    doc.addEventListener('pointerup', up);
    doc.addEventListener('pointercancel', cancel);
  };

  // a rectangle is a drag: the canvas shows the closed hand once it has moved (spec §3.1)
  return { band, banding: band !== null, onPointerDownCapture };
}
