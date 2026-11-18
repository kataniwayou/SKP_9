import { describe, expect, it } from 'vitest';
import { LABEL_PX, minimapLabel, minimapScale } from './minimapScale';

const ROOMY = { inside: 1e6, above: 0 };

describe('minimap label', () => {
  it('keeps font and stroke constant in screen pixels across scales, smaller than before', () => {
    for (const scale of [1, 5, 40]) {
      const l = minimapLabel(100000, ROOMY, scale, 'x');
      expect(l.fontSize / scale).toBeCloseTo(LABEL_PX);
      expect(l.stroke / scale).toBeCloseTo(2);
    }
    expect(LABEL_PX).toBeLessThan(10.5);
  });
  it('sits inside the frame, above its first step, when the band there holds it', () => {
    const l = minimapLabel(100000, { inside: 120, above: 0 }, 6, 'name');
    expect(l.fontSize / 6).toBeCloseTo(LABEL_PX);
    expect(l.y - 0.78 * l.fontSize).toBeGreaterThanOrEqual(0);
    expect(l.y + 0.22 * l.fontSize).toBeLessThanOrEqual(120);
  });
  it('never reaches the step blocks below it or what is above the frame: it straddles the outline when it must', () => {
    for (const [inside, above, scale] of [[74, 80, 22.7], [74, 259, 22.7], [74, 0, 6], [40, 200, 10], [300, 0, 30]] as const) {
      const l = minimapLabel(100000, { inside, above }, scale, 'name');
      if (l.text === '') continue;
      expect(l.y + 0.22 * l.fontSize).toBeLessThanOrEqual(inside + 1e-9);
      expect(l.y - 0.78 * l.fontSize).toBeGreaterThanOrEqual(-above - 1e-9);
    }
    // the live board's case: a 3.3 px band and a 3.5 px gap above still give a name of 4 px or more
    const live = minimapLabel(100000, { inside: 74, above: 80 }, 22.7, 'n');
    expect(live.text).toBe('n');
    expect(live.fontSize / 22.7).toBeGreaterThanOrEqual(4);
  });
  it('drops the name when there is no room to read it', () => {
    expect(minimapLabel(100000, { inside: 20, above: 10 }, 10, 'Name').text).toBe('');
  });
  it('cuts the name to the frame width on screen, or drops it', () => {
    expect(minimapLabel(1000, ROOMY, 10, 'Short').text).toBe('Short');
    const cut = minimapLabel(300, ROOMY, 10, 'A very long workflow name');
    expect(cut.text.endsWith('…')).toBe(true);
    expect(cut.text.length).toBeLessThan(25);
    expect(minimapLabel(30, ROOMY, 10, 'Name').text).toBe('');
  });
  it('fits frames and viewport into the minimap element', () => {
    expect(minimapScale([{ x: 0, y: 0, w: 4000, h: 300 }], { x: 0, y: 0, w: 1000, h: 500 })).toBe(20);
  });
});
