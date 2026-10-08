import { describe, expect, it } from 'vitest';
import type { StudioDocument } from '../app/document';
import { AUDIT } from '../model/fixtures';
import type { Graph, Step } from '../model/graph';
import { createTextFitter, FONT, MEASURED_FONTS } from './fitText';
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
    assignments: [{ id: 'x1', stepId: 'a', payload: '{"url":"u","retries":3}', updatedAt: '' }],
    caches: new Map([['c1', { id: 'c1', name: 'lookups', version: '1.0.0', description: null, root: 'lk', items: '{"k1":"v","k2":"v"}', audit: AUDIT }]]),
    layout: null,
    design: null,
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
    loose: [],
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
    expect(ab.data).toEqual({ points: [[512, 128], [576, 128]], colour: '#FF7A66', broken: true, delay: -0.41 });
    expect(edges.find((e) => e.id === 'wf->a')!.data).toMatchObject({ delay: 0 });
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

  it('measures the processor version in the mono face it is drawn in, not the title face', () => {
    // a fitter whose 9 px mono is wider than the 11 px sans: 5 px a character in sans, 9 in mono
    const fonts = createTextFitter((text, font) => text.length * (font === FONT.processorRow ? 9 : 5));
    const graph = doc();
    graph.graph.processors.set('p1', { ...graph.graph.processors.get('p1')!, name: 'fetcher-proc' }); // 60 sans
    const b = toFlow(graph, fonts).nodes.find((n) => n.id === 'a')!.data as import('./nodes/StepNode').StepNodeData;
    // old measure: 'fetcher-proc 2.1.0' in sans = 90 <= 92, fits; drawn: 60 + 54 = 114 > 92, it does not
    expect(b.processor.version).toBeNull();
    expect(b.processor.title.text).toBe('fetcher-proc');

    graph.graph.processors.set('p1', { ...graph.graph.processors.get('p1')!, name: 'fetch' }); // 25 + 54 = 79
    const c = toFlow(graph, fonts).nodes.find((n) => n.id === 'a')!.data as import('./nodes/StepNode').StepNodeData;
    expect(c.processor.version).toBe('2.1.0');
  });

  it('cuts a long cache version to the frame, counting its .2em letter spacing, and keeps it whole in the tooltip (review focus 5)', () => {
    const version = '1.0.0-prerelease.build.20261006.sha.abcdef';
    const graph = doc({ caches: new Map([['c1', { id: 'c1', name: 'lookups', version, description: null, root: 'lk', items: '{}', audit: AUDIT }]]) });
    const c = toFlow(graph, fitter).nodes.find((n) => n.id === cacheNodeId('c1'))!.data as import('./nodes/CacheNode').CacheNodeData;
    expect(c.versionLine.cut).toBe(true);
    expect(c.versionLine.full).toBe(`CACHE · v${version}`);
    expect(c.versionLine.text.endsWith('…')).toBe(true);
    // 7 px a character plus .2em of 8 px (1.6 px) spacing on each: at most 132 (the name's room)
    expect(c.versionLine.text.length * (7 + 1.6)).toBeLessThanOrEqual(132);
    expect(c.tooltip).toContain(version);

    const short = toFlow(doc(), fitter).nodes.find((n) => n.id === cacheNodeId('c1'))!.data as import('./nodes/CacheNode').CacheNodeData;
    expect(short.versionLine).toEqual({ text: 'CACHE · v1.0.0', full: 'CACHE · v1.0.0', cut: false });
  });

  it('draws an unwired step like every other step (plan 8: no parked look)', () => {
    const { nodes } = toFlow(doc({ steps: new Map([['a', step('a')], ['b', step('b')], ['p', step('p')]]) }, ['p']), fitter);
    const p = nodes.find((n) => n.id === 'p')!;
    expect('parked' in (p.data as object)).toBe(false);
    expect((p.data as { tip: string }).tip).not.toContain('parked');
  });

  it('draws each loose wire as a loose cable edge on its source node; the hub can hold one (plan 8 §5)', () => {
    const d: StudioDocument = { ...doc(), loose: [{ id: 'l1', source: 'a', points: [[512, 128], [704, 400]] }, { id: 'l2', source: 'wf', points: [[224, 128], [304, 304]] }] };
    const { nodes, edges } = toFlow(d, fitter);
    const l1 = edges.find((e) => e.id === 'loose:l1')!;
    expect([l1.source, l1.target, l1.targetHandle]).toEqual(['a', 'a', 'in']);
    expect(l1.data).toMatchObject({ loose: true, points: [[512, 128], [704, 400]] });
    const l2 = edges.find((e) => e.id === 'loose:l2')!;
    expect([l2.source, l2.target, l2.targetHandle]).toEqual(['wf', 'wf', 'loose']);
    expect(nodes.find((n) => n.id === 'wf')!.handles!.some((h) => h.id === 'loose' && h.type === 'target')).toBe(true);
  });

  it('cuts long names to fit and keeps the full text for the tooltip (review focus 5)', () => {
    const long = 'a-step-name-that-goes-on-and-on-and-on-forever';
    const graph = doc({ steps: new Map([['a', step('a', { name: long })], ['b', step('b')]]) });
    const a = toFlow(graph, fitter).nodes.find((n) => n.id === 'a')!.data as import('./nodes/StepNode').StepNodeData;

    expect(a.name.cut).toBe(true);
    expect(a.name.full).toBe(long);
    expect(a.name.text.length * 7).toBeLessThanOrEqual(178);
  });

  it('wraps a cache name at its separators onto at most two lines, and plates the root (review focus 5)', () => {
    const cacheOf = (name: string, root: string) => {
      const graph = doc({ caches: new Map([['c1', { id: 'c1', name, version: '1.0.0', description: null, root, items: '{}', audit: AUDIT }]]) });
      return toFlow(graph, fitter).nodes.find((n) => n.id === cacheNodeId('c1'))!.data as import('./nodes/CacheNode').CacheNodeData;
    };

    const short = cacheOf('lookups', 'lk');
    expect(short.lines).toEqual(['lookups']);
    expect(short.plateWidth).toBe(2 * 7 + 22);
    expect(short.tooltip).toBe('lookups 1.0.0\nroot lk');

    expect(cacheOf('chain-artist-whitelist', 'chain-artists').lines).toEqual(['chain-artist-', 'whitelist']);

    const long = cacheOf('one-two-three-four-five-six-seven-eight-nine', 'r'.repeat(40));
    expect(long.lines).toHaveLength(2);
    for (const line of long.lines) expect(line.length * 7).toBeLessThanOrEqual(132);
    expect(long.root.cut).toBe(true);
    expect(long.plateWidth).toBe(128);
  });

  it('gives the hub its unique name as a tooltip and the cron for its pill', () => {
    // measured as IBM Plex Mono draws it: .6em a character, 6 px at the pill's 10 px (the 7 px fake leaves
    // 90 beside the 18-character longest state, too little for the 15 characters of '⏱ not scheduled')
    const mono = createTextFitter((text) => text.length * 6);
    const hub = toFlow(doc(), mono).nodes.find((n) => n.id === SPHERE_NODE_ID)!.data as import('./nodes/WorkflowNode').WorkflowNodeData;
    expect(hub.tip).toBe('orders_1.0.0-wf1');
    expect(hub.cron).toEqual({ text: '⏱ not scheduled', full: '⏱ not scheduled', cut: false });
  });

  it('cuts a long cron to the pill and keeps it whole for the tooltip (review focus 5)', () => {
    const long = '0 0/5 8-18 ? * MON,TUE,WED,THU,FRI 2026-2030';
    const graph = doc({ workflow: { ...doc().graph.workflow, cronExpression: long } });
    const hub = toFlow(graph, fitter).nodes.find((n) => n.id === SPHERE_NODE_ID)!.data as import('./nodes/WorkflowNode').WorkflowNodeData;
    expect(hub.cron.cut).toBe(true);
    expect(hub.cron.full).toBe(`⏱ ${long}`);
    // the pill is 240 wide, its text starts 12 in and the longest state ('  ? status unknown') needs 18 characters
    expect(hub.cron.text.length * 7).toBeLessThanOrEqual(240 - 24 - 18 * 7);
  });

  it('measures only with the fonts the page loads before it makes the fitter, and with all of them', () => {
    const used = new Set<string>();
    const recording = createTextFitter((text, font) => { used.add(font); return text.length * 7; });

    toFlow(doc({}, ['p']), recording);

    expect([...used].sort()).toEqual([...MEASURED_FONTS].sort());
  });

  it('gives each step a tooltip: unique name, entry condition and assignment', () => {
    const graph = doc({}, ['p']);
    graph.graph.steps.set('p', step('p', { entryCondition: 4 }));
    const nodes = toFlow(graph, fitter).nodes;
    const tip = (id: string) => (nodes.find((n) => n.id === id)!.data as import('./nodes/StepNode').StepNodeData).tip;

    expect(tip('a')).toBe('a_1.0.0-a\nentry C · Completed\nassignment ◆ 2 keys');
    expect(tip('b')).toBe('b_1.0.0-b\nentry F · Failed\nno assignment');
    expect(tip('p')).toBe('p_1.0.0-p\nentry A · Always\nno assignment');
  });
});
