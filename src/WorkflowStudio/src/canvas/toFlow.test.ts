import { describe, expect, it } from 'vitest';
import type { StudioDocument } from '../app/document';
import { AUDIT } from '../model/fixtures';
import type { Graph, Step } from '../model/graph';
import { createTextFitter, MEASURED_FONTS } from './fitText';
import { cacheNodeId, SPHERE_NODE_ID, toFlow } from './toFlow';

const fitter = createTextFitter((text) => text.length * 7);

const step = (id: string, over: Partial<Step> = {}): Step => ({
  id, name: id, version: '1.0.0', description: null, processorId: 'p1', nextStepIds: [], entryCondition: 1, updatedAt: '', audit: AUDIT, ...over,
});

function doc(over: Partial<Graph> = {}, parkedIds: string[] = []): StudioDocument {
  const graph: Graph = {
    workflow: { id: 'wf1', name: 'orders', version: '1.0.0', description: null, cronExpression: null, entryStepIds: ['a'], assignmentIds: [], cacheIds: ['c1'], updatedAt: '', audit: AUDIT },
    steps: new Map([['a', step('a', { nextStepIds: ['b'] })], ['b', step('b', { entryCondition: 2 })]]),
    processors: new Map([['p1', { id: 'p1', name: 'fetcher', version: '2.1.0', description: null, sourceHash: '', instanceId: null, inputSchemaId: 'sIn', outputSchemaId: null, configSchemaId: null, audit: AUDIT }]]),
    schemas: new Map([['sIn', { id: 'sIn', name: 'orders-in', version: '1.0.0', description: null, audit: AUDIT }]]),
    assignments: [{ id: 'x1', stepId: 'a', payload: '{"url":"u","retries":3}' }],
    caches: new Map([['c1', { id: 'c1', name: 'lookups', version: '1.0.0', description: null, root: 'lk', items: '{"k1":"v","k2":"v"}', audit: AUDIT }]]),
    layout: null,
    ...over,
  };
  return {
    graph,
    parkedIds,
    placement: {
      sphere: { cx: 128, cy: 128 },
      steps: new Map([['a', { x: 288, y: 32 }], ['b', { x: 576, y: 32 }], ...parkedIds.map((id) => [id, { x: 288, y: 320 }] as const)]),
      caches: new Map([['c1', { x: 32, y: 288 }]]),
    },
    wires: [
      { id: 'wf->a', source: 'wf', target: 'a', points: [[224, 128], [288, 128]], condition: 1, broken: false },
      { id: 'a->b', source: 'a', target: 'b', points: [[512, 128], [576, 128]], condition: 2, broken: true },
    ],
    problems: [],
  };
}

describe('toFlow', () => {
  it('makes a sphere, one node per step and one per cache, sized and positioned from the placement', () => {
    const { nodes } = toFlow(doc(), fitter);

    const sphere = nodes.find((n) => n.id === SPHERE_NODE_ID)!;
    expect(sphere.position).toEqual({ x: 32, y: 32 });
    expect([sphere.width, sphere.height]).toEqual([192, 192]);

    const a = nodes.find((n) => n.id === 'a')!;
    expect(a.type).toBe('step');
    expect(a.position).toEqual({ x: 288, y: 32 });
    expect([a.width, a.height]).toEqual([224, 160]);

    const cache = nodes.find((n) => n.id === cacheNodeId('c1'))!;
    expect(cache.position).toEqual({ x: 32, y: 288 });
    expect([cache.width, cache.height]).toEqual([160, 160]);
  });

  it('turns wires into cable edges carrying their points, colour and broken flag', () => {
    const { edges } = toFlow(doc(), fitter);
    const ab = edges.find((e) => e.id === 'a->b')!;

    expect([ab.source, ab.target, ab.type]).toEqual(['a', 'b', 'cable']);
    expect(ab.data).toEqual({ points: [[512, 128], [576, 128]], colour: '#FF7A66', broken: true });
    expect(edges.find((e) => e.id === 'wf->a')!.source).toBe(SPHERE_NODE_ID);
  });

  it('ties each cache to the sphere with a tether edge', () => {
    const tether = toFlow(doc(), fitter).edges.find((e) => e.type === 'tether')!;
    expect([tether.source, tether.target]).toEqual([SPHERE_NODE_ID, cacheNodeId('c1')]);
  });

  it('fills the step cap: condition pill, assignment key count, fan-in, landing and departure heights', () => {
    const { nodes } = toFlow(doc(), fitter);
    const a = nodes.find((n) => n.id === 'a')!.data as import('./nodes/StepNode').StepNodeData;
    const b = nodes.find((n) => n.id === 'b')!.data as import('./nodes/StepNode').StepNodeData;

    expect(a.letter).toBe('C');
    expect(b.letter).toBe('F');
    expect(a.assignment).toBe('◆ 2 keys');
    expect(b.assignment).toBeNull();
    expect(a.ins).toEqual([96]);     // the entry wire lands at local y 128 - 32
    expect(a.outs).toEqual([96]);
    expect(b.ins).toEqual([96]);
  });

  it('shows the processor panel: id, name and version, In schema by name, empty slots as null', () => {
    const a = toFlow(doc(), fitter).nodes.find((n) => n.id === 'a')!.data as import('./nodes/StepNode').StepNodeData;

    expect(a.processor.processorId).toBe('p1');
    expect(a.processor.title.text).toBe('fetcher');
    expect(a.processor.version).toBe('2.1.0');
    expect(a.processor.rows.map((r) => [r.label, r.value?.text ?? null])).toEqual([['in', 'orders-in'], ['out', null], ['cfg', null]]);
    expect([a.processor.inputLit, a.processor.outputLit]).toEqual([true, false]);
  });

  it('cuts a schema name to the panel (76 px) and drops the version when name and version pass 92 px (review focus 5)', () => {
    const graph = doc();
    graph.graph.schemas.set('sIn', { ...graph.graph.schemas.get('sIn')!, name: 'a-schema-name-that-is-far-too-long' });
    graph.graph.processors.set('p1', { ...graph.graph.processors.get('p1')!, name: 'a-processor-name' });
    const a = toFlow(graph, fitter).nodes.find((n) => n.id === 'a')!.data as import('./nodes/StepNode').StepNodeData;

    const value = a.processor.rows[0]!.value!;
    expect(value.cut).toBe(true);
    expect(value.full).toBe('a-schema-name-that-is-far-too-long');
    expect(value.text.length * 7).toBeLessThanOrEqual(76);
    expect(a.processor.version).toBeNull();
    expect(a.processor.title.text.length * 7).toBeLessThanOrEqual(92);
  });

  it('labels a parked step PARKED', () => {
    const graph = doc({}, ['p']);
    graph.graph.steps.set('p', step('p'));
    const p = toFlow(graph, fitter).nodes.find((n) => n.id === 'p')!.data as import('./nodes/StepNode').StepNodeData;
    expect(p.parked).toBe(true);
  });

  it('cuts long names to fit and keeps the full text for the tooltip (review focus 5)', () => {
    const long = 'a-step-name-that-goes-on-and-on-and-on-forever';
    const graph = doc({ steps: new Map([['a', step('a', { name: long })], ['b', step('b')]]) });
    const a = toFlow(graph, fitter).nodes.find((n) => n.id === 'a')!.data as import('./nodes/StepNode').StepNodeData;

    expect(a.name.cut).toBe(true);
    expect(a.name.full).toBe(long);
    expect(a.name.text.length * 7).toBeLessThanOrEqual(178);
  });

  it('splits a long workflow name over at most three sphere lines', () => {
    const graph = doc({ workflow: { ...doc().graph.workflow, name: 'orders-intake_eu-west.nightly-backfill-and-reconcile' } });
    const sphere = toFlow(graph, fitter).nodes.find((n) => n.id === SPHERE_NODE_ID)!.data as import('./nodes/WorkflowNode').WorkflowNodeData;

    expect(sphere.lines.length).toBeGreaterThan(1);
    expect(sphere.lines.length).toBeLessThanOrEqual(3);
    expect(sphere.full).toBe('orders-intake_eu-west.nightly-backfill-and-reconcile');
  });

  it('measures only with the fonts the page loads before it makes the fitter, and with all of them', () => {
    const used = new Set<string>();
    const recording = createTextFitter((text, font) => { used.add(font); return text.length * 7; });

    toFlow(doc({}, ['p']), recording);

    expect([...used].sort()).toEqual([...MEASURED_FONTS].sort());
  });
});
