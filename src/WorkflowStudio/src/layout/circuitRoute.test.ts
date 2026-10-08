import { describe, expect, it } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { plainCircuit, type Circuit, type CircuitWire, type End } from '../circuit/circuit';
import { SPHERE_R, STEP_W } from './geometry';
import { contactOn, endPointOf, routeCircuit, routeWires } from './circuitRoute';

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
    const routes = routeWires({ entryStepIds: ['s1'], steps: doc.graph.steps, brokenEdges: new Set() }, doc.placement);
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
    expect(r).toMatchObject({ source: null, target: null, tailOn: 'open', headOn: 'open', condition: null, solid: false, short: false });
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
    expect(routes.get('y')).toMatchObject({ tailOn: 'junction', source: null, condition: 1, solid: false });
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
