import { useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { useEdges, useNodes, useReactFlow, useStore } from '@xyflow/react';
import type { Pt } from '../layout/router';
import { useFollowFit } from './followSize';
import { axisOf, thumbOf, type Axis } from './scrollGeometry';

interface Rect { x0: number; y0: number; x1: number; y1: number }

/** canvas.css .sb.h / .sb.v: a track starts 12 px in and ends 24 px short of the view's edge. */
const TRACK_INSET = 36;

/** The drawing's extent in flow coordinates: every block and every wire point. */
function useDrawingBounds(): Rect | null {
  const nodes = useNodes();
  const edges = useEdges();
  const { getNodesBounds } = useReactFlow();
  return useMemo(() => {
    if (nodes.length === 0) return null;
    const b = getNodesBounds(nodes);
    const r = { x0: b.x, y0: b.y, x1: b.x + b.width, y1: b.y + b.height };
    for (const e of edges) {
      for (const [x, y] of ((e.data as { points?: Pt[] } | undefined)?.points ?? [])) {
        r.x0 = Math.min(r.x0, x); r.x1 = Math.max(r.x1, x); r.y0 = Math.min(r.y0, y); r.y1 = Math.max(r.y1, y);
      }
    }
    return r;
  }, [nodes, edges, getNodesBounds]);
}

/**
 * Overlay scroll bars (spec §5.4, mockup v50 .sb): along the bottom and right edges, only when the
 * drawing reaches past the view. Dragging a thumb pans; clicking the track pages by 90% of the view.
 * Using them counts as panning by hand, so a later resize keeps the centre instead of re-fitting.
 */
export function ScrollBars() {
  const bounds = useDrawingBounds();
  const [tx, ty, zoom] = useStore((s) => s.transform);
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  if (bounds === null || width <= 0 || height <= 0) return null;
  const h = axisOf(bounds.x0 * zoom + tx, bounds.x1 * zoom + tx, width);
  const v = axisOf(bounds.y0 * zoom + ty, bounds.y1 * zoom + ty, height);
  return (
    <>
      <Bar horiz axis={h} />
      <Bar horiz={false} axis={v} />
    </>
  );
}

function Bar({ horiz, axis }: { horiz: boolean; axis: Axis | null }) {
  const { getViewport, setViewport } = useReactFlow();
  const follow = useFollowFit();
  const track = useRef<HTMLDivElement>(null);
  const trackLen = axis ? axis.size - TRACK_INSET : 0;
  const t = axis ? thumbOf(axis, trackLen) : null;

  /** Moves the view so it is `d` screen px further along this direction (positive: right or down). */
  const scrollBy = (from: { x: number; y: number; zoom: number }, d: number) => {
    follow(false);
    void setViewport(horiz ? { ...from, x: from.x - d } : { ...from, y: from.y - d });
  };

  const onThumbDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!axis || !t) return;
    e.preventDefault();
    e.stopPropagation();
    const thumb = e.currentTarget;
    thumb.setPointerCapture(e.pointerId);
    track.current?.classList.add('active');
    const from = getViewport();
    const start = horiz ? e.clientX : e.clientY;
    const ratio = (axis.full - axis.size) / Math.max(1, trackLen - t.len);
    const move = (ev: PointerEvent) => scrollBy(from, ((horiz ? ev.clientX : ev.clientY) - start) * ratio);
    const up = () => {
      track.current?.classList.remove('active');
      thumb.removeEventListener('pointermove', move);
      thumb.removeEventListener('pointerup', up);
      thumb.removeEventListener('pointercancel', up);
    };
    thumb.addEventListener('pointermove', move);
    thumb.addEventListener('pointerup', up);
    thumb.addEventListener('pointercancel', up);
  };

  const onTrackDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!axis || !t || e.target !== e.currentTarget) return;
    const r = e.currentTarget.getBoundingClientRect();
    const click = horiz ? e.clientX - r.left : e.clientY - r.top;
    scrollBy(getViewport(), (click < t.at ? -1 : 1) * axis.size * 0.9);
  };

  return (
    <div
      ref={track}
      className={`sb ${horiz ? 'h' : 'v'}${axis ? '' : ' off'}`}
      data-testid={horiz ? 'scrollbar-h' : 'scrollbar-v'}
      aria-hidden="true"
      onPointerDown={onTrackDown}
    >
      {t && (
        <div
          className="th"
          style={horiz ? { width: t.len, left: t.at } : { height: t.len, top: t.at }}
          onPointerDown={onThumbDown}
        />
      )}
    </div>
  );
}
