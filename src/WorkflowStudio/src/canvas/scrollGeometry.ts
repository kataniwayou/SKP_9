/** Screen pixels of margin kept around the drawing when scrolling to its edge. */
export const SCROLL_PAD = 24;

/** One scroll direction: the view's length, the scrollable length and how far the view is into it. */
export interface Axis { size: number; full: number; pos: number }

/**
 * The scroll range along one direction, in screen pixels relative to the view's start (0..size):
 * the drawing plus its margin, widened to include the view itself, so a view panned past the
 * drawing still has a bar to come back with. Null when everything fits (no bar).
 */
export function axisOf(drawingStart: number, drawingEnd: number, size: number): Axis | null {
  const start = Math.min(drawingStart - SCROLL_PAD, 0);
  const end = Math.max(drawingEnd + SCROLL_PAD, size);
  const full = end - start;
  return full > size + 1 ? { size, full, pos: 0 - start } : null;
}

/** The thumb on a track of `track` px: its length (never under 32 px) and its offset. */
export function thumbOf(axis: Axis, track: number): { len: number; at: number } {
  const len = Math.min(track, Math.max(32, (track * axis.size) / axis.full));
  return { len, at: ((track - len) * axis.pos) / (axis.full - axis.size) };
}
