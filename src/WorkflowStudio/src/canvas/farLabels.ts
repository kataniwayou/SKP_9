import { FONT, type TextFitter } from './fitText';

/**
 * The far view (the user, 2026-11-01): below FAR_ZOOM a block's fine print would be a few screen pixels, too small to
 * read however it is drawn, so a block shows only its names, large. Each name is drawn at the size that keeps it
 * `screen` px tall on screen (CSS `--inv`, 1 / zoom), but never larger than fits the block (`max`, world px).
 */
export const FAR_ZOOM = 0.6;

/** One name of the far view: its lines, the largest font (world px) at which the widest fits, the screen size it aims at. */
export interface FarText { lines: string[]; max: number; screen: number }

/** The size `FONT.far` is measured at; widths scale with the font size. */
const BASE = 13;

/**
 * `text` on one line, or split after `-`, `_` or `.` (else in its middle) onto two when that lets it be drawn much
 * larger in `room` world px; `cap` bounds the font so the lines keep to their band of the block.
 */
export function farText(text: string, room: number, cap: number, screen: number, fitter: TextFitter, twoLines = true): FarText {
  const width = (t: string) => Math.max(1, fitter.width(t, FONT.far));
  const one: FarText = { lines: [text], max: Math.min(cap, (BASE * room) / width(text)), screen };
  if (!twoLines || one.max >= cap) return one;
  let best: string[] | null = null;
  let bestWidth = Infinity;
  const cuts = [...text.matchAll(/[-_.]/g)].map((m) => m.index! + 1).filter((i) => i > 0 && i < text.length);
  for (const at of cuts.length > 0 ? cuts : [Math.ceil(text.length / 2)]) {
    const lines = [text.slice(0, at), text.slice(at)];
    const w = Math.max(...lines.map(width));
    if (w < bestWidth) { best = lines; bestWidth = w; }
  }
  const two: FarText = { lines: best!, max: Math.min(cap * 0.8, (BASE * room) / bestWidth), screen };
  return two.max > one.max * 1.25 ? two : one;
}

/** A step's far view: its name (up to two lines) and its processor's name (one line), in the step's 224 × 160 frame. */
export interface FarStep { name: FarText; processor: FarText | null }

export function farStep(stepName: string, processorName: string | null, fitter: TextFitter): FarStep {
  return {
    name: farText(stepName, 200, 52, 13, fitter),
    processor: processorName === null ? null : farText(processorName, 196, 26, 11, fitter, false),
  };
}

/** The CSS font size of a far name: as large on screen as it aims, as large in the block as fits. */
export const farFontSize = (t: FarText): string => `min(${t.max.toFixed(2)}px, calc(${t.screen}px * var(--inv, 1)))`;
