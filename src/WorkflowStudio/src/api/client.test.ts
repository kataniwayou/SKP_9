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

  it.each([
    ['workflow', '/api/v1/workflows/x'],
    ['step', '/api/v1/steps/x'],
    ['processor', '/api/v1/processors/x'],
    ['schema', '/api/v1/schemas/x'],
    ['assignment', '/api/v1/assignments/x'],
    ['cache', '/api/v1/caches/x'],
  ] as const)('GETs a %s from %s', async (kind, url) => {
    const fetchImpl = vi.fn().mockResolvedValue(respond(200, { id: 'x' }));
    expect(await createApi('/api/v1', fetchImpl).getEntity(kind, 'x')).toEqual({ ok: true, value: { id: 'x' } });
    expect(fetchImpl).toHaveBeenCalledWith(url, expect.objectContaining({ method: 'GET' }));
  });

  it('PUTs an entity with its update DTO as JSON and returns what the server read back', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respond(200, { id: 's1', name: 'renamed' }));
    const dto = { name: 'renamed', version: '1.0.0', description: null, processorId: 'p1', nextStepIds: ['s2'], entryCondition: 1 as const };

    const result = await createApi('/api/v1', fetchImpl).putEntity('step', 's1', dto);

    expect(fetchImpl).toHaveBeenCalledWith('/api/v1/steps/s1', expect.objectContaining({ method: 'PUT', body: JSON.stringify(dto) }));
    expect(fetchImpl.mock.calls[0]![1].headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(result).toEqual({ ok: true, value: { id: 's1', name: 'renamed' } });
  });

  it('POSTs a new assignment and returns the 201 body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respond(201, { id: 'a9', stepId: 's1' }));
    const dto = { name: 'fetch-assignment', version: '1.0.0', description: null, stepId: 's1', payload: '{}' };

    expect(await createApi('/api/v1', fetchImpl).createAssignment(dto)).toEqual({ ok: true, value: { id: 'a9', stepId: 's1' } });
    expect(fetchImpl).toHaveBeenCalledWith('/api/v1/assignments', expect.objectContaining({ method: 'POST', body: JSON.stringify(dto) }));
  });

  it('DELETEs an assignment and takes the 204 as done', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    expect(await createApi('/api/v1', fetchImpl).deleteAssignment('a9')).toEqual({ ok: true, value: null });
    expect(fetchImpl).toHaveBeenCalledWith('/api/v1/assignments/a9', expect.objectContaining({ method: 'DELETE' }));
  });

  it("keeps a 400's field messages by property name, and only the strings", async () => {
    const api = createApi('/api/v1', vi.fn().mockResolvedValue(respond(400, {
      title: 'Validation failed',
      errors: { Version: ['Version must be x.y.z.'], CronExpression: ['Bad cron.', 7], Junk: 'not a list' },
    })));

    expect(await api.putEntity('workflow', 'wf1', {})).toEqual({
      ok: false,
      error: { kind: 'badRequest', status: 400, detail: 'Validation failed', errors: { Version: ['Version must be x.y.z.'], CronExpression: ['Bad cron.'] } },
    });
  });

  it('keeps an empty field map for a 400 without errors', async () => {
    const api = createApi('/api/v1', vi.fn().mockResolvedValue(respond(400, { title: 'Bad' })));
    expect(await api.getGraph('wf1')).toEqual({ ok: false, error: { kind: 'badRequest', status: 400, detail: 'Bad', errors: {} } });
  });

  it('maps a 200 whose body is not JSON to an error result instead of rejecting', async () => {
    const api = createApi('/api/v1', vi.fn().mockResolvedValue(new Response('<html>', { status: 200 })));
    const result = await api.getGraph('wf1');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatchObject({ kind: 'http', status: 0 });
  });
});
