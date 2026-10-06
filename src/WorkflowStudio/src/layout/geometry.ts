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
export const CACHE_W = 192;
export const CACHE_H = 64;
export const COLUMN_PITCH = 288;

export interface Point {
  x: number;
  y: number;
}

export const snap = (v: number, step: number = GRID): number => Math.round(v / step) * step;

/** The k-th of n evenly spaced offsets `gap` apart, centred on zero. */
export const offset = (k: number, n: number, gap: number): number => (k - (n - 1) / 2) * gap;
