import { describe, expect, it } from 'vitest';
import { pathOf, pathWithJumps } from './svgPath';

describe('a wire path with its line jumps (plan 10 phase 3)', () => {
  it('draws each jump as an arc 16 wide bulging up, left to right', () => {
    expect(pathWithJumps([[0, 100], [400, 100]], [[200, 100]])).toBe('M0 100 L192 100 A8 8 0 0 1 208 100 L400 100');
  });

  it('and right to left, still bulging up', () => {
    expect(pathWithJumps([[400, 100], [0, 100]], [[200, 100]])).toBe('M400 100 L208 100 A8 8 0 0 0 192 100 L0 100');
  });

  it("draws crossings nearer than a jump as one arc spanning them all, as high as one (phase 3's deferred list)", () => {
    expect(pathWithJumps([[0, 100], [400, 100]], [[200, 100], [208, 100]])).toBe('M0 100 L192 100 A12 8 0 0 1 216 100 L400 100');
    expect(pathWithJumps([[400, 100], [0, 100]], [[208, 100], [200, 100], [190, 100]])).toBe('M400 100 L216 100 A17 8 0 0 0 182 100 L0 100');
    // a jump's width apart: two arcs, end to end
    expect(pathWithJumps([[0, 100], [400, 100]], [[200, 100], [216, 100]])).toBe('M0 100 L192 100 A8 8 0 0 1 208 100 L208 100 A8 8 0 0 1 224 100 L400 100');
  });

  it('is the plain path with no jumps', () => {
    const pts: [number, number][] = [[0, 0], [100, 0], [100, 50]];
    expect(pathWithJumps(pts, [])).toBe(pathOf(pts));
  });

  it('puts a jump only on the run it lies on', () => {
    expect(pathWithJumps([[0, 0], [100, 0], [100, 200], [300, 200]], [[200, 200]]))
      .toBe('M0 0 L100 0 L100 200 L192 200 A8 8 0 0 1 208 200 L300 200');
  });
});
