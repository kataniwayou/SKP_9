/**
 * The locked art's outlines (spec §5.1), at this grid's sizes (mockup v50 NX_FRAME, NX_CFRAME): notched
 * HUD frames with 14 px chamfers and a 6 px notch top and bottom.
 */
export const STEP_FRAME = 'M14 0H80L86 6H138L144 0H210L224 14V146L210 160H144L138 154H86L80 160H14L0 146V14Z';
export const STEP_FRAME_IN = 'M20 8H76L82 14H142L148 8H204L216 20V140L204 152H148L142 146H82L76 152H20L8 140V20Z';
/** The glossy title cap: it follows the top notch and ends on y = 40 (CAP_H). */
export const STEP_CAP = 'M16 4H78L84 10H140L146 4H208L220 16V40H4V16Z';
export const STEP_GLOSS = 'M18 6H118L112 12H10Z';
export const CACHE_FRAME = 'M14 0H52L58 6H102L108 0H146L160 14V146L146 160H108L102 154H58L52 160H14L0 146V14Z';
export const CACHE_FRAME_IN = 'M20 8H48L54 14H106L112 8H140L152 20V140L140 152H112L106 146H54L48 152H20L8 140V20Z';

/**
 * A dash pattern for a circle of radius `r`, scaled by `scale` and then stretched so a whole number of
 * repeats closes it: the turning ring has no seam.
 */
export function closingDash(r: number, pattern: number[], scale = 1): string {
  const circumference = 2 * Math.PI * r;
  const sum = pattern.reduce((a, b) => a + b, 0);
  const repeats = Math.max(1, Math.round(circumference / (sum * scale)));
  const k = circumference / (repeats * sum);
  return pattern.map((v) => (v * k).toFixed(2)).join(' ');
}

/** The six corners of a hexagon with flat left and right vertices (the cache's mark). */
export function hexPoints(cx: number, cy: number, r: number): string {
  return Array.from({ length: 6 }, (_, i) =>
    `${(cx + r * Math.cos((i * Math.PI) / 3)).toFixed(1)},${(cy + r * Math.sin((i * Math.PI) / 3)).toFixed(1)}`).join(' ');
}
