import { describe, expect, it } from 'vitest';
import { clearBends, clearPath, clearRun, legPath } from './detour';
import { LineIndex } from './overlaps';
import type { Box, Pt } from './router';
import { pointsOfShape } from './shape';

const box = (id: string, x: number, y: number, w = 224, h = 160): Box => ({ id, x, y, w, h });
const crosses = (pts: Pt[], b: Box) => pts.some((a, i) => {
  const c = pts[i + 1];
  if (!c) return false;
  return Math.max(a[0], c[0]) > b.x && Math.min(a[0], c[0]) < b.x + b.w && Math.max(a[1], c[1]) > b.y && Math.min(a[1], c[1]) < b.y + b.h;
});
const rightAngled = (pts: Pt[]) => pts.every((a, i) => i === 0 || a[0] === pts[i - 1]![0] || a[1] === pts[i - 1]![1]);

describe('clearPath', () => {
  it('leaves a path that crosses no block as it is', () => {
    const pts: Pt[] = [[0, 96], [48, 96], [48, 400], [600, 400]];
    expect(clearPath(pts, [box('a', -224, 0), box('t', 600, 304)])).toEqual(pts);
  });

  it('a run through a step goes around it, right-angled, and still lands heading right', () => {
    const src = box('s', -224, 0), mid = box('m', 288, 288), tgt = box('t', 800, 288);
    // the horizontal run at y 400 passes straight through m
    const pts: Pt[] = [[0, 96], [48, 96], [48, 400], [800, 400]];
    const out = clearPath(pts, [src, mid, tgt]);
    expect(crosses(out, mid)).toBe(false);
    expect(rightAngled(out)).toBe(true);
    expect(out[0]).toEqual([0, 96]);
    expect(out[out.length - 1]).toEqual([800, 400]);
    const [px, py] = out[out.length - 2]!;
    expect(py).toBe(400);
    expect(px).toBeLessThan(800);
  });

  it('a first run that crosses a step leaves its own port heading right', () => {
    const src = box('s', -224, 0), mid = box('m', 96, 0), tgt = box('t', 800, 0);
    const out = clearPath([[0, 96], [800, 96]], [src, mid, tgt]);
    expect(crosses(out, mid)).toBe(false);
    expect(out[1]![1]).toBe(96);
    expect(out[1]![0]).toBeGreaterThan(0);
    expect(rightAngled(out)).toBe(true);
  });
});

describe('clearPath, own blocks', () => {
  it('a first run that heads back through its own source step leaves it heading right and goes around it', () => {
    const src = box('s', -224, 0), tgt = box('t', 800, 304);
    const out = clearPath([[0, 96], [-264, 96], [-264, 400], [800, 400]], [src, tgt]);
    expect(crosses(out, src)).toBe(false);
    expect(out[1]![1]).toBe(96);
    expect(out[1]![0]).toBeGreaterThan(0);
    expect(rightAngled(out)).toBe(true);
  });

  it('a last run that runs through its own target step goes around it and lands heading right', () => {
    const src = box('s', -224, 0), tgt = box('t', 288, 0);
    // comes down inside the target, then "lands" leftward
    const out = clearPath([[0, 96], [400, 96], [400, 128], [288, 128]], [src, tgt]);
    expect(crosses(out, tgt)).toBe(false);
    const [px, py] = out[out.length - 2]!;
    expect(py).toBe(128);
    expect(px).toBeLessThan(288);
  });
});

describe('clearRun', () => {
  it('a vertical run dragged into its own source step goes to the side that makes the shorter clear wire', () => {
    const src = box('s', -224, 0), tgt = box('t', 800, 0);
    const ends = { sx: 0, sy: 96, tx: 800, ty: 128 };
    const xs = clearRun({ xs: [-112], ys: [] }, ends, { vertical: true, index: 0 }, [src, tgt]).xs;
    expect(xs).toEqual([24]);
  });


  it('a vertical run dragged into a step is pushed to the nearer side of it', () => {
    const ends = { sx: 0, sy: 96, tx: 800, ty: 96 };
    const mid = box('m', 288, 0);
    expect(clearRun({ xs: [320], ys: [] }, ends, { vertical: true, index: 0 }, [mid]).xs).toEqual([264]);
    expect(clearRun({ xs: [480], ys: [] }, ends, { vertical: true, index: 0 }, [mid]).xs).toEqual([536]);
  });

  it('a horizontal run dragged into a step is pushed above or below it', () => {
    const ends = { sx: 0, sy: 96, tx: 800, ty: 96 };
    const mid = box('m', 288, 288);
    expect(clearRun({ xs: [48, 760], ys: [320] }, ends, { vertical: false, index: 0 }, [mid]).ys).toEqual([264]);
    expect(clearRun({ xs: [48, 760], ys: [432] }, ends, { vertical: false, index: 0 }, [mid]).ys).toEqual([472]);
  });
});

describe('clearBends', () => {
  it('returns bends whose path crosses no block', () => {
    const ends = { sx: 0, sy: 96, tx: 800, ty: 400 };
    const mid = box('m', 288, 288);
    const bends = clearBends(ends, { xs: [48], ys: [] }, [box('s', -224, 0), mid, box('t', 800, 304)]);
    expect(crosses(pointsOfShape(ends, bends), mid)).toBe(false);
  });
});

describe('legPath (a dragged end\'s leg; the user\'s rule 2, 2026-10-09)', () => {
  it('takes a track no other wire lies on when the usual one is taken; without `avoid` it is the usual one', () => {
    const usual = legPath({ x: 0, y: 0 }, { x: 160, y: 96 }, []);
    expect(usual).toEqual([[0, 0], [80, 0], [80, 96], [160, 96]]);
    // another wire lies up the usual elbow
    const others = new LineIndex();
    others.add('x', [[80, -40], [80, 140]]);
    const avoid = (pts: Pt[]) => [...others.stretches(pts, () => true).values()].reduce((n, s) => n + s.length, 0);
    const leg = legPath({ x: 0, y: 0 }, { x: 160, y: 96 }, [], avoid);
    expect(avoid(leg)).toBe(0);
    expect([leg[0], leg.at(-1)]).toEqual([[0, 0], [160, 96]]);
    expect(rightAngled(leg)).toBe(true);
  });
});
