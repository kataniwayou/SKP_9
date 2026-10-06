import { describe, expect, it } from 'vitest';
import { EMPTY_LAYOUT, parseLayout } from './layoutDoc';

describe('parseLayout', () => {
  it('reads a version-1 document', () => {
    expect(parseLayout({
      v: 1, sphere: { x: 128, y: 128 }, steps: { s1: { x: 288, y: 32 } }, caches: { c1: { x: 32, y: 288 } }, parked: ['s2'],
    })).toEqual({ sphere: { x: 128, y: 128 }, steps: { s1: { x: 288, y: 32 } }, caches: { c1: { x: 32, y: 288 } }, parked: ['s2'] });
  });

  it.each([null, undefined, 42, 'text', [1, 2], true])('treats %j as an empty layout', (raw) => {
    expect(parseLayout(raw)).toEqual(EMPTY_LAYOUT);
  });

  it('ignores entries whose coordinates are not finite numbers, keeping the rest', () => {
    const doc = parseLayout({
      sphere: { x: '1', y: 2 },
      steps: { ok: { x: 8, y: 16 }, str: { x: '8', y: 16 }, nan: { x: Number.NaN, y: 0 }, inf: { x: Infinity, y: 0 }, arr: [1, 2], nul: null },
    });
    expect(doc.sphere).toBeNull();
    expect(doc.steps).toEqual({ ok: { x: 8, y: 16 } });
  });

  it('keeps unknown keys out and ignores parked entries that are not non-empty strings, deduped', () => {
    const doc = parseLayout({ parked: ['a', 7, '', 'a', null, 'b'], wires: { x: 1 } });
    expect(doc.parked).toEqual(['a', 'b']);
    expect(Object.keys(doc)).toEqual(['sphere', 'steps', 'caches', 'parked']);
  });
});
