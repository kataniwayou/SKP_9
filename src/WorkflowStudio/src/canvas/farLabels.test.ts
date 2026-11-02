import { describe, expect, it } from 'vitest';
import { farFontSize, farStep, farText } from './farLabels';
import { createTextFitter } from './fitText';

// every character 6.5 px wide at the 13 px the far font is measured at
const fitter = createTextFitter((text) => text.length * 6.5);

describe('the far view (the user, 2026-11-01)', () => {
  it('keeps a short name on one line, as large as its band allows', () => {
    const t = farText('fetch', 200, 52, 13, fitter);
    expect(t.lines).toEqual(['fetch']);
    expect(t.max).toBe(52); // 13 * 200 / 32.5 = 80, capped
  });

  it('splits a long name after a separator onto two lines when that draws it much larger', () => {
    const t = farText('split-filefetcher', 200, 52, 13, fitter);
    expect(t.lines).toEqual(['split-', 'filefetcher']);
    expect(t.max).toBeCloseTo((13 * 200) / (11 * 6.5));
  });

  it('splits a name with no separator in its middle', () => {
    expect(farText('abcdefghijklmnopqrstuvwxyz', 200, 52, 13, fitter).lines).toEqual(['abcdefghijklm', 'nopqrstuvwxyz']);
  });

  it('keeps a processor name on one line', () => {
    const far = farStep('split-filefetcher', 'file-fetcher-with-a-long-name', fitter);
    expect(far.processor!.lines).toEqual(['file-fetcher-with-a-long-name']);
    expect(farStep('s', null, fitter).processor).toBeNull();
  });

  it('sizes a name to its screen aim through --inv, never past what fits', () => {
    expect(farFontSize({ lines: ['x'], max: 24.5, screen: 13 })).toBe('min(24.50px, calc(13px * var(--inv, 1)))');
  });
});
