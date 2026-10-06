import { describe, expect, it } from 'vitest';
import { createTextFitter } from './fitText';

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

  it('returns a bare ellipsis when nothing fits', () => {
    expect(fitter.fit('abc', 5, 'f').text).toBe('…');
  });

  it('measures through the injected measurer', () => {
    expect(fitter.width('abcd', 'f')).toBe(28);
  });
});
