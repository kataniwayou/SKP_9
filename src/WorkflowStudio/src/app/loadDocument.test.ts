import { describe, expect, it, vi } from 'vitest';
import type { ApiResult, StudioApi } from '../api/client';
import { graphDto, processorDto, schemaDto, stepDto } from '../api/fixtures';
import { createApi } from '../api/client';
import { loadDocument } from './loadDocument';

const ok = <T,>(value: T): ApiResult<T> => ({ ok: true, value });
const notFound = { ok: false, error: { kind: 'notFound', status: 404 } } as const;

function fakeApi(over: Partial<StudioApi> = {}): StudioApi {
  return {
    listWorkflows: vi.fn(),
    getGraph: vi.fn().mockResolvedValue(ok(graphDto())),
    getStep: vi.fn().mockResolvedValue(notFound),
    getProcessor: vi.fn().mockResolvedValue(notFound),
    getSchema: vi.fn().mockResolvedValue(notFound),
    getEntity: vi.fn().mockResolvedValue(notFound),
    putEntity: vi.fn().mockResolvedValue(notFound),
    createAssignment: vi.fn().mockResolvedValue(notFound),
    deleteAssignment: vi.fn().mockResolvedValue(notFound),
    listLive: vi.fn(),
    listLiveness: vi.fn(),
    saveDesign: vi.fn().mockResolvedValue(notFound),
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

  it('reads the schemas a parked processor names that the graph does not carry, and only those', async () => {
    const api = fakeApi({
      getGraph: vi.fn().mockResolvedValue(ok(graphDto({
        processors: [processorDto('p1', { inputSchemaId: 'known' })],
        schemas: [schemaDto('known')],
        layout: { parked: ['pk'] },
      } as never))),
      getStep: vi.fn().mockResolvedValue(ok(stepDto('pk', { processorId: 'p9' }))),
      getProcessor: vi.fn().mockResolvedValue(ok(processorDto('p9', { inputSchemaId: 'known', outputSchemaId: 'sOut', configSchemaId: 'gone' }))),
      getSchema: vi.fn().mockImplementation(async (id: string) => (id === 'sOut' ? ok(schemaDto('sOut', { name: 'orders-out' })) : notFound)),
    });

    const result = await loadDocument(api, 'wf1');

    expect(api.getSchema).toHaveBeenCalledTimes(2);
    expect(api.getSchema).toHaveBeenCalledWith('sOut');
    expect(api.getSchema).toHaveBeenCalledWith('gone');
    expect(result.ok && result.value.graph.schemas.get('sOut')?.name).toBe('orders-out');
    expect(result.ok && result.value.graph.schemas.has('gone')).toBe(false);
  });

  it('still opens when a parked processor\'s schema comes back without an id', async () => {
    const api = fakeApi({
      getGraph: vi.fn().mockResolvedValue(ok(graphDto({ layout: { parked: ['pk'] } } as never))),
      getStep: vi.fn().mockResolvedValue(ok(stepDto('pk', { processorId: 'p9' }))),
      getProcessor: vi.fn().mockResolvedValue(ok(processorDto('p9', { inputSchemaId: 'noid' }))),
      getSchema: vi.fn().mockResolvedValue(ok({ name: 'broken' } as never)),
    });
    const result = await loadDocument(api, 'wf1');
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.graph.schemas.has('noid')).toBe(false);
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

  it('resolves to an error result when the graph body is missing a required field', async () => {
    const api = fakeApi({ getGraph: vi.fn().mockResolvedValue(ok(graphDto({ workflow: { id: null } } as never))) });
    const result = await loadDocument(api, 'wf1');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatchObject({ kind: 'http', status: 0 });
  });

  it('resolves to an error result when getGraph returns 200 with an invalid body', async () => {
    const api = fakeApi({ getGraph: vi.fn().mockResolvedValue(ok(null as never)) });
    const result = await loadDocument(api, 'wf1');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatchObject({ kind: 'http', status: 0 });
  });

  it('opens with GETs only: no validate, no write (plan 8 §3.1)', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      return new Response(JSON.stringify(graphDto({ design: { steps: [] } } as never)), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const result = await loadDocument(createApi('/api/v1', fetchImpl as unknown as typeof fetch), 'wf1');

    expect(calls).toEqual(['GET /api/v1/workflows/wf1/graph']);
    expect(result.ok && result.value.graph.design).toEqual({ steps: [] });
  });
});
