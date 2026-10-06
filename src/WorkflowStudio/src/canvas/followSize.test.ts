import { describe, expect, it } from 'vitest';
import { keepCentre } from './followSize';

describe('keepCentre', () => {
  it('keeps the flow point at the centre of the canvas at its centre, at the same zoom', () => {
    const before = { x: 100, y: 50, zoom: 0.5 };
    const next = keepCentre(before, { width: 800, height: 600 }, { width: 1200, height: 700 });
    // the centre (400, 300) shows flow point ((400-100)/0.5, (300-50)/0.5) = (600, 500)
    expect(next.zoom).toBe(0.5);
    expect(600 * next.zoom + next.x).toBe(600);
    expect(500 * next.zoom + next.y).toBe(350);
  });

  it('changes nothing when the size is the same', () => {
    const v = { x: -30, y: 12, zoom: 1.25 };
    expect(keepCentre(v, { width: 640, height: 480 }, { width: 640, height: 480 })).toEqual(v);
  });
});
