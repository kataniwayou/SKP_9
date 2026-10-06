import { describe, expect, it, vi } from 'vitest';
import { createApi } from './client';

function respond(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

describe('createApi', () => {
  it('GETs the graph from the same origin and returns it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respond(200, { workflow: { id: 'wf1' } }));
    const api = createApi('/api/v1', fetchImpl);

    const result = await api.getGraph('wf1');

    expect(fetchImpl).toHaveBeenCalledWith('/api/v1/workflows/wf1/graph', expect.objectContaining({ method: 'GET' }));
    expect(result).toEqual({ ok: true, value: { workflow: { id: 'wf1' } } });
  });

  it('lists workflows from the bare array the server returns', async () => {
    const api = createApi('/api/v1', vi.fn().mockResolvedValue(respond(200, [{ id: 'wf1' }])));
    expect(await api.listWorkflows()).toEqual({ ok: true, value: [{ id: 'wf1' }] });
  });

  it('maps 404 to notFound', async () => {
    const api = createApi('/api/v1', vi.fn().mockResolvedValue(respond(404, { title: 'Not Found' })));
    expect(await api.getStep('s1')).toEqual({ ok: false, error: { kind: 'notFound', status: 404 } });
  });

  it('maps a stale-graph 409 and keeps the entity it names', async () => {
    const api = createApi('/api/v1', vi.fn().mockResolvedValue(
      respond(409, { title: 'Graph is stale', detail: 'The step was changed.', kind: 'step', id: 's9' })));

    expect(await api.getGraph('wf1')).toEqual({
      ok: false,
      error: { kind: 'conflict', status: 409, detail: 'The step was changed.', entity: { kind: 'step', id: 's9' } },
    });
  });

  it('maps 422 and other statuses with the problem detail, falling back to the title', async () => {
    const api422 = createApi('/api/v1', vi.fn().mockResolvedValue(respond(422, { title: 'Unprocessable Entity' })));
    const api500 = createApi('/api/v1', vi.fn().mockResolvedValue(respond(500, { title: 'Boom', detail: 'db down' })));

    expect(await api422.getGraph('wf1')).toEqual({ ok: false, error: { kind: 'unprocessable', status: 422, detail: 'Unprocessable Entity' } });
    expect(await api500.getGraph('wf1')).toEqual({ ok: false, error: { kind: 'http', status: 500, detail: 'db down' } });
  });

  it('maps a thrown fetch to a network error', async () => {
    const api = createApi('/api/v1', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    expect(await api.getGraph('wf1')).toEqual({ ok: false, error: { kind: 'network', message: 'Failed to fetch' } });
  });

  it('escapes the id in the path', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respond(200, {}));
    await createApi('/api/v1', fetchImpl).getProcessor('a/b');
    expect(fetchImpl).toHaveBeenCalledWith('/api/v1/processors/a%2Fb', expect.anything());
  });

  it('POSTs validate with no body and returns the verdict', async () => {
    const verdict = { valid: false, problems: [{ gate: 'schemaEdge', title: 't', detail: 'd', offending: { parentStepId: 'a', childStepId: 'b' } }] };
    const fetchImpl = vi.fn().mockResolvedValue(respond(200, verdict));

    const result = await createApi('/api/v1', fetchImpl).validate('wf1');

    expect(fetchImpl).toHaveBeenCalledWith('/api/v1/workflows/wf1/validate', {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    expect(result).toEqual({ ok: true, value: verdict });
  });

  it('GETs a schema by id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respond(200, { id: 'sc1' }));
    expect(await createApi('/api/v1', fetchImpl).getSchema('sc1')).toEqual({ ok: true, value: { id: 'sc1' } });
    expect(fetchImpl).toHaveBeenCalledWith('/api/v1/schemas/sc1', expect.objectContaining({ method: 'GET' }));
  });

  it('GETs the live set and passes its body through untouched', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respond(200, ['a', 7]));
    expect(await createApi('/api/v1', fetchImpl).listLive()).toEqual({ ok: true, value: ['a', 7] });
    expect(fetchImpl).toHaveBeenCalledWith('/api/v1/orchestration/live', expect.objectContaining({ method: 'GET' }));
  });

  it('maps a 200 whose body is not JSON to an error result instead of rejecting', async () => {
    const api = createApi('/api/v1', vi.fn().mockResolvedValue(new Response('<html>', { status: 200 })));
    const result = await api.getGraph('wf1');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatchObject({ kind: 'http', status: 0 });
  });
});
