import { describe, expect, it } from 'vitest';
import { graphDto, stepDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { guideBoxes, snapToGuides } from './guides';

const step = (id: string, x: number, y: number) => ({ id, x, y, w: 224, h: 160, mid: y + 96 });

describe('alignment guides (Visio dynamic grid, plan 10)', () => {
  it('snaps an edge 8 and 12 px off within a 12 px reach, and draws the line', () => {
    const g = snapToGuides(step('a', 8, 400), [step('b', 0, 0)], 12);
    expect([g.dx, g.dy]).toEqual([-8, 0]);
    expect(g.hit.x).toBe(true);
    expect(g.lines).toContainEqual({ x1: 0, y1: 0, x2: 0, y2: 560 });
    expect(snapToGuides(step('a', 12, 400), [step('b', 0, 0)], 12).dx).toBe(-12);
  });

  it('does nothing 16 px off with a 12 px reach', () => {
    expect(snapToGuides(step('a', 16, 400), [step('b', 0, 0)], 12)).toEqual({ dx: 0, dy: 0, x: 16, y: 400, hit: { x: false, y: false }, lines: [], gaps: [] });
  });

  it('matches an unrounded position (5 flow px is 10 screen px at 200%)', () => {
    const g = snapToGuides(step('a', 5, 400), [step('b', 0, 0)], 6);
    expect(g.dx).toBe(-5);
    expect(g.hit.x).toBe(true);
  });

  it('lines up processor middles, so a wire between them runs straight', () => {
    const g = snapToGuides(step('a', 400, 8), [step('b', 0, 0)], 12);
    expect(g.dy).toBe(-8);
    expect(g.lines).toContainEqual({ x1: 0, y1: 96, x2: 624, y2: 96 });
  });

  it('draws one line per matching coordinate, to the nearest matching block only', () => {
    const g = snapToGuides(step('m', 1000, 4), [step('far', 0, 0), step('near', 600, 0)], 12);
    expect(g.dy).toBe(-4);
    const tops = g.lines.filter((l) => l.y1 === 0 && l.y2 === 0);
    expect(tops).toEqual([{ x1: 600, y1: 0, x2: 1224, y2: 0 }]);
  });

  describe('like to like only (Visio, measured 2026-10-21: a top off a bottom, a centre off an edge, a left off a right do not snap)', () => {
    it("a top 6 px off another's bottom does not snap", () => {
      expect(snapToGuides(step('m', 1000, 166), [step('o', 0, 0)], 12).hit.y).toBe(false);
    });
    it("a centre 6 px off another's top does not snap", () => {
      expect(snapToGuides(step('m', 1000, -74), [step('o', 0, 0)], 12).hit.y).toBe(false);
    });
    it("a left edge 6 px off another's right edge does not snap", () => {
      expect(snapToGuides(step('m', 230, 1000), [step('o', 0, 0)], 12).hit.x).toBe(false);
    });
    it("a centre near another's processor middle does not snap to it (only middle to middle)", () => {
      // m's centre (y + 80 = 100) 4 px off o's processor middle (96); every like-to-like pair 20 px off: no hit
      expect(snapToGuides(step('m', 1000, 20), [step('o', 0, 0)], 12).hit.y).toBe(false);
    });
    it("the hub's centre is its processor middle: a step's middle lines up with it, so the wire runs straight", async () => {
      const doc = await loadedDocument(graphDto({ steps: [stepDto('s1')] }));
      const hub = guideBoxes(doc).find((b) => b.id === 'wf')!;
      expect(hub.mid).toBe(hub.y + hub.h / 2);
      const g = snapToGuides(step('m', 2000, hub.mid! - 96 + 6), [hub], 12);
      expect(g.dy).toBe(-6);
    });
  });

  describe('a snapped position is exact (final review, Important 1)', () => {
    // a cache centred under a step: the step's centre at 512, the cache 160 wide, so its left edge belongs at 432
    const s = step('S', 400, 0);
    const cacheAt = (x: number) => ({ id: 'k', x, y: 600, w: 160, h: 160 });

    it('a fractional pointer snapped to a centre lands exactly, and the centre line is drawn', () => {
      for (const raw of [438.40375466255585, 425.71234567891234, 431.1, 440.3]) {
        const g = snapToGuides(cacheAt(raw), [s], 12);
        expect(g.x).toBe(432);
        expect(g.lines).toContainEqual(expect.objectContaining({ x1: 512, x2: 512 }));
      }
    });

    it('an equal-gap snap from a fractional position lands exactly and marks the gaps', () => {
      const g = snapToGuides(step('D', 586.30000000000001, 0), [step('A', 0, 0), step('B', 288, 0)], 12);
      expect(g.x).toBe(576);
      expect(g.gaps).toHaveLength(2);
    });
  });

  describe('equal gaps (Visio dynamic grid)', () => {
    // A and B: a gap of 64 in a row; B's right edge at 512
    const A = step('A', 0, 0), B = step('B', 288, 0);
    const sorted = (gaps: readonly { axis: string; from: number; to: number; at: number }[]) => [...gaps].sort((p, q) => p.from - q.from);

    it('snaps to repeat a row gap 10 px off, and marks both gaps', () => {
      const g = snapToGuides(step('D', 586, 0), [A, B], 12);
      expect([g.dx, g.dy]).toEqual([-10, 0]);
      expect(sorted(g.gaps)).toEqual([{ axis: 'x', from: 224, to: 288, at: 160 }, { axis: 'x', from: 512, to: 576, at: 160 }]);
    });

    it('does not snap 16 px off', () => {
      const g = snapToGuides(step('D', 592, 0), [A, B], 12);
      expect(g.dx).toBe(0);
      expect(g.gaps).toEqual([]);
    });

    it('snaps from the right neighbour too', () => {
      const g = snapToGuides(step('D', 610, 0), [A, B, step('C', 900, 0)], 12);
      expect(g.dx).toBe(2);
      expect(sorted(g.gaps)).toEqual([{ axis: 'x', from: 224, to: 288, at: 160 }, { axis: 'x', from: 836, to: 900, at: 160 }]);
    });

    it('snaps in a column', () => {
      const g = snapToGuides(step('D', 0, 456), [step('A2', 0, 0), step('B2', 0, 224)], 12);
      expect(g.dy).toBe(-8);
      expect(sorted(g.gaps)).toEqual([{ axis: 'y', from: 160, to: 224, at: 224 }, { axis: 'y', from: 384, to: 448, at: 224 }]);
    });

    it('marks nothing beside two blocks stacked in one column: the same gap seen twice is no equal spacing (2026-10-23)', () => {
      const g = snapToGuides(step('D', 300, 100), [step('A', 0, 0), step('A2', 0, 200)], 12);
      expect(g.gaps).toEqual([]);
    });

    it('marks nothing for a block stacked with another in one column beside a third: the same gap from two blocks (2026-10-23)', () => {
      // d at (0, 0) and g at (352, 0): 128 apart; the new block under d's column, overlapping it, is 128 from g too
      const g = snapToGuides(step('new', 0, 120), [step('d', 0, 0), step('g', 352, 0)], 12);
      expect(g.gaps.filter((x) => x.axis === 'x')).toEqual([]);
    });

    it("spaces along a chain of blocks in any row: three blocks, in a row or not (the user's, 2026-10-23)", () => {
      // D below A and B's row: its left neighbour is B (right side 512), B's is A, 64 apart
      const g = snapToGuides(step('D', 586, 600), [A, B], 12);
      expect(g.dx).toBe(-10);
      expect(sorted(g.gaps)).toEqual([{ axis: 'x', from: 224, to: 288, at: 160 }, { axis: 'x', from: 512, to: 576, at: 760 }]);
    });

    it('a block under export-outcome spaces as export-outcome is under the top row, though no two share a column (the canvas, 2026-10-23)', () => {
      const top = step('split-exporter', 2304, 96), rec = step('record-outcome', 2592, 432), exp = step('export-outcome', 2880, 432);
      const g = snapToGuides(step('new', 2880, 760), [top, rec, exp], 40);
      expect(g.y).toBe(768);
      expect(g.gaps).toEqual(expect.arrayContaining([{ axis: 'y', from: 256, to: 432, at: 3104 }, { axis: 'y', from: 592, to: 768, at: 3104 }]));
      // and across, a chain as well: split-exporter, record-outcome and it are 64 apart left to right, in no one row
      expect(g.gaps).toEqual(expect.arrayContaining([{ axis: 'x', from: 2528, to: 2592, at: 592 }, { axis: 'x', from: 2816, to: 2880, at: 928 }]));
    });

    it('two blocks are no spacing: a chain needs a third', () => {
      const g = snapToGuides(step('new', 2880, 760), [step('export-outcome', 2880, 432)], 40);
      expect(g.gaps).toEqual([]);
      expect(g.y).toBe(760);
    });

    it('the smaller move wins between alignment and an equal gap on one axis', () => {
      const g = snapToGuides(step('D', 586, 0), [A, B, step('E', 580, 400)], 12);
      expect(g.dx).toBe(-6);
      expect(g.gaps).toEqual([]);
    });

    it('keeps equal gaps to the wires\' runs it is given as spacers, and never lines up with them (2026-10-25)', () => {
      // uprights at 100 and 644: a block 10 px right of their middle (260, 160 to each) snaps there, both gaps marked
      const runs = [{ id: '', x: 100, y: 0, w: 0, h: 400 }, { id: '', x: 644, y: 0, w: 0, h: 400 }];
      const g = snapToGuides(step('m', 270, 100), [], 12, { x: runs, y: [] });
      expect(g.x).toBe(260);
      expect(sorted(g.gaps)).toEqual([{ axis: 'x', from: 100, to: 260, at: 400 }, { axis: 'x', from: 484, to: 644, at: 400 }]);
      expect(g.lines).toEqual([]);
      // a left edge 4 px off an upright does not line up with it
      expect(snapToGuides(step('m', 104, 600), [], 12, { x: runs, y: [] }).hit.x).toBe(false);
    });

    it('ignores touching or overlapping blocks as gaps', () => {
      const g = snapToGuides(step('D', 470, 0), [step('A', 0, 0), step('B', 224, 0)], 12);
      expect(g.dx).toBe(0);
      expect(g.gaps).toEqual([]);
    });

    it('the nearest candidate wins at a wide reach (25% zoom = 48 flow px)', () => {
      const g = snapToGuides(step('D', 600, 0), [A, B], 48);
      expect(g.dx).toBe(-24);
    });

    it("counts the hub's square box", () => {
      const g = snapToGuides(step('T', 548, 16), [{ id: 'wf', x: 0, y: 0, w: 192, h: 192 }, step('S', 256, 16)], 12);
      expect(g.dx).toBe(-4);
      expect(g.gaps).toContainEqual({ axis: 'x', from: 192, to: 256, at: 192 });
    });
  });

  describe('tidy-up (phase 1 review)', () => {
    it("an axis no guide caught is rounded to the grid before the other axis's lines are measured", () => {
      // y snaps level with b; x (1003) is caught by nothing and lands on the grid at 1000: the line ends at its right edge there
      const g = snapToGuides(step('a', 1003, 4), [step('b', 0, 0)], 12);
      expect(g.hit).toEqual({ x: false, y: true });
      expect(g.lines).toContainEqual({ x1: 0, y1: 0, x2: 1000 + 224, y2: 0 });
    });

    it('the equal-gap row is the one the block lands in after its y snap, not the one it was released in', () => {
      // A and B 100 apart in a row (0..160); C far right a little lower (156..316). M released at 164, just below the row,
      // snaps up level with C (156), into the row, 105 past B: it then takes the row's gap of 100
      const g = snapToGuides(step('M', 653, 164), [step('A', 0, 0), step('B', 324, 0), step('C', 2000, 156)], 12);
      expect(g.y).toBe(156);
      expect(g.hit.x).toBe(true);
      expect(g.x).toBe(648);
    });
  });

  it('boxes every block of a document, with a processor middle on steps and the hub (its centre)', async () => {
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1')] }));
    const boxes = guideBoxes(doc);
    const s1 = doc.placement.steps.get('s1')!;
    expect(boxes.find((b) => b.id === 's1')).toEqual({ id: 's1', x: s1.x, y: s1.y, w: 224, h: 160, mid: s1.y + 96 });
    const wf = boxes.find((b) => b.id === 'wf')!;
    expect(wf.mid).toBe(wf.y + wf.h / 2);
  });
});
