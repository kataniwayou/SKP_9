import { describe, expect, it, vi } from 'vitest';
import { canvasMeasure, createTextFitter, loadMeasuredFonts, MEASURED_FONTS } from './fitText';

// A deterministic measurer: every character is 7 px wide whatever the font.
const fitter = createTextFitter((text) => text.length * 7);

describe('createTextFitter', () => {
  it('keeps text that fits', () => {
    expect(fitter.fit('fetch', 100, 'f')).toEqual({ text: 'fetch', full: 'fetch', cut: false });
  });

  it('cuts with an ellipsis to the longest prefix that fits, and keeps the full text for the tooltip', () => {
    // 10 chars max: 9 + the ellipsis
    expect(fitter.fit('a-very-long-step-name', 70, 'f')).toEqual({ text: 'a-very-lo…', full: 'a-very-long-step-name', cut: true });
  });

  it('returns a bare ellipsis when only the ellipsis fits', () => {
    expect(fitter.fit('abc', 7, 'f').text).toBe('…');
  });

  it('returns empty text, still cut, when even the ellipsis does not fit', () => {
    expect(fitter.fit('abc', 5, 'f')).toEqual({ text: '', full: 'abc', cut: true });
  });

  it('does not report a cut for an empty string, whatever the width', () => {
    expect(fitter.fit('', -5, 'f')).toEqual({ text: '', full: '', cut: false });
  });

  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  it('never splits a surrogate pair', () => {
    const r = fitter.fit('ab😀cd', 28, 'f'); // 'ab😀' is 4 units = 28 px, with the ellipsis 35
    expect(lone.test(r.text)).toBe(false);
    expect(r.text).toBe('ab…');
  });

  it('keeps a ZWJ emoji whole or drops it whole', () => {
    const family = '👨‍👩‍👧';
    for (let w = 0; w <= 120; w += 7) {
      const r = fitter.fit(`a${family}b${family}`, w, 'f');
      expect(lone.test(r.text)).toBe(false);
      const body = r.text.replace('…', '');
      expect(body === '' || body === 'a' || body === `a${family}` || body === `a${family}b` || body === `a${family}b${family}`).toBe(true);
    }
  });

  it('always measures within maxWidth', () => {
    for (const text of ['fetch', 'a-very-long-step-name', 'ab😀cd', 'éééx']) {
      for (let w = -3; w <= 200; w += 3) {
        const r = fitter.fit(text, w, 'f');
        expect(fitter.width(r.text, 'f')).toBeLessThanOrEqual(Math.max(w, 0));
      }
    }
  });

  it('measures through the injected measurer', () => {
    expect(fitter.width('abcd', 'f')).toBe(28);
  });
});

describe('measuring in the document the labels are drawn in (spec §6.3)', () => {
  it('canvasMeasure makes its canvas in the given document, once', () => {
    const measureText = vi.fn((t: string) => ({ width: t.length * 3 }));
    const createElement = vi.fn(() => ({ getContext: () => ({ font: '', measureText }) }));
    const popout = { createElement } as unknown as Document;

    const measure = canvasMeasure(popout);
    expect(createElement).not.toHaveBeenCalled();
    expect(measure('abcd', '10px x')).toBe(12);
    expect(measure('ab', '10px x')).toBe(6);
    expect(createElement).toHaveBeenCalledTimes(1);
  });

  it('loadMeasuredFonts loads every measured face in the given document', async () => {
    const load = vi.fn().mockResolvedValue([]);
    const popout = { fonts: { load, ready: Promise.resolve() } } as unknown as Document;

    await loadMeasuredFonts(popout);

    expect(load.mock.calls.map((c) => c[0]).sort()).toEqual([...MEASURED_FONTS].sort());
  });

  it('loadMeasuredFonts never rejects when a face fails to load', async () => {
    const popout = { fonts: { load: vi.fn().mockRejectedValue(new Error('404')), ready: Promise.resolve() } } as unknown as Document;
    await expect(loadMeasuredFonts(popout)).resolves.toBeUndefined();
  });

  it('measures each text and font once (plan 4: a drag re-fits every frame)', () => {
    const measure = vi.fn((t: string) => t.length * 7);
    const fitter = createTextFitter(measure);
    fitter.fit('a long name', 40, 'f');
    const calls = measure.mock.calls.length;
    fitter.fit('a long name', 40, 'f');
    expect(measure.mock.calls.length).toBe(calls);
  });
});
