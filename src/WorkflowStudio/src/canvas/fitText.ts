/**
 * Long labels are shortened with an ellipsis, measured with the real fonts, and keep their full
 * text for a tooltip (spec §5.4). The measurer is injected so tests do not need a canvas.
 */
export const SANS = '"IBM Plex Sans Condensed","Helvetica Neue",Arial,sans-serif';
export const MONO = '"IBM Plex Mono",ui-monospace,Consolas,monospace';

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

export function createTextFitter(measure: Measure): TextFitter {
  return {
    width: measure,
    fit(text, maxWidth, font) {
      if (measure(text, font) <= maxWidth) return { text, full: text, cut: false };
      let lo = 0, hi = text.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (measure(text.slice(0, mid) + '…', font) <= maxWidth) lo = mid;
        else hi = mid - 1;
      }
      return { text: text.slice(0, lo) + '…', full: text, cut: true };
    },
  };
}

/**
 * Measures with an offscreen 2D canvas. Call after `document.fonts.ready`. The context is created on
 * the first measurement, so merely creating the measurer touches no canvas (jsdom has none and logs
 * an error when one is asked for).
 */
export function canvasMeasure(): Measure {
  let context: CanvasRenderingContext2D | null | undefined;
  return (text, font) => {
    if (context === undefined) context = document.createElement('canvas').getContext('2d');
    if (!context) return text.length * 7;
    context.font = font;
    return context.measureText(text).width;
  };
}
