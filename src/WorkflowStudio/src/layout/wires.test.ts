import { describe, expect, it } from 'vitest';
import type { Step } from '../model/graph';
import type { Placement } from './placement';
import { routeWires, tetherPoints, type WiringInput } from './wires';

const step = (id: string, next: string[], over: Partial<Step> = {}): Step => ({
  id, name: id, version: '1.0.0', processorId: 'p', nextStepIds: next, entryCondition: 1, updatedAt: '', ...over,
});
function setup(steps: Step[], positions: Record<string, [number, number]>, brokenEdges: ReadonlySet<string>) {
  const input: WiringInput = {
    entryStepIds: ['a'],
    steps: new Map(steps.map((s) => [s.id, s])),
    brokenEdges,
  };
  const placement: Placement = {
    sphere: { cx: 128, cy: 128 },
    steps: new Map(Object.entries(positions).map(([id, [x, y]]) => [id, { x, y }])),
    caches: new Map(),
  };
  return routeWires(input, placement);
}

describe('routeWires', () => {
  it('draws the entry wire and a step wire straight when they line up', () => {
    const wires = setup([step('a', ['b']), step('b', [])], { a: [288, 32], b: [576, 32] }, new Set<string>());

    expect(wires.find((w) => w.id === 'wf->a')!.points).toEqual([[224, 128], [288, 128]]);
    expect(wires.find((w) => w.id === 'a->b')!.points).toEqual([[512, 128], [576, 128]]);
  });

  it('colours a wire by its target step entry condition', () => {
    const wires = setup([step('a', ['b']), step('b', [], { entryCondition: 2 })], { a: [288, 32], b: [576, 32] }, new Set<string>());
    expect(wires.find((w) => w.id === 'a->b')!.condition).toBe(2);
  });

  it('marks a wire broken only when validate named it (the studio never compares schemas itself)', () => {
    const wires = setup(
      [step('a', ['b']), step('b', [])],
      { a: [288, 32], b: [576, 32] },
      new Set(['a->b']),
    );
    expect(wires.find((w) => w.id === 'a->b')!.broken).toBe(true);
    expect(wires.find((w) => w.id === 'wf->a')!.broken).toBe(false);
  });

  it('does not draw a wire to a step that is not on the canvas (a dangling next-step id)', () => {
    const wires = setup([step('a', ['ghost'])], { a: [288, 32] }, new Set<string>());
    expect(wires.map((w) => w.id)).toEqual(['wf->a']);
  });

  it('routes a back edge and a self-loop orthogonally, every point on the 8 px grid', () => {
    const wires = setup([step('a', ['b', 'a']), step('b', ['a'])], { a: [288, 32], b: [576, 32] }, new Set<string>());

    for (const w of wires) {
      for (let i = 1; i < w.points.length; i++) {
        const [x0, y0] = w.points[i - 1]!, [x1, y1] = w.points[i]!;
        expect(x0 === x1 || y0 === y1).toBe(true);
      }
      for (const [x, y] of w.points) { expect(x % 8).toBe(0); expect(y % 8).toBe(0); }
    }
    expect(wires.map((w) => w.id).sort()).toEqual(['a->a', 'a->b', 'b->a', 'wf->a']);
  });

  it('ends every wire on the target step left edge at its landing height', () => {
    const wires = setup([step('a', ['b']), step('b', [])], { a: [288, 32], b: [576, 320] }, new Set<string>());
    expect(wires.find((w) => w.id === 'a->b')!.points.at(-1)).toEqual([576, 416]);
  });
});

describe('tetherPoints', () => {
  it('drops straight from the sphere bottom to a cache centred under it', () => {
    expect(tetherPoints({ cx: 128, cy: 128 }, { x: 32, y: 288 })).toEqual([[128, 224], [128, 288]]);
  });

  it('bends at right angles to a cache that was moved aside', () => {
    expect(tetherPoints({ cx: 128, cy: 128 }, { x: 320, y: 400 })).toEqual([[128, 224], [128, 312], [416, 312], [416, 400]]);
  });
});
