import { useEffect, useState } from 'react';
import { canvasMeasure, createTextFitter, loadMeasuredFonts, type TextFitter } from './fitText';

// One fitter per document, made once that document's fonts have loaded. A WeakMap, so a closed
// pop-out window's entry goes with it.
const fitters = new WeakMap<Document, Promise<TextFitter>>();

/** The fitter for `doc`: measures in `doc` with `doc`'s fonts, after loading every measured face. */
export function fitterFor(doc: Document): Promise<TextFitter> {
  let fitter = fitters.get(doc);
  if (!fitter) {
    fitter = loadMeasuredFonts(doc).then(() => createTextFitter(canvasMeasure(doc)));
    fitters.set(doc, fitter);
  }
  return fitter;
}

/**
 * The text fitter for the document a canvas is drawn in. Null until the first one is ready. When
 * the canvas moves to another document (a pop-out), the previous fitter is kept until the new
 * document's fonts have loaded, so the labels never flash.
 */
export function useFitter(doc: Document): TextFitter | null {
  const [fitter, setFitter] = useState<TextFitter | null>(null);
  useEffect(() => {
    let live = true;
    void fitterFor(doc).then((f) => { if (live) setFitter(() => f); });
    return () => { live = false; };
  }, [doc]);
  return fitter;
}
