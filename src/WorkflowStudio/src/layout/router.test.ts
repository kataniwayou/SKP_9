import { describe, expect, it } from 'vitest';
import { route, simplify, type Box, type Pt } from './router';

const box = (id: string, x: number, y: number, w = 224, h = 160): Box => ({ id, x, y, w, h });

const orthogonal = (pts: Pt[]) => pts.every((p, i) => i === 0 || p[0] === pts[i - 1]![0] || p[1] === pts[i - 1]![1]);
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
  });

  it('makes a U for a back edge, entering the target from the left', () => {
    const boxes = [box('a', 288, 32), box('b', 576, 32)];
    const pts = route(800, 128, 288, 128, 'b', 'a', 0, boxes);
    expect(pts[0]).toEqual([800, 128]);
    expect(pts.at(-1)).toEqual([288, 128]);
    expect(pts.at(-2)![0]).toBeLessThan(288);
    expect(orthogonal(pts)).toBe(true);
    expect(onGrid(pts)).toBe(true);
  });

  it('makes a U for a self-loop', () => {
    const pts = route(512, 128, 288, 128, 'a', 'a', 0, [box('a', 288, 32)]);
    expect(orthogonal(pts)).toBe(true);
    expect(onGrid(pts)).toBe(true);
    expect(pts.length).toBe(6);
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
});
