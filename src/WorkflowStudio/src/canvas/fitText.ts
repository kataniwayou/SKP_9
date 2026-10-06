/**
 * Long labels are shortened with an ellipsis, measured with the real fonts, and keep their full
 * text for a tooltip (spec §5.4). The measurer is injected so tests do not need a canvas.
 */
export const SANS = '"IBM Plex Sans Condensed","Helvetica Neue",Arial,sans-serif';
export const MONO = '"IBM Plex Mono",ui-monospace,Consolas,monospace';

/**
 * Every font string the studio measures labels with (toFlow and the nodes use only these). The page
 * loads each one before it makes the fitter: `document.fonts.ready` alone does not wait for faces
 * nothing has asked for yet, and @fontsource faces load lazily.
 */
export const FONT = {
  cacheName: `12.5px ${SANS}`,
  cacheRoot: `10px ${MONO}`,
  stepName: `13px ${SANS}`,
  stepVersion: `9.5px ${MONO}`,
  processorTitle: `11px ${SANS}`,
  processorRow: `9px ${MONO}`,
  hubPill: `10px ${MONO}`,
} as const;

export const MEASURED_FONTS: readonly string[] = [...new Set(Object.values(FONT))];

/**
 * Requests every measured face in `doc`, then waits for its fonts to settle. Each document loads its
 * own faces: a pop-out window starts with none (spec §6.3). Safe where `fonts` is missing (jsdom).
 */
export async function loadMeasuredFonts(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): Promise<void> {
  const fonts = doc?.fonts;
  if (!fonts) return;
  try {
    await Promise.all(MEASURED_FONTS.map((f) => fonts.load(f)));
    await fonts.ready;
  } catch {
    // a face that fails to load just means the fallback font is measured; never block the page
  }
}

export interface FittedText {
  text: string;
  full: string;
  cut: boolean;
}

export type Measure = (text: string, font: string) => number;

export interface TextFitter {
  width(text: string, font: string): number;
  fit(text: string, maxWidth: number, font: string): FittedText;
}

/** Splits into user-perceived characters so a cut never lands inside an emoji, flag or combining sequence. */
function graphemes(text: string): string[] {
  const Segmenter = (Intl as { Segmenter?: new (l?: string, o?: { granularity: 'grapheme' }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  if (Segmenter) return Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (s) => s.segment);
  return Array.from(text); // code points: never splits a surrogate pair
}

export function createTextFitter(measure: Measure): TextFitter {
  return {
    width: measure,
    fit(text, maxWidth, font) {
      if (text === '' || measure(text, font) <= maxWidth) return { text, full: text, cut: false };
      if (measure('…', font) > maxWidth) return { text: '', full: text, cut: true };
      const parts = graphemes(text);
      const prefix = (n: number) => parts.slice(0, n).join('');
      let lo = 0, hi = parts.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (measure(prefix(mid) + '…', font) <= maxWidth) lo = mid;
        else hi = mid - 1;
      }
      return { text: prefix(lo) + '…', full: text, cut: true };
    },
  };
}

/**
 * Measures with an offscreen 2D canvas of `doc`, the document the labels are drawn in (its
 * `ownerDocument`, never the global one, so a pop-out measures with the fonts it has; spec §6.3).
 * Call after `loadMeasuredFonts(doc)`. The context is created on the first measurement, so merely
 * creating the measurer touches no canvas (jsdom has none and logs an error when one is asked for).
 */
export function canvasMeasure(doc: Document = document): Measure {
  let context: CanvasRenderingContext2D | null | undefined;
  return (text, font) => {
    if (context === undefined) context = doc.createElement('canvas').getContext('2d');
    if (!context) return text.length * 7;
    context.font = font;
    return context.measureText(text).width;
  };
}
