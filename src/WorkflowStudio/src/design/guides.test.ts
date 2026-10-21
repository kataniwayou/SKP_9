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
    expect(snapToGuides(step('a', 16, 400), [step('b', 0, 0)], 12)).toEqual({ dx: 0, dy: 0, hit: { x: false, y: false }, lines: [], gaps: [] });
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
      const g = snapToGuides(step('D', 600, 0), [A, B, step('C', 900, 0)], 12);
      expect(g.dx).toBe(12);
      expect(sorted(g.gaps)).toEqual([{ axis: 'x', from: 224, to: 288, at: 160 }, { axis: 'x', from: 836, to: 900, at: 160 }]);
    });

    it('snaps in a column', () => {
      const g = snapToGuides(step('D', 0, 456), [step('A2', 0, 0), step('B2', 0, 224)], 12);
      expect(g.dy).toBe(-8);
      expect(sorted(g.gaps)).toEqual([{ axis: 'y', from: 160, to: 224, at: 224 }, { axis: 'y', from: 384, to: 448, at: 224 }]);
    });

    it("takes gaps only from pairs in the dragged block's row", () => {
      const g = snapToGuides(step('D', 586, 600), [A, B], 12);
      expect(g.dx).toBe(0);
      expect(g.gaps).toEqual([]);
    });

    it('the smaller move wins between alignment and an equal gap on one axis', () => {
      const g = snapToGuides(step('D', 586, 0), [A, B, step('E', 580, 400)], 12);
      expect(g.dx).toBe(-6);
      expect(g.gaps).toEqual([]);
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

  it('boxes every block of a document, with a processor middle on steps and the hub (its centre)', async () => {
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1')] }));
    const boxes = guideBoxes(doc);
    const s1 = doc.placement.steps.get('s1')!;
    expect(boxes.find((b) => b.id === 's1')).toEqual({ id: 's1', x: s1.x, y: s1.y, w: 224, h: 160, mid: s1.y + 96 });
    const wf = boxes.find((b) => b.id === 'wf')!;
    expect(wf.mid).toBe(wf.y + wf.h / 2);
  });
});
