import { describe, expect, it } from 'vitest';
import type { Box, Pt } from './router';
import { routeBlocks, Tracks } from './search';

/** A step's box (224 × 160); its output is at (x + 224, y + 96), its input at (x, y + 96). */
const step = (id: string, x: number, y: number): Box => ({ id, x, y, w: 224, h: 160 });
const out = (b: Box): Pt => [b.x + b.w, b.y + 96];
const inp = (b: Box): Pt => [b.x, b.y + 96];
const wire = (a: Box, b: Box, boxes: Box[], tracks?: Tracks) => routeBlocks(out(a), inp(b), a, b, boxes, tracks);

const orthogonal = (pts: readonly Pt[]) => pts.every((p, i) => i === 0 || p[0] === pts[i - 1]![0] || p[1] === pts[i - 1]![1]);
/** No run strictly inside any box. */
const clear = (pts: readonly Pt[], boxes: readonly Box[]) => pts.every((p, i) => {
  if (i === 0) return true;
  const q = pts[i - 1]!;
  return boxes.every((b) => !(Math.max(p[0], q[0]) > b.x && Math.min(p[0], q[0]) < b.x + b.w && Math.max(p[1], q[1]) > b.y && Math.min(p[1], q[1]) < b.y + b.h));
});

describe("Visio's base shapes for a block-to-block wire (plan 10 phase 3, spec §4.2, §4.3)", () => {
  it('runs straight between level blocks', () => {
    const a = step('a', 352, 32), b = step('b', 704, 32);
    expect(wire(a, b, [a, b])).toEqual([[576, 128], [704, 128]]);
  });

  it("bends a Z with its upright at the source's 64 px stub (Visio: fan-out, S1/S2)", () => {
    const a = step('a', 352, 32), b = step('b', 704, 320);
    expect(wire(a, b, [a, b])).toEqual([[576, 128], [640, 128], [640, 416], [704, 416]]);
  });

  it('puts the upright mid-gap when the gap is shorter than two stubs', () => {
    const a = step('a', 352, 32), b = step('b', 640, 320);
    expect(wire(a, b, [a, b])).toEqual([[576, 128], [608, 128], [608, 416], [640, 416]]);
  });

  it('turns back over the top of both, 64 above, for a target behind at the same height (Visio: overtaking)', () => {
    const a = step('a', 704, 32), b = step('b', 352, 32);
    expect(wire(a, b, [a, b])).toEqual([[928, 128], [992, 128], [992, -32], [288, -32], [288, 128], [352, 128]]);
  });

  it("runs back through the free band, 64 off the target, for a target behind and below (Visio: glue and moves)", () => {
    const a = step('a', 704, 32), b = step('b', 352, 352);
    expect(wire(a, b, [a, b])).toEqual([[928, 128], [992, 128], [992, 288], [288, 288], [288, 448], [352, 448]]);
  });

  it('and 64 under the target for a target behind and above', () => {
    const a = step('a', 704, 352), b = step('b', 352, 32);
    expect(wire(a, b, [a, b])).toEqual([[928, 448], [992, 448], [992, 256], [288, 256], [288, 128], [352, 128]]);
  });

  it('goes over the top of both when the blocks overlap in height', () => {
    const a = step('a', 704, 32), b = step('b', 352, 96);
    expect(wire(a, b, [a, b])).toEqual([[928, 128], [992, 128], [992, -32], [288, -32], [288, 192], [352, 192]]);
  });

  it('goes over the top when the band is too narrow to keep half the clearance off the source', () => {
    const a = step('a', 704, 32), b = step('b', 352, 224);
    expect(wire(a, b, [a, b])[2]).toEqual([992, -32]);
  });
});

describe('the search, when the base shape is refused (spec §4.2.1)', () => {
  it("goes round a block in the way 64 off it, hugging it, and comes back down at the target's stub (Visio: obstacle)", () => {
    const a = step('a', 0, 32), o = step('o', 448, 96), b = step('b', 896, 32);
    expect(wire(a, b, [a, o, b])).toEqual([[224, 128], [384, 128], [384, 32], [832, 32], [832, 128], [896, 128]]);
  });

  it('takes the nearer side of the block in the way', () => {
    const a = step('a', 0, 32), o = step('o', 448, -32), b = step('b', 896, 32);
    const pts = wire(a, b, [a, o, b]);
    expect(pts[2]).toEqual([384, 192]); // under it: o's bottom (128) + 64
  });

  it('goes under a level block in the way: the processor middle is below its centre, so under is nearer (Visio went under its level one too)', () => {
    const a = step('a', 0, 32), o = step('o', 448, 32), b = step('b', 896, 32);
    expect(wire(a, b, [a, o, b])[2]).toEqual([384, 256]);
  });

  it('runs straight through a gap that keeps half the clearance (32) on both sides', () => {
    const a = step('a', 0, 32), g1 = step('g1', 448, -72), g2 = step('g2', 448, 168), b = step('b', 896, 32);
    expect(wire(a, b, [a, g1, g2, b])).toEqual([[224, 128], [896, 128]]);
  });

  it('goes round a gap too narrow for that', () => {
    const a = step('a', 0, 32), g1 = step('g1', 448, -56), g2 = step('g2', 448, 152), b = step('b', 896, 32);
    const boxes = [a, g1, g2, b];
    const pts = wire(a, b, boxes);
    expect(pts.length).toBeGreaterThan(2);
    expect(orthogonal(pts)).toBe(true);
    expect(clear(pts, boxes)).toBe(true);
  });

  it("keeps a track's 32 off another net's run lying on its usual upright, and never on it", () => {
    const a = step('a', 352, 32), b = step('b', 704, 320);
    const tracks = new Tracks();
    tracks.add([[640, 200], [640, 350]]);
    const pts = wire(a, b, [a, b], tracks);
    expect(pts[0]).toEqual([576, 128]);
    expect(pts[pts.length - 1]).toEqual([704, 416]);
    expect(orthogonal(pts)).toBe(true);
    expect(tracks.costOf(pts)).toEqual({ on: 0, beside: 0 });
  });

  it("nests a track (32) inside another net's run on the source's stub, as Visio's fan-out does", () => {
    // a target behind and below; another net's upright where the U's first upright would be (992)
    const a = step('a', 704, 32), b = step('b', 352, 320);
    const tracks = new Tracks();
    tracks.add([[992, -200], [992, 700]]);
    const pts = wire(a, b, [a, b], tracks);
    expect(tracks.costOf(pts)).toEqual({ on: 0, beside: 0 });
    expect(pts[1]).toEqual([960, 128]);
  });
});

/** How far the run p → q keeps off `box` (0 when it touches or enters it). */
function gapTo(p: Pt, q: Pt, box: Box): number {
  const dx = Math.max(box.x - Math.max(p[0], q[0]), Math.min(p[0], q[0]) - (box.x + box.w), 0);
  const dy = Math.max(box.y - Math.max(p[1], q[1]), Math.min(p[1], q[1]) - (box.y + box.h), 0);
  return Math.max(dx, dy);
}

describe('every route (fuzzed)', () => {
  it('starts and ends on its ports square-on, is right-angled, and never runs inside a block', () => {
    let seed = 7;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let n = 0; n < 200; n++) {
      // blocks on a 352 × 288 lattice, some cells empty: always a way between them
      const boxes: Box[] = [];
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if (rand() < 0.6) boxes.push(step(`b${i}${j}`, i * 352, j * 288));
      if (boxes.length < 2) continue;
      const a = boxes[Math.floor(rand() * boxes.length)]!, b = boxes[Math.floor(rand() * boxes.length)]!;
      if (a === b) continue;
      const pts = wire(a, b, boxes);
      expect(pts[0]).toEqual(out(a));
      expect(pts[pts.length - 1]).toEqual(inp(b));
      expect(pts[1]![1]).toBe(out(a)[1]);
      expect(pts[1]![0]).toBeGreaterThan(out(a)[0]);
      expect(pts[pts.length - 2]![1]).toBe(inp(b)[1]);
      expect(pts[pts.length - 2]![0]).toBeLessThan(inp(b)[0]);
      expect(orthogonal(pts)).toBe(true);
      expect(clear(pts, boxes)).toBe(true);
    }
  });

  it("keeps a track (32) off its own blocks, but for its stubs, when other nets' runs make it work hard (phase 3's deferred list)", () => {
    let seed = 11;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let n = 0; n < 600; n++) {
      // blocks on a 352 × 288 lattice, a grid step or three off it, some cells empty
      const boxes: Box[] = [];
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if (rand() < 0.6) boxes.push(step(`b${i}${j}`, i * 352 + Math.floor(rand() * 4) * 8, j * 288 + Math.floor(rand() * 4) * 8));
      if (boxes.length < 2) continue;
      const a = boxes[Math.floor(rand() * boxes.length)]!, b = boxes[Math.floor(rand() * boxes.length)]!;
      if (a === b) continue;
      // other nets' runs, a track off every block as the router draws them
      const tracks = new Tracks();
      for (let r = 0; r < 6; r++) {
        const x = Math.floor(rand() * 180) * 8, y = Math.floor(rand() * 150) * 8, l = 200 + Math.floor(rand() * 60) * 8;
        const run: Pt[] = rand() < 0.5 ? [[x, y], [x, y + l]] : [[x, y], [x + l, y]];
        if (!boxes.some((box) => gapTo(run[0]!, run[1]!, box) < 32)) tracks.add(run);
      }
      const pts = wire(a, b, boxes, tracks);
      for (let i = 2; i < pts.length - 1; i++) {
        for (const box of [a, b]) expect(gapTo(pts[i - 1]!, pts[i]!, box), `trial ${n} run ${i}: ${JSON.stringify(pts)}`).toBeGreaterThanOrEqual(32);
      }
    }
  });
});
