import { describe, expect, it } from 'vitest';
import { CELL, GRID, STEP_H, STEP_W } from './geometry';
import { parseLayout, type LayoutDoc } from './layoutDoc';
import { place, type PlacementInput } from './placement';

const input = (over: Partial<PlacementInput> = {}): PlacementInput => ({
  entryStepIds: ['a'],
  reachable: [{ id: 'a', nextStepIds: ['b'] }, { id: 'b', nextStepIds: [] }],
  parkedIds: [],
  cacheIds: [],
  layout: parseLayout(null),
  ...over,
});

const layout = (over: Partial<LayoutDoc>): LayoutDoc => ({ ...parseLayout(null), ...over });

function overlaps(a: { x: number; y: number }, b: { x: number; y: number }) {
  return a.x < b.x + STEP_W && b.x < a.x + STEP_W && a.y < b.y + STEP_H && b.y < a.y + STEP_H;
}

describe('place', () => {
  it('lays out a never-laid-out chain in columns 288 apart with the sphere one column left', async () => {
    const p = await place(input());

    expect(p.steps.get('a')!.x).toBe(288);
    expect(p.steps.get('b')!.x).toBe(576);
    expect(p.sphere.cx).toBe(128);
    // spec §9: after layout every step border lies on a 32 px line
    for (const pos of p.steps.values()) {
      expect(pos.x % CELL).toBe(0);
      expect(pos.y % CELL).toBe(0);
    }
  });

  it('centres the sphere on its entry steps, so a single entry wire runs straight', async () => {
    const p = await place(input());
    expect(p.sphere.cy).toBe(p.steps.get('a')!.y + 96);
  });

  it('keeps stored positions, snapped to the 8 px grid', async () => {
    const p = await place(input({
      layout: layout({ sphere: { x: 131, y: 125 }, steps: { a: { x: 291, y: 37 }, b: { x: 600, y: 300 } } }),
    }));

    expect(p.steps.get('a')).toEqual({ x: 288, y: 40 });
    expect(p.steps.get('b')).toEqual({ x: 600, y: 304 }); // 300 / 8 = 37.5 rounds up
    expect(p.sphere).toEqual({ cx: 128, cy: 128 });
  });

  it('places a block with no stored position below the stored ones, without overlap', async () => {
    const p = await place(input({ layout: layout({ sphere: { x: 128, y: 128 }, steps: { a: { x: 288, y: 32 } } }) }));

    const a = p.steps.get('a')!, b = p.steps.get('b')!;
    expect(a).toEqual({ x: 288, y: 32 });
    expect(b.y).toBeGreaterThanOrEqual(a.y + STEP_H + 64);
    expect(b.x % GRID).toBe(0);
  });

  it('puts parked steps without a position in a row below everything', async () => {
    const p = await place(input({ parkedIds: ['p1', 'p2'] }));

    const all = [...p.steps.entries()];
    const p1 = p.steps.get('p1')!, p2 = p.steps.get('p2')!;
    const lowestWired = Math.max(p.steps.get('a')!.y, p.steps.get('b')!.y);
    expect(p1.y).toBeGreaterThan(lowestWired);
    expect(p1.y).toBe(p2.y);
    for (const [i, pi] of all) for (const [j, pj] of all) if (i < j) expect(overlaps(pi, pj)).toBe(false);
  });

  it('stacks caches under the sphere unless they have a stored position', async () => {
    const p = await place(input({
      cacheIds: ['c1', 'c2', 'c3'],
      layout: layout({ caches: { c3: { x: 1000, y: 1000 } } }),
    }));
    const { cx, cy } = p.sphere;

    expect(p.caches.get('c1')).toEqual({ x: cx - 96, y: cy + 96 + 64 });
    expect(p.caches.get('c2')).toEqual({ x: cx - 96, y: cy + 96 + 64 + 96 });
    expect(p.caches.get('c3')).toEqual({ x: 1000, y: 1000 });
  });

  it('ignores stored positions of steps that are not on the canvas', async () => {
    const p = await place(input({ layout: layout({ steps: { gone: { x: 8, y: 8 } } }) }));
    expect(p.steps.has('gone')).toBe(false);
  });

  it('handles a workflow whose only entry id names no step', async () => {
    const p = await place(input({ entryStepIds: ['ghost'], reachable: [] }));
    expect(p.steps.size).toBe(0);
    expect(p.sphere).toEqual({ cx: 128, cy: 128 });
  });

  it('does not read a cache position from the prototype', async () => {
    const caches = Object.create({ c1: { x: 1000, y: 1000 } }) as LayoutDoc['caches'];
    const p = await place(input({ cacheIds: ['c1'], layout: layout({ caches }) }));
    expect(p.caches.get('c1')).not.toEqual({ x: 1000, y: 1000 });
  });
});
