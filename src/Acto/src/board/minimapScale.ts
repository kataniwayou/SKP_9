export const LABEL_PX = 10.5;
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

/** Font and stroke in board units that come out constant in screen pixels; the name is cut to what fits the frame on screen. */
export function minimapLabel(frameW: number, scale: number, name: string): { fontSize: number; stroke: number; text: string } {
  const fit = Math.floor((frameW / scale - 6) / (LABEL_PX * 0.6));
  const text = name.length <= fit ? name : fit >= 2 ? `${name.slice(0, fit - 1)}…` : '';
  return { fontSize: LABEL_PX * scale, stroke: STROKE_PX * scale, text };
}
