import { describe, expect, it } from 'vitest';
import type { StudioDocument } from '../app/document';
import type { Pt } from '../layout/router';
import { heldSnap, snapRun } from './runSnap';

/** A canvas with one step at (400, 0), the hub far off, and the given wires as drawn. */
function doc(wires: { id: string; points: Pt[] }[]): StudioDocument {
  return {
    placement: { sphere: { cx: -2000, cy: -2000 }, steps: new Map([['s', { x: 400, y: 0 }]]), caches: new Map() },
    wires,
  } as unknown as StudioDocument;
}

const all = () => true;

describe("a dragged run's alignment guide and snap (plan 10 phase 2, Visio)", () => {
  it("snaps a vertical run 10 flow px from a block's left edge, within a 12 px reach", () => {
    expect(snapRun(390, 'x', doc([]), 'w', 12, all)).toEqual({ v: 400, at: 400 });
  });

  it('does not snap 14 px away', () => {
    expect(snapRun(386, 'x', doc([]), 'w', 12, all)).toEqual({ v: 386, at: null });
  });

  it("prefers an allowed wire's parallel run 6 px away over a block edge 9 px away", () => {
    const other = { id: 'o', points: [[0, 300], [397, 300], [397, 900]] as Pt[] };
    expect(snapRun(391, 'x', doc([other]), 'w', 12, all)).toEqual({ v: 397, at: 397 });
  });

  it("never snaps onto a run of a wire it may not share a line with (another net: a short circuit)", () => {
    const other = { id: 'o', points: [[0, 300], [1000, 300], [1000, 900]] as Pt[] };
    expect(snapRun(995, 'x', doc([other]), 'w', 12, (id) => id !== 'o')).toEqual({ v: 995, at: null });
    expect(snapRun(995, 'x', doc([other]), 'w', 12, all)).toEqual({ v: 1000, at: 1000 });
  });

  it("never snaps onto its own wire's runs", () => {
    const own = { id: 'w', points: [[0, 300], [1000, 300], [1000, 900]] as Pt[] };
    expect(snapRun(995, 'x', doc([own]), 'w', 12, all)).toEqual({ v: 995, at: null });
  });

  it("matches a horizontal run to a step's centre and to the landing heights the caller gives", () => {
    expect(snapRun(85, 'y', doc([]), 'w', 12, all)).toEqual({ v: 80, at: 80 });
    expect(snapRun(110, 'y', doc([]), 'w', 12, all, [112])).toEqual({ v: 112, at: 112 });
  });

  it('gives at: null and the value unchanged with nothing in reach', () => {
    expect(snapRun(700, 'x', doc([]), 'w', 12, all)).toEqual({ v: 700, at: null });
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
