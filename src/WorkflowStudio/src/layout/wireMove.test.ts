import { describe, expect, it } from 'vitest';
import { simplify, type Pt } from './router';
import { pointsOfShape, shapeFromPoints } from './shape';
import type { Point } from './geometry';
import { coreFrom, legsPath, moveLegs, startLegs, translatePoints, type Legs } from './wireMove';

describe('a wire moved whole', () => {
  it('shifts every point by the same amount: the same shape, somewhere else', () => {
    const pts: Pt[] = [[512, 168], [552, 168], [552, 352], [576, 352]];
    expect(translatePoints(pts, -40, 56)).toEqual([[472, 224], [512, 224], [512, 408], [536, 408]]);
    expect(translatePoints(pts, 0, 0)).toEqual(pts);
  });
});

describe('the core of a moved end', () => {
  it('starts at the fixed end\'s core start, dropping a lead before it (a tail on the hub\'s left half)', () => {
    // ring point, down out of the hub's square, then right to where the core starts (264, 400)
    const full: Pt[] = [[128, 352], [128, 400], [400, 400], [400, 480]];
    expect(coreFrom(full, [264, 400])).toEqual([[264, 400], [400, 400], [400, 480]]);
    // a start that is the first point keeps the whole path
    expect(coreFrom(full, [128, 352])).toEqual(full);
  });

  it('gives bends that draw a dragged end\'s path again from the fixed end\'s core (rule C\'s L)', () => {
    const pts: Pt[] = [[128, 352], [128, 400], [400, 400], [400, 480], [576, 480]];
    let s = startLegs(pts, { x: 576, y: 480 });
    for (let i = 1; i <= 8; i++) s = moveLegs(s, { x: 576 + 8 * i, y: 480 + 10 * i });
    const drawn = legsPath(s);
    expect(drawn).toEqual([[128, 352], [128, 400], [400, 400], [400, 480], [640, 480], [640, 560]]);
    const bends = shapeFromPoints(coreFrom(drawn, [264, 400]));
    expect(simplify(pointsOfShape({ sx: 264, sy: 400, tx: 640, ty: 560 }, bends))).toEqual([[264, 400], [400, 400], [400, 480], [640, 480], [640, 560]]);
  });
});

describe('an end dragged around corners (the user\'s rule C, 2026-10-09)', () => {
  /** The pointer moved to each point in turn, `n` small steps from the last one, as a real mouse sends them. */
  const walk = (s: Legs, from: Point, ...to: Point[]): Legs => {
    let at = from;
    for (const q of to) {
      for (let i = 1; i <= 12; i++) s = moveLegs(s, { x: at.x + ((q.x - at.x) * i) / 12, y: at.y + ((q.y - at.y) * i) / 12 });
      at = q;
    }
    return s;
  };
  const straight: Pt[] = [[0, 0], [96, 0]];

  it('one way off the last run: one corner, as before (an L); nothing fixed yet', () => {
    const s = walk(startLegs(straight, { x: 96, y: 0 }), { x: 96, y: 0 }, { x: 96, y: 64 });
    expect(legsPath(s)).toEqual([[0, 0], [96, 0], [96, 64]]);
    expect(s.drawn).toBe(false);
  });

  it('each 90 degree turn of the pointer fixes the leg drawn and starts a new one: three corners in one drag', () => {
    const s = walk(startLegs(straight, { x: 96, y: 0 }), { x: 96, y: 0 }, { x: 96, y: 64 }, { x: 160, y: 64 }, { x: 160, y: 128 });
    expect(legsPath(s)).toEqual([[0, 0], [96, 0], [96, 64], [160, 64], [160, 128]]);
    expect(s.drawn).toBe(true);
    // and on: right again
    const t = walk(s, { x: 160, y: 128 }, { x: 240, y: 128 });
    expect(legsPath(t)).toEqual([[0, 0], [96, 0], [96, 64], [160, 64], [160, 128], [240, 128]]);
  });

  it('a slanting drag turns no corner: the L follows the pointer', () => {
    const s = walk(startLegs(straight, { x: 96, y: 0 }), { x: 96, y: 0 }, { x: 200, y: 104 });
    expect(legsPath(s)).toEqual([[0, 0], [200, 0], [200, 104]]);
    expect(s.drawn).toBe(false);
  });

  it('back along the current leg shortens it; back past a corner takes that corner away', () => {
    const three = walk(startLegs(straight, { x: 96, y: 0 }), { x: 96, y: 0 }, { x: 96, y: 64 }, { x: 160, y: 64 }, { x: 160, y: 128 });
    const shorter = walk(three, { x: 160, y: 128 }, { x: 160, y: 96 });
    expect(legsPath(shorter)).toEqual([[0, 0], [96, 0], [96, 64], [160, 64], [160, 96]]);
    // up to the corner and on, back along the leg before it: that corner has gone, the leg before it shortened
    const back = walk(shorter, { x: 160, y: 96 }, { x: 160, y: 64 }, { x: 128, y: 64 });
    expect(legsPath(back)).toEqual([[0, 0], [96, 0], [96, 64], [128, 64]]);
    // and back past the next corner: down to the first leg
    const first = walk(back, { x: 128, y: 64 }, { x: 96, y: 64 }, { x: 96, y: 0 }, { x: 64, y: 0 });
    expect(legsPath(first)).toEqual([[0, 0], [64, 0]]);
  });

  it('the end that stays is never taken back', () => {
    const s = walk(startLegs([[96, 0], [300, 0]], { x: 300, y: 0 }), { x: 300, y: 0 }, { x: 40, y: 0 });
    expect(legsPath(s)[0]).toEqual([96, 0]);
    expect(s.path).toEqual([[96, 0]]);
  });

  it('the corners the wire already had stay: back past one, the L just goes on from it', () => {
    // a Z: (0,0) -> (48,0) -> (48,80) -> (120,80); its head back left past (48, 80) and down
    const z: Pt[] = [[0, 0], [48, 0], [48, 80], [120, 80]];
    const s = walk(startLegs(z, { x: 120, y: 80 }), { x: 120, y: 80 }, { x: 24, y: 80 }, { x: 24, y: 120 });
    expect(s.path).toEqual([[0, 0], [48, 0], [48, 80]]);
    expect(legsPath(s)).toEqual([[0, 0], [48, 0], [48, 80], [24, 80], [24, 120]]);
  });
});
