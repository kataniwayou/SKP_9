import { describe, expect, it, vi } from 'vitest';
import { dryRun } from './validate';

const change = { op: 'update' as const, table: 'schemas', id: 'c1', row: { name: 'x' }, atom: 'schema:c1', why: 'edits name' };

describe('dryRun (POST /model/validate)', () => {
  it('sends the changes without their Valence-only parts and returns the results', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ ok: true, results: [{ index: 0, ok: true, status: 200, problem: null }] }), { status: 200 }));
    const r = await dryRun([change, { op: 'delete', table: 'caches', id: 'k1', atom: 'cache:k1', why: '' }], fetchFn as unknown as typeof fetch);
    expect(r).toMatchObject({ kind: 'done', ok: true });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/model/validate');
    expect(JSON.parse(init.body as string)).toEqual({ changes: [{ op: 'update', table: 'schemas', id: 'c1', row: { name: 'x' } }, { op: 'delete', table: 'caches', id: 'k1' }] });
  });

  it('is unavailable on a BaseApi without it, an error, or no BaseApi', async () => {
    expect(await dryRun([change], (async () => new Response('', { status: 404 })) as typeof fetch)).toEqual({ kind: 'unavailable', reason: 'this BaseApi has no POST /model/validate yet', missing: true });
    expect(await dryRun([change], (async () => new Response('', { status: 500 })) as typeof fetch)).toEqual({ kind: 'unavailable', reason: 'POST /api/v1/model/validate: 500' });
    const offline = async () => { throw new TypeError('Failed to fetch'); };
    expect(await dryRun([change], offline as typeof fetch)).toEqual({ kind: 'unavailable', reason: 'BaseApi could not be reached: Failed to fetch' });
  });
});
