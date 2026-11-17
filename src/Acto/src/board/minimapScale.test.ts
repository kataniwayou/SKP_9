import { describe, expect, it } from 'vitest';
import { minimapLabel, minimapScale } from './minimapScale';

describe('minimap label', () => {
  it('keeps font and stroke constant in screen pixels across scales', () => {
    for (const scale of [1, 5, 40]) {
      const l = minimapLabel(100000, scale, 'x');
      expect(l.fontSize / scale).toBeCloseTo(10.5);
      expect(l.stroke / scale).toBeCloseTo(2);
    }
  });
  it('cuts the name to the frame width on screen, or drops it', () => {
    expect(minimapLabel(1000, 10, 'Short').text).toBe('Short');
    const cut = minimapLabel(300, 10, 'A very long workflow name');
    expect(cut.text.endsWith('…')).toBe(true);
    expect(cut.text.length).toBeLessThan(25);
    expect(minimapLabel(40, 10, 'Name').text).toBe('');
  });
  it('fits frames and viewport into the minimap element', () => {
    expect(minimapScale([{ x: 0, y: 0, w: 4000, h: 300 }], { x: 0, y: 0, w: 1000, h: 500 })).toBe(20);
  });
});
