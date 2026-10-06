import { describe, expect, it, vi } from 'vitest';
import type { ApiResult, StudioApi } from '../api/client';
import { graphDto, processorDto, stepDto } from '../api/fixtures';
import { loadDocument } from './loadDocument';

const ok = <T,>(value: T): ApiResult<T> => ({ ok: true, value });
const notFound = { ok: false, error: { kind: 'notFound', status: 404 } } as const;

function fakeApi(over: Partial<StudioApi> = {}): StudioApi {
  return {
    listWorkflows: vi.fn(),
    getGraph: vi.fn().mockResolvedValue(ok(graphDto())),
    getStep: vi.fn().mockResolvedValue(notFound),
    getProcessor: vi.fn().mockResolvedValue(notFound),
    validate: vi.fn().mockResolvedValue(ok({ valid: true, problems: [] })),
    ...over,
  };
}

describe('loadDocument', () => {
  it('loads, places and routes a workflow', async () => {
    const result = await loadDocument(fakeApi(), 'wf1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.value.placement.steps.keys()]).toEqual(['s1']);
    expect(result.value.wires.map((w) => w.id)).toEqual(['wf->s1']);
    expect(result.value.problems).toEqual([]);
  });

  it('marks the wire a schemaEdge problem names as broken, and keeps the problem', async () => {
    const problem = { gate: 'schemaEdge', title: 'Schema mismatch', detail: 'a to b', offending: { parentStepId: 's1', childStepId: 's2' } };
    const api = fakeApi({
      getGraph: vi.fn().mockResolvedValue(ok(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }))),
      validate: vi.fn().mockResolvedValue(ok({ valid: false, problems: [problem] })),
    });

    const result = await loadDocument(api, 'wf1');

    expect(api.validate).toHaveBeenCalledWith('wf1');
    expect(result.ok && result.value.problems).toEqual([problem]);
    expect(result.ok && result.value.wires.map((w) => [w.id, w.broken])).toEqual([['wf->s1', false], ['s1->s2', true]]);
  });

  it('still loads when validate cannot be reached, with problems null and no broken wire', async () => {
    const api = fakeApi({
      getGraph: vi.fn().mockResolvedValue(ok(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }))),
      validate: vi.fn().mockResolvedValue({ ok: false, error: { kind: 'network', message: 'down' } }),
    });

    const result = await loadDocument(api, 'wf1');

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.problems).toBeNull();
    expect(result.ok && result.value.wires.some((w) => w.broken)).toBe(false);
  });

  it.each([
    ['400', { kind: 'badRequest', status: 400, detail: 'x' }],
    ['409', { kind: 'conflict', status: 409, detail: 'x', entity: null }],
    ['422', { kind: 'unprocessable', status: 422, detail: 'x' }],
    ['500', { kind: 'http', status: 500, detail: 'x' }],
  ])('draws the graph with problems null when validate answers %s', async (_name, error) => {
    const api = fakeApi({ validate: vi.fn().mockResolvedValue({ ok: false, error }) });

    const result = await loadDocument(api, 'wf1');

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.problems).toBeNull();
  });

  it('fetches parked steps the layout lists, and the processors they need', async () => {
    const api = fakeApi({
      getGraph: vi.fn().mockResolvedValue(ok(graphDto({ layout: { parked: ['p1'], steps: { p1: { x: 288, y: 400 } } } } as never))),
      getStep: vi.fn().mockResolvedValue(ok(stepDto('p1', { processorId: 'p9' }))),
      getProcessor: vi.fn().mockResolvedValue(ok(processorDto('p9'))),
    });

    const result = await loadDocument(api, 'wf1');

    expect(result.ok && result.value.parkedIds).toEqual(['p1']);
    expect(result.ok && result.value.placement.steps.get('p1')).toEqual({ x: 288, y: 400 });
    expect(result.ok && result.value.graph.processors.has('p9')).toBe(true);
    expect(api.getStep).toHaveBeenCalledWith('p1');
  });

  it('ignores a parked id the server no longer has, and one that is actually wired (review focus 1)', async () => {
    const api = fakeApi({
      getGraph: vi.fn().mockResolvedValue(ok(graphDto({ layout: { parked: ['gone', 's1'], steps: { gone: { x: 8, y: 8 } } } } as never))),
    });

    const result = await loadDocument(api, 'wf1');

    expect(result.ok && result.value.parkedIds).toEqual([]);
    expect(api.getStep).toHaveBeenCalledTimes(1);
    expect(api.getStep).toHaveBeenCalledWith('gone');
  });

  it('survives a layout that is not an object', async () => {
    const api = fakeApi({ getGraph: vi.fn().mockResolvedValue(ok(graphDto({ layout: [1, 2, 3] } as never))) });
    expect((await loadDocument(api, 'wf1')).ok).toBe(true);
  });

  it('ignores the bad parts of a layout, keeps the good ones, and places missing blocks with elkjs', async () => {
    const layout = {
      sphere: { x: 'left', y: 0 },
      steps: { s1: { x: '288', y: 64 }, s2: { x: 576, y: 96 }, vanished: { x: 8, y: 8 } },
      caches: [1],
      parked: 'p1',
    };
    const api = fakeApi({
      getGraph: vi.fn().mockResolvedValue(ok(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')], layout } as never))),
    });

    const result = await loadDocument(api, 'wf1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { steps } = result.value.placement;
    expect([...steps.keys()].sort()).toEqual(['s1', 's2']);
    expect(steps.get('s2')).toEqual({ x: 576, y: 96 });
    expect(steps.get('s1')!.x % 8).toBe(0);
    expect(Number.isFinite(steps.get('s1')!.y)).toBe(true);
    expect(result.value.parkedIds).toEqual([]);
    expect(result.value.wires.map((w) => w.id)).toEqual(['wf->s1', 's1->s2']);
  });

  it('returns an error result, not a rejection, when the layout engine fails', async () => {
    const placement = await import('../layout/placement');
    const spy = vi.spyOn(placement, 'place').mockRejectedValue(new Error('elk exploded'));
    try {
      const result = await loadDocument(fakeApi(), 'wf1');
      expect(result).toEqual({ ok: false, error: { kind: 'http', status: 0, detail: 'Layout failed: elk exploded' } });
    } finally {
      spy.mockRestore();
    }
  });

  it('passes on the error when the graph cannot be loaded', async () => {
    const api = fakeApi({ getGraph: vi.fn().mockResolvedValue(notFound) });
    expect(await loadDocument(api, 'wf1')).toEqual(notFound);
  });

  it('passes on a parked-step error other than 404', async () => {
    const failure = { ok: false, error: { kind: 'network', message: 'down' } } as const;
    const api = fakeApi({
      getGraph: vi.fn().mockResolvedValue(ok(graphDto({ layout: { parked: ['p1'] } } as never))),
      getStep: vi.fn().mockResolvedValue(failure),
    });
    expect(await loadDocument(api, 'wf1')).toEqual(failure);
  });
});
