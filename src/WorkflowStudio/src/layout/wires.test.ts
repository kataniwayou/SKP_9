import { describe, expect, it } from 'vitest';
import { AUDIT } from '../model/fixtures';
import type { Step } from '../model/graph';
import type { Placement } from './placement';
import { routeWires, tetherPoints, type WiringInput } from './wires';

const step = (id: string, next: string[], over: Partial<Step> = {}): Step => ({
  id, name: id, version: '1.0.0', description: null, processorId: 'p', nextStepIds: next, entryCondition: 1, updatedAt: '', audit: AUDIT, ...over,
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

describe('routeWires: fan-out of 5 with a back edge', () => {
  it('routes the back edge round, never through its own source or any block', () => {
    const next = ['a', 'c', 'd', 'e', 'f'];
    const positions: Record<string, [number, number]> = {
      a: [288, 32], b: [576, 32], c: [864, 32], d: [864, 224], e: [864, 416], f: [864, 608],
    };
    const wires = setup(
      [step('a', ['b']), step('b', next), step('c', []), step('d', []), step('e', []), step('f', [])],
      positions, new Set<string>(),
    );
    const boxes = [...Object.entries(positions)].map(([id, [x, y]]) => ({ id: `step:${id}`, x, y, w: 224, h: 160 }));
    boxes.push({ id: 'wf', x: 32, y: 32, w: 192, h: 192 });

    const back = wires.find((x) => x.id === 'b->a')!;
    expect(back.points.slice(0, 2).every(([x]) => x >= 800)).toBe(true);
    for (const wire of wires) {
      const pts = wire.points;
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, ay] = pts[i]!, [bx, by] = pts[i + 1]!;
        expect(ax === bx || ay === by).toBe(true);
        for (const b of boxes) {
          if ((b.id === (wire.source === 'wf' ? 'wf' : `step:${wire.source}`) && i === 0) || (b.id === `step:${wire.target}` && i === pts.length - 2)) continue;
          const hit = Math.max(ax, bx) > b.x && Math.min(ax, bx) < b.x + b.w && Math.max(ay, by) > b.y && Math.min(ay, by) < b.y + b.h;
          expect(hit, `${wire.id} segment ${i} crosses ${b.id}`).toBe(false);
        }
      }
      for (const [x, y] of pts) { expect(x % 8).toBe(0); expect(y % 8).toBe(0); }
    }
  });
});

describe('tetherPoints', () => {
  it('drops straight from the sphere bottom to a cache centred under it', () => {
    expect(tetherPoints({ cx: 128, cy: 128 }, { x: 48, y: 288 })).toEqual([[128, 224], [128, 288]]);
  });

  it('bends at right angles to a cache that was moved aside', () => {
    expect(tetherPoints({ cx: 128, cy: 128 }, { x: 320, y: 400 })).toEqual([[128, 224], [128, 312], [400, 312], [400, 400]]);
  });

  it('draws a manual shape with its bends kept, and a slid landing (plan 4)', () => {
    const placement: Placement = { sphere: { cx: 128, cy: 128 }, steps: new Map([['a', { x: 288, y: 32 }], ['b', { x: 576, y: 160 }]]), caches: new Map() };
    const input: WiringInput = {
      entryStepIds: ['a'],
      steps: new Map([['a', step('a', ['b'])], ['b', step('b', [])]]),
      brokenEdges: new Set<string>(),
      shapes: { 'a->b': { bends: { xs: [560], ys: [] }, landing: 72 } },
    };
    const ab = routeWires(input, placement).find((w) => w.id === 'a->b')!;
    expect(ab.points).toEqual([[512, 128], [560, 128], [560, 232], [576, 232]]);
  });
});
