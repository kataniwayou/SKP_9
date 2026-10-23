import { describe, expect, it } from 'vitest';
import type { StudioDocument } from '../app/document';
import type { Pt } from '../layout/router';
import { guideAt, heldSnap, nearer, runGapMarks, snapRun, spaceRun } from './runSnap';

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
    expect(snapRun(390, 'x', doc([]), 'w', 12)).toEqual({ v: 400, at: 400 });
  });

  it('does not snap 14 px away', () => {
    expect(snapRun(386, 'x', doc([]), 'w', 12)).toEqual({ v: 386, at: null });
  });

  it("prefers a wire's parallel run 6 px away over a block edge 9 px away", () => {
    const other = { id: 'o', points: [[0, 300], [397, 300], [397, 900]] as Pt[] };
    expect(snapRun(391, 'x', doc([other]), 'w', 12)).toEqual({ v: 397, at: 397 });
  });

  it("snaps to any wire's parallel run, another net's too (2026-10-23: the caller drops a snap making a short circuit)", () => {
    const other = { id: 'o', points: [[0, 300], [1000, 300], [1000, 900]] as Pt[] };
    expect(snapRun(995, 'x', doc([other]), 'w', 12)).toEqual({ v: 1000, at: 1000 });
  });

  it("never snaps onto its own wire's runs", () => {
    const own = { id: 'w', points: [[0, 300], [1000, 300], [1000, 900]] as Pt[] };
    expect(snapRun(995, 'x', doc([own]), 'w', 12)).toEqual({ v: 995, at: null });
  });

  it("matches a horizontal run to a step's centre and to the landing heights the caller gives", () => {
    expect(snapRun(85, 'y', doc([]), 'w', 12)).toEqual({ v: 80, at: 80 });
    expect(snapRun(110, 'y', doc([]), 'w', 12, [112])).toEqual({ v: 112, at: 112 });
  });

  it('gives at: null and the value unchanged with nothing in reach', () => {
    expect(snapRun(700, 'x', doc([]), 'w', 12)).toEqual({ v: 700, at: null });
  });
});

describe('whether a snap is kept (final review 2026-10-21)', () => {
  const raw = 'raw', snapped = 'snapped';
  const keeps = (s: string) => s === snapped;
  it('keeps a snap the run still lies on, with its guide', () => {
    expect(heldSnap(40, snapped, () => raw, keeps, () => false)).toEqual({ shape: snapped, guide: 40 });
  });
  it('drops a snap the run was pushed off (a block side it would lie along): the raw drag, no guide', () => {
    expect(heldSnap(40, snapped, () => raw, () => false, () => false)).toEqual({ shape: raw, guide: null });
  });
  it("drops a snap that makes a short circuit the raw drag does not (a block line on another net's wire)", () => {
    expect(heldSnap(40, snapped, () => raw, keeps, (s) => s === snapped)).toEqual({ shape: raw, guide: null });
  });
  it('keeps the snap when the raw drag is a short circuit too', () => {
    expect(heldSnap(40, snapped, () => raw, keeps, () => true)).toEqual({ shape: snapped, guide: 40 });
  });
  it('nothing snapped: the shape as dragged, no guide', () => {
    expect(heldSnap(null, raw, () => raw, keeps, () => false)).toEqual({ shape: raw, guide: null });
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
  it('takes the nearer of an alignment and an equal gap', () => {
    expect(nearer(296, 290, 300)).toEqual({ at: 300, spaced: true });
    expect(nearer(296, 298, 300)).toEqual({ at: 298, spaced: false });
    expect(nearer(296, null, null)).toEqual({ at: null, spaced: false });
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
