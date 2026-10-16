import { describe, expect, it, vi } from 'vitest';
import { readProject } from './project';

const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('readProject', () => {
  it('reads the six lists from BaseApi', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => answer([{ id: String(url) }]));
    const r = await readProject(fetchFn as typeof fetch);
    expect(fetchFn.mock.calls.map(([u]) => u)).toEqual(
      ['workflows', 'steps', 'processors', 'schemas', 'assignments', 'caches'].map((t) => `/api/v1/${t}`));
    expect(r).toEqual({ ok: true, data: expect.objectContaining({ caches: [{ id: '/api/v1/caches' }] }) });
  });

  it('says which read failed, and never throws', async () => {
    const failing = vi.fn(async (url: string | URL | Request) => (String(url).endsWith('/schemas') ? answer({}, 503) : answer([])));
    expect(await readProject(failing as typeof fetch)).toEqual({ ok: false, message: 'BaseApi could not be read: GET /api/v1/schemas: 503' });
    const offline = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    expect(await readProject(offline as typeof fetch)).toEqual({ ok: false, message: 'BaseApi could not be read: Failed to fetch' });
  });
});
