/**
 * The grid geometry of spec §5.1. Everything sits on the 8 px grid; a step is 7 × 5 cells of 32 px;
 * its processor middle is 96 (3 cells down), so ports and arrows run along a 32 px line.
 */
export const GRID = 8;
export const CELL = 32;

export const STEP_W = 224;
export const STEP_H = 160;
export const CAP_H = 40;

/** The processor middle, step-local: every port is anchored here, not on the step's middle. */
export const PMID = 96;
export const PORT_GAP = 16;

/** The processor substrate inside a step, step-local. */
export const CHIP = { x: 24, y: 56, w: 176, h: 80 } as const;

/** A wire may land straight anywhere in this band (step-local y, inclusive). */
export const BAND_TOP = 62;
export const BAND_BOTTOM = 130;

/** The least gap, source edge to target edge, at which a level wire may run straight (spec §5.2). */
export const STRAIGHT_MIN_GAP = 16;

export const SPHERE_R = 96;
/** A cache is a 5 × 5-cell square, a step's height (locked art, spec §5.1). */
export const CACHE_W = 160;
export const CACHE_H = 160;
/** Caches stack under the hub one cache plus one cell apart. */
export const CACHE_PITCH = CACHE_H + CELL;
/** Visio's routing lengths carried over (plan 10 phase 3, spec §4.2; 1 mm = 8.96 px, snapped): a wire's stub out of
 * and into a block and its clearance round one (7.5 mm), the least clearance through a narrow gap (half of it), the
 * spacing of other nets' parallel runs, fan-out groups and landing slots (3.175 mm, up), a line jump's width (2.2 mm),
 * and the automatic layout's gap between blocks (15 mm). */
export const STUB = 64;
export const HALF_CLEAR = 32;
export const TRACK = 32;
export const JUMP = 16;
export const LAYOUT_GAP = 128;
export const COLUMN_PITCH = STEP_W + LAYOUT_GAP;

export interface Point {
  x: number;
  y: number;
}

export const snap = (v: number, step: number = GRID): number => Math.round(v / step) * step;

/** The k-th of n evenly spaced offsets `gap` apart, centred on zero. */
export const offset = (k: number, n: number, gap: number): number => (k - (n - 1) / 2) * gap;

/** A slid end stays on its side short of the frame's 14 px chamfered corners, on the 8 px grid (plan 9 §2.1, ruling). */
export const LANDING_MIN = 16;
export const LANDING_MAX = STEP_H - 16;
export const clampLanding = (v: number): number => Math.min(Math.max(snap(v), LANDING_MIN), LANDING_MAX);
