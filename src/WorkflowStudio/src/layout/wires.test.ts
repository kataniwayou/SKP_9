import { describe, expect, it } from 'vitest';
import { AUDIT } from '../model/fixtures';
import type { Step } from '../model/graph';
import type { Placement } from './placement';
import { routeWires, tetherPoints, type WiringInput } from './wires';

const step = (id: string, next: string[], over: Partial<Step> = {}): Step => ({
  id, name: id, version: '1.0.0', description: null, processorId: 'p', nextStepIds: next, entryCondition: 1, updatedAt: '', audit: AUDIT, ...over,
});
function setup(steps: Step[], positions: Record<string, [number, number]>, brokenEdges: ReadonlySet<string>, shapes?: WiringInput['shapes']) {
  const input: WiringInput = {
    entryStepIds: ['a'],
    steps: new Map(steps.map((s) => [s.id, s])),
    brokenEdges,
    shapes,
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

describe('junctions (plan 7)', () => {
  // s (288,32) -> b (864,32): a straight host along y 128; t (288,288) -> c (864,288); u (288,544) -> b
  const steps = () => [
    step('s', ['b']), step('t', ['c']), step('u', ['b']),
    step('b', [], { entryCondition: 2 }), step('c', [], { entryCondition: 2 }), step('x', [], { entryCondition: 1 }),
  ];
  const at = { s: [288, 32], t: [288, 288], u: [288, 544], b: [864, 32], c: [864, 288], x: [864, 544] } as Record<string, [number, number]>;
  const boxes = Object.values(at).map(([x, y]) => ({ x, y, w: 224, h: 160 }));
  const through = (pts: readonly (readonly [number, number])[]) => pts.some((a, i) => {
    const c = pts[i + 1];
    return c !== undefined && boxes.some((b) => Math.max(a[0], c[0]) > b.x && Math.min(a[0], c[0]) < b.x + b.w && Math.max(a[1], c[1]) > b.y && Math.min(a[1], c[1]) < b.y + b.h);
  });
  const square = (pts: readonly (readonly [number, number])[]) => pts.every((p, i) => i === 0 || p[0] === pts[i - 1]![0] || p[1] === pts[i - 1]![1]);
  const join = (id: string, host: string, d: number) => ({ [id]: { bends: null, landing: null, contact: { host, at: d } } });

  it('a wire on another goes to a dot on its line, square-on, and splits off to its own step', () => {
    const wires = setup(steps(), at, new Set<string>(), join('t->c', 's->b', 176));
    const host = wires.find((w) => w.id === 's->b')!, w = wires.find((x) => x.id === 't->c')!;
    expect(w.joint!.host).toBe('s->b');
    expect(w.joint!.contact).toEqual([688, 128]);
    // own line: last leg vertical onto the horizontal host run
    const n = w.points.length;
    expect(w.points[n - 1]).toEqual([688, 128]);
    expect(w.points[n - 2]![0]).toBe(688);
    // split on the host line, after the contact, short of the host's arrow tip
    expect(w.joint!.split![1]).toBe(128);
    expect(w.joint!.split![0]).toBeGreaterThan(688);
    expect(w.joint!.split![0]).toBeLessThanOrEqual(host.points[host.points.length - 1]![0] - 16);
    // the branch lands on c, heading right
    const br = w.joint!.branch;
    expect(br[0]).toEqual(w.joint!.split);
    expect(br[br.length - 1]![0]).toBe(864);
    expect(br[br.length - 2]![1]).toBe(br[br.length - 1]![1]);
    for (const line of [w.points, br]) { expect(square(line)).toBe(true); expect(through(line)).toBe(false); }
  });

  it('a wire into its host\'s step merges: no split, no branch', () => {
    const wires = setup(steps(), at, new Set<string>(), join('u->b', 's->b', 176));
    const w = wires.find((x) => x.id === 'u->b')!;
    expect(w.joint!.split).toBeNull();
    expect(w.joint!.branch).toEqual([]);
  });

  it('a chain routes host first: a wire may sit on a joined wire\'s own line', () => {
    const wires = setup(steps(), at, new Set<string>(), { ...join('u->b', 't->c', 40), ...join('t->c', 's->b', 176) });
    expect(wires.find((x) => x.id === 't->c')!.joint).toBeDefined();
    const u = wires.find((x) => x.id === 'u->b')!;
    expect(u.joint!.host).toBe('t->c');
    expect(u.joint!.split).not.toBeNull();
  });

  it('another colour, a missing host, itself or a loop: drawn plain', () => {
    const cases = [join('t->c', 'nope', 40), join('t->c', 't->c', 40), { ...join('t->c', 'u->b', 40), ...join('u->b', 't->c', 40) }];
    for (const shapes of cases) {
      const wires = setup(steps(), at, new Set<string>(), shapes);
      expect(wires.find((x) => x.id === 't->c')!.joint).toBeUndefined();
    }
    const other = setup([...steps(), step('v', ['x'])], { ...at, v: [288, 800] }, new Set<string>(), join('v->x', 's->b', 40));
    expect(other.find((x) => x.id === 'v->x')!.joint).toBeUndefined();
  });

  it('keeps the contact clear of the host\'s ends', () => {
    const wires = setup(steps(), at, new Set<string>(), join('t->c', 's->b', 0));
    expect(wires.find((x) => x.id === 't->c')!.joint!.contact).toEqual([528, 128]);
  });

  it('a host passing over the target column: the branch still heads right into its step', () => {
    // s -> z runs along y 128 far past c (864,288); t->c joins it
    const st = [step('s', ['z']), step('t', ['c']), step('z', [], { entryCondition: 2 }), step('c', [], { entryCondition: 2 })];
    const pos = { s: [288, 32], t: [288, 288], z: [1440, 32], c: [864, 288] } as Record<string, [number, number]>;
    const wires = setup(st, pos, new Set<string>(), join('t->c', 's->z', 176));
    const w = wires.find((x) => x.id === 't->c')!;
    const br = w.joint!.branch, landing = br[br.length - 1]!;
    expect(w.joint!.split).not.toBeNull();
    expect(square(br)).toBe(true);
    expect(br[br.length - 2]![0]).toBeLessThan(landing[0]);
    expect(br[br.length - 2]![1]).toBe(landing[1]);
    expect(br.every((p) => p[0] <= 864)).toBe(true);
    expect(landing[0] - w.joint!.split![0]).toBeGreaterThanOrEqual(24);
  });

  it('a contact on the branch of a joined host lies on that branch', () => {
    const len = (pts: readonly (readonly [number, number])[]) => pts.reduce((a, p, i) => (i === 0 ? 0 : a + Math.abs(p[0] - pts[i - 1]![0]) + Math.abs(p[1] - pts[i - 1]![1])), 0);
    const first = setup(steps(), at, new Set<string>(), join('t->c', 's->b', 176)).find((x) => x.id === 't->c')!;
    const d = len(first.points) + 16;
    // the host's drawn line is its own line, then its branch
    const wires = setup(steps(), at, new Set<string>(), { ...join('t->c', 's->b', 176), ...join('u->b', 't->c', d) });
    const t = wires.find((x) => x.id === 't->c')!, u = wires.find((x) => x.id === 'u->b')!;
    expect(u.joint).toBeDefined();
    const [cx, cy] = u.joint!.contact;
    const br = t.joint!.branch;
    expect(br.some((a, i) => {
      const b = br[i + 1];
      return b !== undefined && cx >= Math.min(a[0], b[0]) && cx <= Math.max(a[0], b[0]) && cy >= Math.min(a[1], b[1]) && cy <= Math.max(a[1], b[1]);
    })).toBe(true);
  });

  it('a host line too short to hold a contact leaves the wire plain', () => {
    const st = [step('s', ['k']), step('t', ['c']), step('k', [], { entryCondition: 2 }), step('c', [], { entryCondition: 2 })];
    const pos = { s: [288, 32], k: [528, 32], t: [288, 288], c: [864, 288] } as Record<string, [number, number]>;
    const wires = setup(st, pos, new Set<string>(), join('t->c', 's->k', 8));
    expect(wires.find((x) => x.id === 't->c')!.joint).toBeUndefined();
  });
});
