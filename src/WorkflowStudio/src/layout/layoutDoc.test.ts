import { describe, expect, it } from 'vitest';
import { parseLayout } from './layoutDoc';

describe('parseLayout', () => {
  it('reads a version-1 document', () => {
    expect(parseLayout({
      v: 1, sphere: { x: 128, y: 128 }, steps: { s1: { x: 288, y: 32 } }, caches: { c1: { x: 32, y: 288 } }, parked: ['s2'],
    })).toEqual({ sphere: { x: 128, y: 128 }, steps: { s1: { x: 288, y: 32 } }, caches: { c1: { x: 32, y: 288 } }, parked: ['s2'] });
  });

  it.each([null, undefined, 42, 'text', [1, 2], true])('treats %j as an empty layout', (raw) => {
    expect(parseLayout(raw)).toEqual({ sphere: null, steps: {}, caches: {}, parked: [] });
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

  it('returns a fresh object each call, so mutating one result never reaches another load', () => {
    const first = parseLayout(null);
    first.steps['s1'] = { x: 8, y: 8 };
    first.caches['c1'] = { x: 8, y: 8 };
    first.parked.push('p');
    const second = parseLayout(null);
    expect(second).toEqual({ sphere: null, steps: {}, caches: {}, parked: [] });
    expect(second.steps).not.toBe(first.steps);
  });

  it('keeps __proto__, x and constructor ids as plain keys without touching any prototype', () => {
    const raw = JSON.parse('{"steps":{"__proto__":{"x":8,"y":16},"x":{"x":24,"y":32},"constructor":{"x":40,"y":48}},"caches":{"__proto__":{"x":1,"y":2}}}');
    const doc = parseLayout(raw);
    expect(Object.keys(doc.steps).sort()).toEqual(['__proto__', 'constructor', 'x']);
    expect(Object.getPrototypeOf(doc.steps)).toBeNull();
    expect(doc.steps['x']).toEqual({ x: 24, y: 32 });
    expect(({} as Record<string, unknown>)['x']).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(parseLayout(null).steps['x']).toBeUndefined();
  });
});
