import { describe, expect, it } from 'vitest';
import { route, simplify, type Box, type Pt } from './router';

const box = (id: string, x: number, y: number, w = 224, h = 160): Box => ({ id, x, y, w, h });

const orthogonal = (pts: Pt[]) => pts.every((p, i) => i === 0 || p[0] === pts[i - 1]![0] || p[1] === pts[i - 1]![1]);
/** No segment crosses a block's interior, except the source's first segment (leaving it) and the target's last (entering it). */
const clear = (pts: Pt[], srcId: string, tgtId: string, boxes: Box[]) => {
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i]!, [bx, by] = pts[i + 1]!;
    for (const b of boxes) {
      if ((b.id === srcId && i === 0) || (b.id === tgtId && i === pts.length - 2)) continue;
      const hit = Math.max(ax, bx) > b.x && Math.min(ax, bx) < b.x + b.w && Math.max(ay, by) > b.y && Math.min(ay, by) < b.y + b.h;
      if (hit) return false;
    }
  }
  return true;
};
const onGrid = (pts: Pt[]) => pts.every(([x, y]) => x % 8 === 0 && y % 8 === 0);

describe('route', () => {
  it('runs straight when the ends are level and far enough apart', () => {
    expect(route(512, 128, 576, 128, 'a', 'b', 0, [box('a', 288, 32), box('b', 576, 32)])).toEqual([[512, 128], [576, 128]]);
  });

  it('bends once each way (Z) with the elbow half way, snapped to 8', () => {
    const pts = route(512, 128, 576, 416, 'a', 'b', 0, [box('a', 288, 32), box('b', 576, 320)]);
    expect(pts).toEqual([[512, 128], [544, 128], [544, 416], [576, 416]]);
  });

  it('shifts the elbow by the fan-out nudge so sibling wires do not share a vertical run', () => {
    const pts = route(512, 120, 800, 416, 'a', 'b', -8, [box('a', 288, 32), box('b', 800, 320)]);
    expect(pts[1]![0]).toBe(648);
  });

  it('goes round a block that sits on the straight path', () => {
    const boxes = [box('a', 288, 32), box('mid', 576, 32), box('c', 864, 32)];
    const pts = route(512, 128, 864, 128, 'a', 'c', 0, boxes);
    expect(pts.length).toBeGreaterThan(2);
    expect(orthogonal(pts)).toBe(true);
    expect(clear(pts, 'a', 'c', boxes)).toBe(true);
  });

  it('makes a U for a back edge, entering the target from the left', () => {
    const boxes = [box('a', 288, 32), box('b', 576, 32)];
    const pts = route(800, 128, 288, 128, 'b', 'a', 0, boxes);
    expect(pts[0]).toEqual([800, 128]);
    expect(pts.at(-1)).toEqual([288, 128]);
    expect(pts.at(-2)![0]).toBeLessThan(288);
    expect(orthogonal(pts)).toBe(true);
    expect(onGrid(pts)).toBe(true);
    expect(clear(pts, 'b', 'a', boxes)).toBe(true);
  });

  it.each([-48, -40, -32, -24, -16, -8, 0, 8, 16, 24, 32, 40])('keeps a back edge clear of its own source block at fan-out nudge %i', (nudge) => {
    const boxes = [box('a', 288, 32), box('b', 576, 32)];
    const pts = route(800, 128 + nudge, 288, 128, 'b', 'a', nudge, boxes);
    expect(pts.slice(0, 2).every(([x]) => x >= 800)).toBe(true);
    expect(orthogonal(pts)).toBe(true);
    expect(onGrid(pts)).toBe(true);
    expect(clear(pts, 'b', 'a', boxes)).toBe(true);
  });

  it('keeps a +40 back edge (fan-out 6, target last) out of the next column and clear of every block', () => {
    // the gap between columns is 64, so x1 = sx + 24 + 40 would sit on the next column's left edge
    const boxes = [box('a', 288, 32), box('b', 576, 416), box('c', 864, 416), box('d', 864, 224), box('e', 864, 32)];
    const pts = route(800, 512, 288, 128, 'b', 'a', 40, boxes);
    expect(pts[1]![0]).toBeLessThanOrEqual(800 + 56);
    expect(orthogonal(pts)).toBe(true);
    expect(onGrid(pts)).toBe(true);
    expect(clear(pts, 'b', 'a', boxes)).toBe(true);
  });

  it('makes a U for a self-loop', () => {
    const pts = route(512, 128, 288, 128, 'a', 'a', 0, [box('a', 288, 32)]);
    expect(orthogonal(pts)).toBe(true);
    expect(onGrid(pts)).toBe(true);
    expect(pts.length).toBe(6);
    expect(clear(pts, 'a', 'a', [box('a', 288, 32)])).toBe(true);
  });

  it('still returns a route when there are no boxes at all', () => {
    const pts = route(512, 128, 288, 200, 'x', 'y', 0, []);
    expect(pts[0]).toEqual([512, 128]);
    expect(pts.at(-1)).toEqual([288, 200]);
    expect(orthogonal(pts)).toBe(true);
  });
});

describe('simplify', () => {
  it('drops repeated and collinear points', () => {
    expect(simplify([[0, 0], [0, 0], [8, 0], [16, 0], [16, 8]])).toEqual([[0, 0], [16, 0], [16, 8]]);
  });

  it('runs straight across a 16 px gap, where the landing rule sends a level wire straight', () => {
    const boxes = [box('a', 288, 32), box('b', 528, 32)];
    const pts = route(512, 128, 528, 128, 'a', 'b', 0, boxes);
    expect(pts).toEqual([[512, 128], [528, 128]]);
    expect(clear(pts, 'a', 'b', boxes)).toBe(true);
  });

  it('a short forward gap with different heights gets a Z with its elbow 8 past the source (plan 4)', () => {
    expect(route(0, 0, 16, 32, 'a', 'b', 0, [])).toEqual([[0, 0], [8, 0], [8, 32], [16, 32]]);
  });
});
