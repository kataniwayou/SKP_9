import { createContext, useContext, useEffect, useRef, type MutableRefObject } from 'react';
import { useReactFlow, useStore, type Viewport } from '@xyflow/react';
import { FIT_VIEW_OPTIONS } from './fitOptions';

interface Size { width: number; height: number }

/** The viewport that shows the same flow point at the canvas centre after the canvas changes size. */
export function keepCentre(v: Viewport, prev: Size, next: Size): Viewport {
  return { x: v.x + (next.width - prev.width) / 2, y: v.y + (next.height - prev.height) / 2, zoom: v.zoom };
}

/**
 * Whether the view still follows Fit. True after the first fit and after the Fit button; false once
 * the user zooms or pans. One per canvas, read by FollowSize and set by the zoom controls.
 */
export const FollowFitContext = createContext<MutableRefObject<boolean> | null>(null);

/** Sets whether the view follows Fit: false when the user zooms by hand, true when they press Fit. */
export function useFollowFit(): (on: boolean) => void {
  const follow = useContext(FollowFitContext);
  return (on) => { if (follow) follow.current = on; };
}

/**
 * Keeps the drawing sensible when the canvas changes size (a pane closes, the window grows, a
 * pop-out): while the view still follows Fit it fits again; after the user has zoomed or panned it
 * keeps the point at the centre at the centre. React Flow alone keeps the top-left corner, which
 * leaves the graph small and off to one side. Rendered inside the canvas's React Flow provider.
 */
export function FollowSize() {
  const follow = useContext(FollowFitContext);
  const { fitView, getViewport, setViewport } = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const last = useRef<Size | null>(null);

  useEffect(() => {
    if (width <= 0 || height <= 0) return; // not laid out (a hidden or moving panel): keep the last size
    const prev = last.current;
    last.current = { width, height };
    if (prev === null || (prev.width === width && prev.height === height)) return;
    if (follow?.current ?? true) void fitView(FIT_VIEW_OPTIONS);
    else void setViewport(keepCentre(getViewport(), prev, { width, height }));
  }, [width, height, follow, fitView, getViewport, setViewport]);

  return null;
}
