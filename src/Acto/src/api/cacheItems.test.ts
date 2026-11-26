import { describe, expect, it, vi } from 'vitest';
import { createApi } from './client';

// A cache's items no longer ride on its read DTO; they are paged (GET /caches/{id}/items).
describe('cacheItemsPage', () => {
  const page = { items: [{ key: 'a', value: '1' }], next: 'b' };
  const respond = () => vi.fn().mockResolvedValue(new Response(JSON.stringify(page), { status: 200, headers: { 'Content-Type': 'application/json' } }));

  it('builds the query (after encoded, limit)', async () => {
    const fetchImpl = respond();
    const result = await createApi('/api/v1', fetchImpl).cacheItemsPage('c 1', 'a/b&c=d', 50);
    expect(fetchImpl).toHaveBeenCalledWith('/api/v1/caches/c%201/items?after=a%2Fb%26c%3Dd&limit=50', expect.objectContaining({ method: 'GET' }));
    expect(result).toEqual({ ok: true, value: page });
  });

  it('sends no query for the first page with the default limit', async () => {
    const fetchImpl = respond();
    await createApi('/api/v1', fetchImpl).cacheItemsPage('c1');
    expect(fetchImpl).toHaveBeenCalledWith('/api/v1/caches/c1/items', expect.anything());
  });

  it('sends only the parts given', async () => {
    const fetchImpl = respond();
    await createApi('/api/v1', fetchImpl).cacheItemsPage('c1', null, 5);
    expect(fetchImpl).toHaveBeenCalledWith('/api/v1/caches/c1/items?limit=5', expect.anything());
  });
});
