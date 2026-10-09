import { describe, expect, it } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { plainCircuit, type Circuit, type CircuitWire, type End } from '../circuit/circuit';
import { SPHERE_R, STEP_W } from './geometry';
import { contactOn, endPointOf, ripUpBetter, routeCircuit, routeWires } from './circuitRoute';
import { hitsOf } from './router';
import { overlapsOf, sharesNet } from './overlaps';
import { netsOf } from '../circuit/families';
import { shapeFromPoints } from './shape';
import { blockBoxes, SPHERE_BOX_ID, stepBoxId } from './wires';

const at = (step: string, y: number | null = null): End => ({ on: 'step', step, y });
const w = (tail: End, head: End): CircuitWire => ({ tail, head });

const four = () => loadedDocument(graphDto({
  workflow: workflowDto({ entryStepIds: ['s1', 's3'] }),
  steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2'), stepDto('s3', { nextStepIds: ['s4'] }), stepDto('s4', { entryCondition: 2 })],
}));
const ctxOf = (doc: Awaited<ReturnType<typeof four>>) => ({ placement: doc.placement, steps: doc.graph.steps });
const byId = (routes: ReturnType<typeof routeCircuit>) => new Map(routes.map((r) => [r.id, r]));

describe('routeCircuit (plan 9 §5)', () => {
  it('draws the workflow\'s own wires exactly as plan 2 did: the same points, colours and ends', async () => {
    const doc = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2', 's3'] }), stepDto('s2', { nextStepIds: ['s3'] }), stepDto('s3', { entryCondition: 3 })],
    }));
    const routes = routeWires({ entryStepIds: ['s1'], steps: doc.graph.steps }, doc.placement);
    expect(routes.map((r) => [r.id, r.points, r.condition])).toEqual(doc.wires.map((x) => [x.id, x.points, x.condition]));
    expect(routes.every((r) => r.solid && r.tailOn === 'terminal' && r.headOn === 'terminal' && !r.short)).toBe(true);
    expect(routes.find((r) => r.id === 'wf->s1')).toMatchObject({ source: 'wf', target: 's1' });
  });

  it('a tail on the hub at an angle starts on its ring there and leaves the hub\'s square (rule 1)', async () => {
    const doc = await four();
    const { cx, cy } = doc.placement.sphere;
    const routes = byId(routeCircuit({ top: w({ on: 'hub', angle: 270 }, at('s1')), left: w({ on: 'hub', angle: 180 }, at('s3')) }, ctxOf(doc)));
    const top = routes.get('top')!.points, left = routes.get('left')!.points;
    expect(top[0]).toEqual([cx, cy - SPHERE_R]);
    expect(left[0]).toEqual([cx - SPHERE_R, cy]);
    expect(left[1]).toEqual([cx - SPHERE_R, cy + SPHERE_R + 16]);
    // after the ring point, nothing inside the hub
    for (const p of [...top.slice(1), ...left.slice(1)]) expect(Math.hypot(p[0] - cx, p[1] - cy)).toBeGreaterThanOrEqual(SPHERE_R - 0.5);
    expect(routes.get('top')).toMatchObject({ source: 'wf', tailOn: 'terminal' });
  });

  it('a tail and a head slid along their sides start and end where they were put, anywhere short of the corners (rule 5, ruling)', async () => {
    const doc = await four();
    const s1 = doc.placement.steps.get('s1')!, s2 = doc.placement.steps.get('s2')!;
    const r = routeCircuit({ x: w(at('s1', 24), at('s2', 144)) }, ctxOf(doc))[0]!;
    expect(r.points[0]).toEqual([s1.x + STEP_W, s1.y + 24]);
    expect(r.points.at(-1)).toEqual([s2.x, s2.y + 144]);
    const clamped = routeCircuit({ x: w(at('s1', 8), at('s2', 152)) }, ctxOf(doc))[0]!;
    expect(clamped.points[0]).toEqual([s1.x + STEP_W, s1.y + 16]);
    expect(clamped.points.at(-1)).toEqual([s2.x, s2.y + 144]);
  });

  it('open ends are drawn where they are: grey (undecided) and dashed, on no terminal', async () => {
    const doc = await four();
    const r = routeCircuit({ x: w({ on: 'open', x: 40, y: 600 }, { on: 'open', x: 400, y: 640 }) }, ctxOf(doc))[0]!;
    expect([r.points[0], r.points.at(-1)]).toEqual([[40, 600], [400, 640]]);
    expect(r).toMatchObject({ source: null, target: null, tailOn: 'open', headOn: 'open', condition: null, solid: false, short: false, free: true });
  });

  it('a wire with no end on a step or the hub is direction-less (rule D), open or joined on a line; one end on a step or the hub gives it one', async () => {
    const doc = await four();
    const routes = byId(routeCircuit({
      's1->s2': w(at('s1'), at('s2')),
      j: w({ on: 'wire', host: 's1->s2', at: 40 }, { on: 'open', x: 400, y: 640 }),
      t: w(at('s3'), { on: 'open', x: 400, y: 700 }),
      h: w({ on: 'open', x: 40, y: 700 }, at('s4')),
      hub: w({ on: 'hub', angle: null }, { on: 'open', x: 40, y: 800 }),
    }, ctxOf(doc)));
    expect([...routes].map(([id, r]) => [id, r.free])).toEqual([['s1->s2', false], ['j', true], ['t', false], ['h', false], ['hub', false]]);
  });

  it('a head junction ends on its host\'s line at its point; a tail junction leaves from it; hosts are routed first whatever the order', async () => {
    const doc = await four();
    const c: Circuit = {
      x: w(at('s3'), { on: 'wire', host: 's1->s2', at: 40 }),
      y: w({ on: 'wire', host: 's1->s2', at: 64 }, { on: 'open', x: 900, y: 700 }),
      ...plainCircuit(['s1', 's3'], doc.graph.steps, (id) => doc.placement.steps.has(id)),
    };
    const routes = byId(routeCircuit(c, ctxOf(doc)));
    const host = routes.get('s1->s2')!.points;
    expect(routes.get('x')!.points.at(-1)).toEqual(contactOn(host, 40).p);
    expect(routes.get('y')!.points[0]).toEqual(contactOn(host, 64).p);
    expect(routes.get('x')).toMatchObject({ headOn: 'junction', target: null, condition: 1, solid: true });
    // y is joined only on a line and open: direction-less, so grey whatever it is joined on (the user's rule 1, 2026-10-09)
    expect(routes.get('y')).toMatchObject({ tailOn: 'junction', source: null, condition: null, solid: false, free: true });
  });

  it('a short circuit: every wire of the net is marked, each in the family its own head reaches', async () => {
    const doc = await four();
    const c: Circuit = {
      ...plainCircuit(['s1', 's3'], doc.graph.steps, (id) => doc.placement.steps.has(id)),
      x: w({ on: 'wire', host: 's1->s2', at: 40 }, at('s4')),
    };
    const routes = byId(routeCircuit(c, ctxOf(doc)));
    expect(routes.get('s1->s2')).toMatchObject({ short: true, condition: 1 });
    expect(routes.get('x')).toMatchObject({ short: true, condition: 2 });
    expect(routes.get('s3->s4')).toMatchObject({ short: false, condition: 2 });
  });

  it('an end on a host that is gone, or on a step off the canvas, is drawn open beside its other end', async () => {
    const doc = await four();
    const routes = byId(routeCircuit({ x: w(at('s1'), { on: 'wire', host: 'gone', at: 8 }), y: w(at('nope'), { on: 'open', x: 500, y: 300 }) }, ctxOf(doc)));
    const x = routes.get('x')!;
    expect(x.headOn).toBe('open');
    expect(x.points.at(-1)).toEqual([x.points[0]![0] + 96, x.points[0]![1]]);
    expect(routes.get('y')).toMatchObject({ tailOn: 'open', source: null });
    expect(routes.get('y')!.points[0]).toEqual([404, 300]);
  });
});

describe('endPointOf', () => {
  it('is a drawn wire\'s first point for its tail, its last for its head; null for a wire not drawn', async () => {
    const d = await loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: ['s1'] }), steps: [stepDto('s1')] }));
    const routes = routeCircuit(plainCircuit(['s1'], d.graph.steps, () => true), { placement: d.placement, steps: d.graph.steps });
    const pts = routes[0]!.points;
    const point = endPointOf(routes);
    expect(point('wf->s1', 'tail')).toEqual({ x: pts[0]![0], y: pts[0]![1] });
    expect(point('wf->s1', 'head')).toEqual({ x: pts[pts.length - 1]![0], y: pts[pts.length - 1]![1] });
    expect(point('nope', 'tail')).toBeNull();
  });
});

describe('a hub tail with a shape of its own (review 2026-10-09)', () => {
  it('starts at its ring point snapped to the grid, after a short lead from the ring; heading right from the left half it still leaves the hub\'s square', async () => {
    const doc = await four();
    const { cx, cy } = doc.placement.sphere;
    const left = routeCircuit({ x: { tail: { on: 'hub', angle: 165 }, head: { on: 'open', x: -400, y: 300 }, bends: { xs: [-200], ys: [] } } }, ctxOf(doc))[0]!;
    const r = (165 * Math.PI) / 180;
    const ring: [number, number] = [Math.round((cx + SPHERE_R * Math.cos(r)) * 10) / 10, Math.round((cy + SPHERE_R * Math.sin(r)) * 10) / 10];
    const snapped: [number, number] = [Math.round(ring[0] / 8) * 8, Math.round(ring[1] / 8) * 8];
    expect(left.points).toEqual([ring, [ring[0], snapped[1]], [-200, snapped[1]], [-200, 300], [-400, 300]]);
    expect(left.core.ends).toMatchObject({ sx: snapped[0], sy: snapped[1] });
    // a left-half tail whose shape heads right: as the router draws it, out of the hub's square
    const right = routeCircuit({ x: { tail: { on: 'hub', angle: 165 }, head: { on: 'open', x: 900, y: 300 }, bends: { xs: [600], ys: [] } } }, ctxOf(doc))[0]!;
    expect(right.points[1]![0]).toBe(right.points[0]![0]);
    expect(right.points[1]![1]).toBeGreaterThan(cy + SPHERE_R);
  });
});

describe('direction-less wires and overlaps (the user\'s rules 1 and 2, 2026-10-09)', () => {
  const open = (x: number, y: number): End => ({ on: 'open', x, y });
  const shaped = (tail: End, head: End, xs: number[], ys: number[] = []): CircuitWire => ({ tail, head, bends: { xs, ys } });

  it('a direction-less wire is grey and dashed whatever it is joined on; a wire that would take its colour only through it takes none', async () => {
    const doc = await four();
    const routes = byId(routeCircuit({
      ...plainCircuit(['s1', 's3'], doc.graph.steps, (id) => doc.placement.steps.has(id)),
      f: w({ on: 'wire', host: 's1->s2', at: 40 }, open(700, 640)),
      y: w(at('s3', 64), { on: 'wire', host: 'f', at: 40 }),
    }, ctxOf(doc)));
    expect(routes.get('f')).toMatchObject({ free: true, condition: null, solid: false, short: false });
    expect(routes.get('y')).toMatchObject({ free: false, condition: null, solid: false });
    // the host keeps its own colour
    expect(routes.get('s1->s2')).toMatchObject({ condition: 1, solid: true, short: false });
  });

  it('a both-open wire laid exactly on a live wire shaped by hand: both are short circuits, the shared stretch marked on each, the other named', async () => {
    const doc = await four();
    const c: Circuit = {
      ...plainCircuit(['s1', 's3'], doc.graph.steps, (id) => doc.placement.steps.has(id)),
      // s1 -> s2 shaped by hand where it is ([512,128] -> [576,128]; automatic, it would move a track over)
      's1->s2': shaped(at('s1'), at('s2'), [512]),
      // exactly over it
      f: shaped(open(512, 128), open(576, 128), [512]),
    };
    const routes = byId(routeCircuit(c, ctxOf(doc)));
    expect(routes.get('f')).toMatchObject({ short: true, overlaps: [[[512, 128], [576, 128]]], shortWith: ['s1->s2'] });
    expect(routes.get('s1->s2')).toMatchObject({ short: true, overlaps: [[[512, 128], [576, 128]]], shortWith: ['f'], condition: 1 });
    expect(routes.get('s3->s4')!.short).toBe(false);
    expect('overlaps' in routes.get('s3->s4')!).toBe(false);
  });

  it('crossing a live wire is no short circuit', async () => {
    const doc = await four();
    const routes = byId(routeCircuit({
      ...plainCircuit(['s1', 's3'], doc.graph.steps, (id) => doc.placement.steps.has(id)),
      f: shaped(open(520, 80), open(560, 200), [544]),
    }, ctxOf(doc)));
    expect(routes.get('f')!.short).toBe(false);
    expect(routes.get('s1->s2')!.short).toBe(false);
  });

  it('the router never lays an automatic wire on a wire of another net: it takes a free track beside a shape drawn by hand', async () => {
    const doc = await four();
    // the hub's automatic wire into s1 runs up x = 248 from 232 to 128; a hand-drawn wire lies on that track
    const plain = byId(routeCircuit(plainCircuit(['s1', 's3'], doc.graph.steps, (id) => doc.placement.steps.has(id)), ctxOf(doc)));
    expect(plain.get('wf->s1')!.points).toEqual([[224, 232], [248, 232], [248, 128], [288, 128]]);
    const m = shaped(open(232, 150), open(264, 200), [248]);
    // listed last, it is still drawn first: the automatic wire goes round it
    const routes = byId(routeCircuit({ ...plainCircuit(['s1', 's3'], doc.graph.steps, (id) => doc.placement.steps.has(id)), m }, ctxOf(doc)));
    const r = routes.get('wf->s1')!;
    expect([r.points[0], r.points.at(-1)]).toEqual([[224, 232], [288, 128]]);
    expect(r.points).not.toEqual(plain.get('wf->s1')!.points);
    expect([r.short, routes.get('m')!.short]).toEqual([false, false]);
    expect(routes.get('m')!.points).toEqual([[232, 150], [248, 150], [248, 200], [264, 200]]);
  });

  it('only a shape drawn by hand lies on another net\'s wire: then both are short circuits', async () => {
    const doc = await four();
    const c: Circuit = {
      ...plainCircuit(['s1', 's3'], doc.graph.steps, (id) => doc.placement.steps.has(id)),
      'wf->s1': shaped({ on: 'hub', angle: null }, at('s1'), [248]),
      m: shaped(open(232, 150), open(264, 200), [248]),
    };
    const routes = byId(routeCircuit(c, ctxOf(doc)));
    expect(routes.get('wf->s1')).toMatchObject({ short: true, shortWith: ['m'] });
    expect(routes.get('m')).toMatchObject({ short: true, overlaps: [[[248, 150], [248, 200]]] });
  });
});

describe("the router keeps off other nets' wires at a junction too (the user's rule 2, 2026-10-09)", () => {
  it("a head joined at a corner of its host comes in from the line's other side when its usual side lies on another net's wire", async () => {
    // a -> b runs right from a, then down to b; a -> d (Failed) runs right just above it
    const doc = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['a'] }),
      steps: [stepDto('c'), stepDto('d', { entryCondition: 2 }), stepDto('b', { nextStepIds: ['c'] }), stepDto('a', { nextStepIds: ['b', 'd'] })],
    }));
    const ctx = { placement: doc.placement, steps: doc.graph.steps };
    const plain = byId(routeCircuit(plainCircuit(['a'], doc.graph.steps, () => true), ctx));
    expect(plain.get('a->b')!.points).toEqual([[512, 168], [552, 168], [552, 352], [576, 352]]);
    expect(plain.get('a->d')!.points).toEqual([[512, 152], [576, 152]]);
    // a wire from d poured into a -> b at its corner (40 along): one jog above the corner is a -> d's line
    const c: Circuit = { ...plainCircuit(['a'], doc.graph.steps, () => true), n: w(at('d'), { on: 'wire', host: 'a->b', at: 40 }) };
    const routes = byId(routeCircuit(c, ctx));
    const n = routes.get('n')!;
    expect(n.points.at(-1)).toEqual([552, 168]);
    expect(n.points.at(-2)).toEqual([552, 184]);
    expect([...routes.values()].some((r) => r.short)).toBe(false);
    // shaped by hand from what is drawn (a run square's first drag): it stays exactly there, the junction reached from
    // the same side (review 2026-10-09)
    const shaped = byId(routeCircuit({ ...c, n: { ...c.n!, bends: shapeFromPoints(n.core.points) } }, ctx)).get('n')!;
    expect(shaped.points).toEqual(n.points);
    expect(shaped.short).toBe(false);
  });

  it("an automatic wire whose usual track around a block lies on another net's wire takes another track around it, never one through it", async () => {
    // p -> r goes round q (below it, along y 216); both-open wires shaped by hand lie on every level it could go round q
    // by (above q at 8, below it at 216, below every block at 248): only a way through q is free of them
    const doc = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['p'] }),
      steps: [stepDto('p', { nextStepIds: ['q', 'r'] }), stepDto('q', { nextStepIds: ['r'] }), stepDto('r')],
    }));
    const ctx = { placement: doc.placement, steps: doc.graph.steps };
    const plain = plainCircuit(['p'], doc.graph.steps, () => true);
    expect(byId(routeCircuit(plain, ctx)).get('p->r')!.points).toEqual([[512, 168], [544, 168], [544, 216], [840, 216], [840, 168], [864, 168]]);
    const lying = (y: number): CircuitWire => ({ tail: { on: 'open', x: 600, y }, head: { on: 'open', x: 780, y }, bends: { xs: [600], ys: [] } });
    const c: Circuit = { ...plain, f8: lying(8), f216: lying(216), f248: lying(248) };
    const r = byId(routeCircuit(c, ctx)).get('p->r')!;
    expect(r.short).toBe(false);
    expect(hitsOf(r.core.points, stepBoxId('p'), stepBoxId('r'), blockBoxes(doc.placement))).toBe(0);
    expect(r.points).not.toEqual([[512, 168], [864, 168]]);
  });
});

describe('the router after the review of 2026-10-09 (the coordinator\'s ruling)', () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const randomDoc = () => {
    const n = 3 + Math.floor(rnd() * 14);
    const ids = Array.from({ length: n }, (_, i) => `s${i + 1}`);
    const steps = ids.map((id, i) => {
      const next: string[] = [];
      for (let j = 0; j < n; j++) if (j !== i && rnd() < (j > i ? 0.3 : 0.05)) next.push(ids[j]!);
      return stepDto(id, { nextStepIds: next, entryCondition: (1 + Math.floor(rnd() * 3)) as 1 | 2 | 3 });
    });
    return loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: ids.filter((_, i) => i === 0 || rnd() < 0.15) }), steps }));
  };
  const reversed = (c: Circuit): Circuit => Object.fromEntries(Object.entries(c).reverse());
  const drawing = (rs: ReturnType<typeof routeCircuit>) => new Map(rs.map((r) => [r.id, JSON.stringify([r.points, r.short, [...r.shortWith ?? []].sort()])]));

  it('300 workflows nobody has touched open with no short circuit, no wire through its own block, and route the same in any order', async () => {
    for (let trial = 0; trial < 300; trial++) {
      const doc = await randomDoc();
      const ctx = { placement: doc.placement, steps: doc.graph.steps };
      const c = plainCircuit(doc.graph.workflow.entryStepIds, doc.graph.steps, (id) => doc.placement.steps.has(id));
      const routes = routeCircuit(c, ctx);
      expect(routes.filter((r) => r.short).map((r) => r.id), `trial ${trial}`).toEqual([]);
      const boxes = blockBoxes(doc.placement);
      for (const r of routes) {
        const own = boxes.filter((b) => b.id === (r.source === 'wf' ? SPHERE_BOX_ID : stepBoxId(r.source!)) || b.id === stepBoxId(r.target!));
        expect(hitsOf(r.core.points, r.source === 'wf' ? SPHERE_BOX_ID : stepBoxId(r.source!), stepBoxId(r.target!), own), `trial ${trial} ${r.id}`).toBe(0);
      }
      expect(drawing(routeCircuit(reversed(c), ctx)), `trial ${trial}`).toEqual(drawing(routes));
    }
  }, 120_000);

  it('with wires shaped by hand and a both-open wire laid on one, the drawing and its short circuits do not depend on the order', async () => {
    for (let trial = 0; trial < 60; trial++) {
      const doc = await randomDoc();
      const ctx = { placement: doc.placement, steps: doc.graph.steps };
      let c = plainCircuit(doc.graph.workflow.entryStepIds, doc.graph.steps, (id) => doc.placement.steps.has(id));
      for (const r of doc.wires) if (rnd() < 0.3) { const s = shapeFromPoints(r.core.points); if (s.xs.length > 0) c = { ...c, [r.id]: { ...c[r.id]!, bends: s } }; }
      const on = doc.wires[Math.floor(rnd() * doc.wires.length)];
      if (on) c = { ...c, 'w:f': { tail: { on: 'open', x: on.points[0]![0], y: on.points[0]![1] }, head: { on: 'open', x: on.points.at(-1)![0], y: on.points.at(-1)![1] }, bends: shapeFromPoints(on.points).xs.length > 0 ? shapeFromPoints(on.points) : { xs: [on.points[0]![0]], ys: [] } } };
      expect(drawing(routeCircuit(reversed(c), ctx)), `trial ${trial}`).toEqual(drawing(routeCircuit(c, ctx)));
    }
  }, 120_000);

  it('an automatic wire with no free track moves its own heights: a straight wire under a shape drawn by hand goes one track over', async () => {
    const doc = await four();
    const ctx = ctxOf(doc);
    expect(byId(routeCircuit(plainCircuit(['s1', 's3'], doc.graph.steps, () => true), ctx)).get('s1->s2')!.points).toEqual([[512, 128], [576, 128]]);
    // a both-open wire shaped by hand lies along the middle of s1 -> s2's only run
    const c: Circuit = { ...plainCircuit(['s1', 's3'], doc.graph.steps, () => true), f: { tail: { on: 'open', x: 520, y: 128 }, head: { on: 'open', x: 568, y: 128 }, bends: { xs: [520], ys: [] } } };
    const r = byId(routeCircuit(c, ctx)).get('s1->s2')!;
    expect(r.short).toBe(false);
    expect([r.points[0]![0], r.points.at(-1)![0]]).toEqual([512, 576]);
    expect(r.points.some((p) => p[1] !== 128)).toBe(true);
  });
});

describe('the router after the re-review of 2026-10-09', () => {
  it('a shape drawn by hand joined on an automatic host does not let that host be drawn before the other shapes: no short circuit in either order', async () => {
    const doc = await four();
    const ctx = ctxOf(doc);
    const plain = plainCircuit(['s1', 's3'], doc.graph.steps, (id) => doc.placement.steps.has(id));
    // m lies on the hub wire's usual upright track; child is joined on that hub wire
    const m: CircuitWire = { tail: { on: 'open', x: 232, y: 150 }, head: { on: 'open', x: 264, y: 200 }, bends: { xs: [248], ys: [] } };
    const child: CircuitWire = { tail: { on: 'wire', host: 'wf->s1', at: 8 }, head: { on: 'open', x: 400, y: 400 }, bends: { xs: [320], ys: [] } };
    const one = routeCircuit({ m, child, ...plain } as Circuit, ctx), two = routeCircuit({ child, m, ...plain } as Circuit, ctx);
    for (const rs of [one, two]) expect(rs.filter((r) => r.short).map((r) => r.id)).toEqual([]);
    const drawing = (rs: typeof one) => new Map(rs.map((r) => [r.id, JSON.stringify(r.points)]));
    expect(drawing(two)).toEqual(drawing(one));
  });

  for (const [seed0, span, most] of [[4242, 13, 0], [12345, 14, 2]] as const) {
    it(`300 untouched workflows (seed ${seed0}): automatic wires of different nets lie on each other in ${most === 0 ? 'none' : `at most ${most} (one crowded graph, drawn twice)`}`, async () => {
      let seed: number = seed0;
      const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      let left = 0;
      for (let trial = 0; trial < 300; trial++) {
        const n = 3 + Math.floor(rnd() * span);
        const ids = Array.from({ length: n }, (_, i) => `s${i + 1}`);
        const steps = ids.map((id, i) => {
          const next: string[] = [];
          for (let j = 0; j < n; j++) if (j !== i && rnd() < (j > i ? 0.3 : 0.05)) next.push(ids[j]!);
          return stepDto(id, { nextStepIds: next, entryCondition: (1 + Math.floor(rnd() * 3)) as 1 | 2 | 3 });
        });
        const doc = await loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: ids.filter((_, i) => i === 0 || rnd() < 0.15) }), steps }));
        const c = plainCircuit(doc.graph.workflow.entryStepIds, doc.graph.steps, (id) => doc.placement.steps.has(id));
        const same = sharesNet(c, netsOf(c, (id) => doc.graph.steps.get(id)?.entryCondition));
        if (overlapsOf(doc.wires).some((o) => !same(o.a, o.b))) left++;
      }
      expect(left).toBeLessThanOrEqual(most);
    }, 120_000);
  }
});

describe('ripUpBetter: when a wire drawn again keeps its new track (final check 2026-10-09)', () => {
  const s = (blocks: number, shorts: number, others: number, length: number) => ({ blocks, shorts, others, length });
  it('never with more blocks crossed, whatever it gains', () => {
    expect(ripUpBetter(s(1, 0, 0, 100), s(0, 3, 3, 900))).toBe(false);
    expect(ripUpBetter(s(0, 3, 3, 900), s(1, 0, 0, 100))).toBe(true);
  });
  it('never trading overlaps with automatic wires for one with a hand-shaped wire (a short circuit)', () => {
    expect(ripUpBetter(s(0, 1, 0, 100), s(0, 0, 3, 900))).toBe(false);
    expect(ripUpBetter(s(0, 0, 3, 900), s(0, 1, 0, 100))).toBe(true);
  });
  it('then fewer other overlaps, then shorter; the same is no better', () => {
    expect(ripUpBetter(s(0, 0, 1, 900), s(0, 0, 2, 100))).toBe(true);
    expect(ripUpBetter(s(0, 0, 1, 100), s(0, 0, 1, 200))).toBe(true);
    expect(ripUpBetter(s(0, 0, 1, 100), s(0, 0, 1, 100))).toBe(false);
  });
});
