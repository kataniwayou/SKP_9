import { describe, expect, it } from 'vitest';
import { dragSegment, endsOf, normalize, pointsOfShape, segmentHandles, shapeFromPoints } from './shape';

const e = { sx: 0, sy: 96, tx: 288, ty: 160 };

describe('shape', () => {
  it('turns a Z route into one vertical run and back', () => {
    const b = shapeFromPoints([[0, 96], [144, 96], [144, 160], [288, 160]]);
    expect(b).toEqual({ xs: [144], ys: [] });
    expect(pointsOfShape(e, b)).toEqual([[0, 96], [144, 96], [144, 160], [288, 160]]);
  });

  it('reads a U route and a route whose first run is vertical', () => {
    expect(shapeFromPoints([[0, 96], [24, 96], [24, 300], [264, 300], [264, 160], [288, 160]])).toEqual({ xs: [24, 264], ys: [300] });
    expect(shapeFromPoints([[0, 96], [0, 160], [288, 160]])).toEqual({ xs: [0], ys: [] });
  });

  it('keeps its bends when the ends move: only the first and last runs follow', () => {
    expect(pointsOfShape({ sx: 32, sy: 40, tx: 400, ty: 200 }, { xs: [144], ys: [] })).toEqual([[32, 40], [144, 40], [144, 200], [400, 200]]);
  });

  it('drags a vertical run sideways and an inner horizontal run up or down, snapped to 8', () => {
    const u = { xs: [24, 264], ys: [300] };
    expect(dragSegment(u, 1, { x: 51, y: 0 }, e)).toEqual({ bends: { xs: [48, 264], ys: [300] } });
    expect(dragSegment(u, 2, { x: 0, y: 333 }, e)).toEqual({ bends: { xs: [24, 264], ys: [336] } });
  });

  it('dragging the first run inserts a jog; the last run slides the landing', () => {
    expect(dragSegment({ xs: [144], ys: [] }, 0, { x: 50, y: 50 }, e)).toEqual({ bends: { xs: [16, 144], ys: [48] } });
    expect(dragSegment({ xs: [144], ys: [] }, 2, { x: 200, y: 131 }, e)).toEqual({ landingY: 128 });
  });

  it('a tail glued to a step: the first run slides it instead of a jog (2026-10-25)', () => {
    expect(dragSegment({ xs: [144], ys: [] }, 0, { x: 50, y: 61 }, e, true)).toEqual({ tailY: 64 });
  });

  it('normalising removes a bend lined up with its neighbour, and returns null when none is left', () => {
    expect(normalize(e, { xs: [24, 264], ys: [96] })).toEqual({ xs: [264], ys: [] });
    expect(normalize({ sx: 0, sy: 96, tx: 288, ty: 96 }, { xs: [144], ys: [] })).toBeNull();
  });

  it('puts a handle on every run that has length, and reads the ends of a path', () => {
    const b = { xs: [144], ys: [] };
    expect(segmentHandles(e, b)).toEqual([
      { k: 0, x: 72, y: 96, vertical: false },
      { k: 1, x: 144, y: 128, vertical: true },
      { k: 2, x: 216, y: 160, vertical: false },
    ]);
    expect(endsOf([[0, 96], [144, 96], [144, 160], [288, 160]])).toEqual(e);
  });
});
