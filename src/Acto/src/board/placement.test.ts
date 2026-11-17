import { describe, expect, it } from 'vitest';
import { defaultStepPositions, frameSizeOf, placeFrames } from './placement';

describe('placement', () => {
  it('keeps stored rects and places the rest by creation time without overlap', () => {
    const r = placeFrames([
      { id: 'b', createdAt: '2026-02-01', stored: null, size: { w: 500, h: 300 } },
      { id: 'a', createdAt: '2026-01-01', stored: null, size: { w: 500, h: 300 } },
      { id: 'k', createdAt: '2025-01-01', stored: { x: 0, y: 0, w: 600, h: 300 }, size: { w: 600, h: 300 } },
    ]);
    expect(r.get('k')).toEqual({ x: 0, y: 0, w: 600, h: 300 });
    const a = r.get('a')!, b = r.get('b')!;
    expect(a.y < b.y || (a.y === b.y && a.x < b.x)).toBe(true);
    for (const [i, p] of [...r.values()].entries()) for (const q of [...r.values()].slice(i + 1))
      expect(p.x + p.w + 79 < q.x || q.x + q.w + 79 < p.x || p.y + p.h + 79 < q.y || q.y + q.h + 79 < p.y).toBe(true);
  });
  it('sizes an empty frame at the minimum', () => expect(frameSizeOf(new Map())).toEqual({ w: 420, h: 196 }));
  it('grows a frame to hold its steps', () => {
    expect(frameSizeOf(new Map([['s', { x: 600, y: 300 }]]))).toEqual({ w: 600 + 210 + 28, h: 46 + 300 + 92 + 28 });
  });
  it('gives unplaced steps columns by depth', () => {
    const steps = new Map([['e', { nextStepIds: ['m'] }], ['m', { nextStepIds: [] }], ['p', { nextStepIds: [] }]]);
    const at = defaultStepPositions(['e'], steps, new Map());
    expect(at.get('e')).toEqual({ x: 28, y: 28 });
    expect(at.get('m')).toEqual({ x: 308, y: 28 });
    expect(at.get('p')!.x).toBe(588);
  });
  it('skips placed steps', () => {
    const steps = new Map([['e', { nextStepIds: [] }]]);
    expect(defaultStepPositions(['e'], steps, new Map([['e', { x: 1, y: 2 }]])).size).toBe(0);
  });
});
