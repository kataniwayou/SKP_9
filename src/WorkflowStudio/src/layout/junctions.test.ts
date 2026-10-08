import { describe, expect, it } from 'vitest';
import { lengthOf, nearestOn, ownEnds, pointAt, slice } from './junctions';
import type { Pt } from './router';

const L: Pt[] = [[0, 0], [100, 0], [100, 50]];

describe('polyline geometry', () => {
  it('measures pieces without the gap between them', () => {
    expect(lengthOf([L])).toBe(150);
    expect(lengthOf([L, [[200, 0], [240, 0]]])).toBe(190);
  });

  it('finds the point at a distance and whether its run is vertical', () => {
    expect(pointAt([L], 40)).toEqual({ p: [40, 0], vertical: false });
    expect(pointAt([L], 120)).toEqual({ p: [100, 20], vertical: true });
    expect(pointAt([L], 999).p).toEqual([100, 50]);
    expect(pointAt([L, [[200, 0], [240, 0]]], 160)).toEqual({ p: [210, 0], vertical: false });
  });

  it('finds the nearest point and its distance along, within a range', () => {
    expect(nearestOn([L], [60, 30])).toEqual({ p: [60, 0], at: 60, gap: 30 });
    expect(nearestOn([L], [130, 40])).toEqual({ p: [100, 40], at: 140, gap: 30 });
    // not before 120: the nearest allowed point to (60, 30) is (100, 30) at distance 130
    expect(nearestOn([L], [60, 30], 120).at).toBe(130);
    expect(nearestOn([L], [130, 48], 0, 130).at).toBe(130);
  });

  it('slices a line between two distances', () => {
    expect(slice(L, 40, 120)).toEqual([[40, 0], [100, 0], [100, 20]]);
    expect(slice(L, 120, 999)).toEqual([[100, 20], [100, 50]]);
  });

  it('meets a horizontal host run square-on with a vertical last leg, a vertical one with a horizontal leg', () => {
    expect(ownEnds(0, 200, [96, 128], false)).toEqual({ ends: { sx: 0, sy: 200, tx: 96, ty: 144 }, tail: [[96, 128]] });
    expect(ownEnds(0, 40, [96, 128], false)).toEqual({ ends: { sx: 0, sy: 40, tx: 96, ty: 112 }, tail: [[96, 128]] });
    expect(ownEnds(0, 40, [96, 128], true)).toEqual({ ends: { sx: 0, sy: 40, tx: 96, ty: 128 }, tail: [] });
  });
});
