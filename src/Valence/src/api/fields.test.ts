import { describe, expect, it } from 'vitest';
import { readFields, SNAPSHOT } from './fields';

const answer = (status: number, body: unknown, etag?: string) => async () =>
  new Response(JSON.stringify(body), { status, headers: etag ? { ETag: etag } : {} });

describe('readFields (decision 5: the rules come from BaseApi)', () => {
  it("uses BaseApi's description, with its ETag", async () => {
    const entities = [{ table: 'schemas', fields: [], unique: [] }];
    const r = await readFields(answer(200, { entities }, '"0123456789abcdef"') as typeof fetch);
    expect(r).toEqual({ from: 'baseapi', fields: { etag: '0123456789abcdef', entities }, note: 'Rules: from BaseApi, GET /model/fields.' });
  });

  it('falls back to the snapshot on a BaseApi without the endpoint, and says so', async () => {
    const r = await readFields(answer(404, {}) as typeof fetch);
    expect(r.from).toBe('snapshot');
    expect(r.fields).toBe(SNAPSHOT);
    expect(r.note).toBe('Rules: the bundled snapshot of GET /model/fields (this BaseApi has no GET /model/fields yet).');
  });

  it('falls back on an error, a wrong body or no BaseApi at all', async () => {
    expect((await readFields(answer(503, {}) as typeof fetch)).note).toMatch(/\(GET \/api\/v1\/model\/fields: 503\)\.$/);
    expect((await readFields(answer(200, { tables: [] }) as typeof fetch)).note).toMatch(/not a description/);
    const offline = async () => { throw new TypeError('Failed to fetch'); };
    expect((await readFields(offline as typeof fetch)).note).toMatch(/BaseApi could not be read: Failed to fetch/);
  });

  it('bundles a snapshot BaseApi generated: every entity, with an ETag', () => {
    expect(SNAPSHOT.etag).toMatch(/^[0-9a-f]{16}$/);
    expect(SNAPSHOT.entities.map((e) => e.table)).toEqual(['assignments', 'caches', 'processors', 'schemas', 'steps', 'workflows']);
  });
});
