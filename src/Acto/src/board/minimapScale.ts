/** The frame name's size on screen: smaller than it was (10.5), as the mock's. */
export const LABEL_PX = 8;
/** Below this the name is not drawn at all (its <title> still names the frame). */
const MIN_PX = 4;
/** Kept clear above and below the name, on screen. */
const PAD_PX = 0.75;
export const STROKE_PX = 2;
const MINIMAP_W = 200;
const MINIMAP_H = 150;
interface R { x: number; y: number; w: number; h: number }

/** Board units per minimap pixel, as React Flow's MiniMap computes it (nodes plus viewport fitted into its element). */
export function minimapScale(frames: readonly R[], view: R, el: { w: number; h: number } = { w: MINIMAP_W, h: MINIMAP_H }): number {
  const all = [...frames, view];
  const x1 = Math.min(...all.map((r) => r.x)), y1 = Math.min(...all.map((r) => r.y));
  const x2 = Math.max(...all.map((r) => r.x + r.w)), y2 = Math.max(...all.map((r) => r.y + r.h));
  return Math.max((x2 - x1) / el.w, (y2 - y1) / el.h) || 1;
}

/**
 * Font, stroke and baseline (from the frame's top, in board units) that come out constant in screen pixels. The name
 * never draws over the step blocks: `room.inside` is the free band from the frame's top to its first step, and
 * `room.above` the free gap over the frame (to the frame above it or the minimap's edge). It sits in the band when the
 * band holds it; else just above the first step, across the frame's top outline (a legend on its border); a name with
 * no room to read it is dropped. It is cut to what fits the frame's width on screen.
 */
export function minimapLabel(frameW: number, room: { inside: number; above: number }, scale: number, name: string): { fontSize: number; stroke: number; text: string; y: number } {
  const stroke = STROKE_PX * scale;
  const inside = room.inside / scale;
  // a line of text is about 0.78 em above its baseline and 0.22 em below it
  const px = Math.min(LABEL_PX, inside + Math.max(0, room.above) / scale - 2 * PAD_PX);
  if (px < MIN_PX) return { fontSize: LABEL_PX * scale, stroke, text: '', y: 0 };
  const fit = Math.floor((frameW / scale - 6) / (px * 0.6));
  const text = name.length <= fit ? name : fit >= 2 ? `${name.slice(0, fit - 1)}…` : '';
  const y = inside - 2 * PAD_PX >= px ? PAD_PX + 0.78 * px : inside - PAD_PX - 0.22 * px;
  return { fontSize: px * scale, stroke, text, y: y * scale };
}
