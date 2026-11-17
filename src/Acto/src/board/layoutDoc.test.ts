import { describe, expect, it } from 'vitest';
import { parseActoLayout } from './layoutDoc';

describe('parseActoLayout', () => {
  it('reads steps, caches, parked and board', () => {
    const l = parseActoLayout({ v: 2, steps: { s1: { x: 10, y: 20 } }, caches: {}, parked: ['s1'], board: { x: 5, y: 6, w: 700, h: 300 } });
    expect(l).toEqual({ steps: { s1: { x: 10, y: 20 } }, caches: {}, parked: ['s1'], board: { x: 5, y: 6, w: 700, h: 300 } });
  });
  it.each([null, 'x', 42, { board: { x: 1, y: 2, w: 'w', h: 3 } }, { steps: { s1: { x: NaN, y: 0 } } }])(
    'treats %j as no layout', (raw) => {
      const l = parseActoLayout(raw);
      expect(l.board).toBeNull();
      expect(l.steps).toEqual({});
    });
});
