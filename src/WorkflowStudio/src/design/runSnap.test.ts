import { describe, expect, it } from 'vitest';
import type { StudioDocument } from '../app/document';
import type { Pt } from '../layout/router';
import { guideAt, pickSnap, ranked, runGapMarks, snapRun, spaceRun, spaceRuns } from './runSnap';

/** A canvas with one step at (400, 0), the hub far off, and the given wires as drawn. */
function doc(wires: { id: string; points: Pt[] }[]): StudioDocument {
  return {
    placement: { sphere: { cx: -2000, cy: -2000 }, steps: new Map([['s', { x: 400, y: 0 }]]), caches: new Map() },
    graph: { steps: new Map() },
    wires,
  } as unknown as StudioDocument;
}

describe("a dragged run's alignment guide and snap (plan 10 phase 2, Visio)", () => {
  it("snaps a vertical run 10 flow px from a block's left edge, within a 12 px reach", () => {
    expect(snapRun(390, 'x', doc([]), 'w', 12)).toMatchObject({ v: 400, at: 400 });
  });

  it('does not snap 14 px away', () => {
    expect(snapRun(386, 'x', doc([]), 'w', 12)).toMatchObject({ v: 386, at: null });
  });

  it("prefers a wire's parallel run 6 px away over a block edge 9 px away", () => {
    const other = { id: 'o', points: [[0, 300], [397, 300], [397, 900]] as Pt[] };
    expect(snapRun(391, 'x', doc([other]), 'w', 12)).toMatchObject({ v: 397, at: 397 });
  });

  it("snaps to any wire's parallel run, another net's too (2026-10-23: the caller drops a snap making a short circuit)", () => {
    const other = { id: 'o', points: [[0, 300], [1000, 300], [1000, 900]] as Pt[] };
    expect(snapRun(995, 'x', doc([other]), 'w', 12)).toMatchObject({ v: 1000, at: 1000 });
  });

  it("never snaps onto its own wire's runs", () => {
    const own = { id: 'w', points: [[0, 300], [1000, 300], [1000, 900]] as Pt[] };
    expect(snapRun(995, 'x', doc([own]), 'w', 12)).toMatchObject({ v: 995, at: null });
  });

  it("matches a horizontal run to a step's centre and to the landing heights the caller gives", () => {
    expect(snapRun(85, 'y', doc([]), 'w', 12)).toMatchObject({ v: 80, at: 80 });
    expect(snapRun(110, 'y', doc([]), 'w', 12, [112])).toMatchObject({ v: 112, at: 112 });
  });

  it('gives at: null and the value unchanged with nothing in reach', () => {
    expect(snapRun(700, 'x', doc([]), 'w', 12)).toMatchObject({ v: 700, at: null });
  });
});

describe('which snap a dragged run takes (final review 2026-10-21; the wire guides sweep, 2026-10-23)', () => {
  // a shape is the place it was asked for; `raw` the drag without a snap
  const raw = -1;
  const shape = (at: number) => at;
  const holds = (s: number, at: number) => s === at;
  it('takes the nearest that holds, with its guide', () => {
    expect(pickSnap([{ at: 40, spaced: false }], shape, holds, () => false, () => raw)).toEqual({ shape: 40, at: 40, spaced: false });
  });
  it('drops one the run was pushed off (a block side it would lie along): the raw drag, no guide', () => {
    expect(pickSnap([{ at: 40, spaced: false }], shape, () => false, () => false, () => raw)).toEqual({ shape: raw, at: null, spaced: false });
  });
  it("drops one that makes a short circuit, even when the raw drag is one too: no guide on a short circuit", () => {
    expect(pickSnap([{ at: 40, spaced: false }], shape, holds, () => true, () => raw)).toEqual({ shape: raw, at: null, spaced: false });
  });
  it('takes the next when the nearest is a short circuit: a tie never hides a place it may take', () => {
    expect(pickSnap([{ at: 416, spaced: false }, { at: 432, spaced: false }], shape, holds, (s) => s === 416, () => raw))
      .toEqual({ shape: 432, at: 432, spaced: false });
  });
  it('a line the pointer is on that it may not take keeps the run there as dragged, not pulled to the next (a short circuit shows)', () => {
    expect(pickSnap([{ at: 416, spaced: false }, { at: 432, spaced: false }], shape, holds, (s) => s === 416, () => raw, (at) => at === 416))
      .toEqual({ shape: raw, at: null, spaced: false });
  });
  it('nothing in reach: the shape as dragged, no guide', () => {
    expect(pickSnap([], shape, holds, () => false, () => raw)).toEqual({ shape: raw, at: null, spaced: false });
  });
});

describe("a dragged run's equal spacing, as blocks have it (the user's, 2026-10-23)", () => {
  // two upright runs of other wires at x 100 and 200, beside the step (x 400 to 624), all over y 0 to 160
  const up = (id: string, x: number, y0 = 0, y1 = 160) => ({ id, points: [[x - 50, y0], [x, y0], [x, y1]] as Pt[] });
  it('snaps a run 4 px off so its gap to its neighbour equals the gap between two runs beside it', () => {
    expect(spaceRun(296, 0, 160, 'x', doc([up('p', 100), up('q', 200)]), 'w', 12)).toBe(300);
  });
  it('marks each pair of neighbours whose gap equals one of its own', () => {
    expect(runGapMarks(300, 0, 160, 'x', doc([up('p', 100), up('q', 200)]), 'w').map((m) => [m.from, m.to])).toEqual([[100, 200], [200, 300], [300, 400]]);
  });
  it('leaves out runs beside it but not alongside it (no overlap along it)', () => {
    expect(spaceRun(296, 0, 160, 'x', doc([up('p', 100, 500, 600), up('q', 200, 500, 600)]), 'w', 12)).toBe(null);
  });
  it("never counts the dragged wire's own runs", () => {
    // its own run at 100 is no neighbour: only the gaps either side of 300 (to 200 and to the step at 400) are marked
    expect(runGapMarks(300, 0, 160, 'x', doc([up('w', 100), up('q', 200)]), 'w').map((m) => [m.from, m.to])).toEqual([[200, 300], [300, 400]]);
  });
  it('ranks alignments and equal gaps nearest first, an alignment first when as near, each place once', () => {
    expect(ranked(296, [290], [300])).toEqual([{ at: 300, spaced: true }, { at: 290, spaced: false }]);
    expect(ranked(296, [298, 292], [300])).toEqual([{ at: 298, spaced: false }, { at: 292, spaced: false }, { at: 300, spaced: true }]);
    expect(ranked(296, [300], [292, 300])).toEqual([{ at: 300, spaced: false }, { at: 292, spaced: true }]);
    expect(ranked(296, [], [])).toEqual([]);
  });
});

describe("a wire's guide is drawn as a block's (the user's, 2026-10-23)", () => {
  it("runs from the dragged run to the block it lines up with, not across the canvas", () => {
    // a vertical run at the step's left edge (x 400), from y 300 to 380: the step is y 0 to 160
    expect(guideAt(400, 'x', doc([]), 'w', [300, 380])).toEqual({ axis: 'x', v: 400, from: 0, to: 380 });
  });
  it("runs to the nearest other wire's run on that line", () => {
    const far = { id: 'f', points: [[0, 900], [700, 900], [700, 1000]] as Pt[] };
    const close = { id: 'c', points: [[0, 500], [700, 500], [700, 560]] as Pt[] };
    expect(guideAt(700, 'x', doc([far, close]), 'w', [300, 380])).toEqual({ axis: 'x', v: 700, from: 300, to: 560 });
  });
  it("spaces a run midway between its two neighbours", () => {
    // runs at x 100 and the step at 400: the middle is 250
    expect(spaceRun(244, 0, 160, 'x', doc([{ id: 'p', points: [[50, 0], [100, 0], [100, 160]] as Pt[] }]), 'w', 12)).toBe(250);
  });
});

describe('spacing on a shared trunk (the wire guides sweep, 2026-10-23)', () => {
  // two fan-out wires on one trunk at x 640, from y 0 to 160, and a step from x 704
  // (the siblings reach down different lengths, as a -> b and a -> c do: still one neighbour, each gap marked once)
  const trunk = (id: string, y1 = 160) => ({ id, points: [[600, 0], [640, 0], [640, y1]] as Pt[] });
  const right = { placement: { sphere: { cx: -2000, cy: -2000 }, steps: new Map([['s', { x: 704, y: 0 }]]), caches: new Map() }, graph: { steps: new Map() } };
  const on = (wires: { id: string; points: Pt[] }[]) => ({ ...right, wires }) as unknown as Parameters<typeof spaceRun>[4];
  it('two runs on one line are no pair of neighbours: the middle between the trunk and the block is found, with its marks', () => {
    expect(spaceRuns(662, 0, 160, 'x', on([trunk('p'), trunk('q', 120)]), 'w', 12)).toContain(672);
    expect(runGapMarks(672, 0, 160, 'x', on([trunk('p'), trunk('q', 120)]), 'w').map((m) => [m.from, m.to])).toEqual([[640, 672], [672, 704]]);
  });
});
