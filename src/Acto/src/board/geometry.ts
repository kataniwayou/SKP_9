export const HEADER_H = 46;
export const FRAME_PAD = 28;
export const STEP_W = 210;
export const STEP_H = 92;
export const FRAME_MIN_W = 420;
export const FRAME_MIN_BODY_H = 150;
export const FRAME_GAP = 80;
export const BOARD_ROW_W = 2400;
/**
 * Screen pixels a pressed pointer may travel and still be a click (React Flow's own is 1): a hand on a mouse wobbles a few
 * when it clicks, and a frame or step it picks must not move by them (2026-11-18).
 */
export const CLICK_SLOP = 6;

/** A triangle node: the shape (tip on the right) over its name and state; the cache block. Placement uses the same sizes. */
export const TRIANGLE_W = 120;
export const TRIANGLE_H = 104;
/** The shape alone: its tip is at (TRI_SHAPE_W, TRI_SHAPE_H / 2), the middle of its back at (0, TRI_SHAPE_H / 2). */
export const TRI_SHAPE_W = 92;
export const TRI_SHAPE_H = 60;
export const CACHE_W = 160;
export const CACHE_H = 56;
