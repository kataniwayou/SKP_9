import { describe, expect, it } from 'vitest';
import { closingDash, hexPoints } from './nxShapes';

const total = (dash: string) => dash.split(' ').map(Number).reduce((a, b) => a + b, 0);

describe('closingDash', () => {
  it('rescales a pattern so a whole number of repeats closes the circle (the hub spinner)', () => {
    const dash = closingDash(87, [44, 14, 8, 14]);
    expect(dash.split(' ')).toHaveLength(4);
    expect(total(dash) * 7).toBeCloseTo(2 * Math.PI * 87, 0);
  });

  it('applies a scale before closing (the processor spinner at 0.58)', () => {
    expect(total(closingDash(28.5, [30, 12, 6, 12], 0.58)) * 5).toBeCloseTo(2 * Math.PI * 28.5, 0);
  });
});

describe('hexPoints', () => {
  it('gives a hexagon with flat left and right vertices, to one decimal', () => {
    expect(hexPoints(0, 0, 10)).toBe('10.0,0.0 5.0,8.7 -5.0,8.7 -10.0,0.0 -5.0,-8.7 5.0,-8.7');
  });
});
