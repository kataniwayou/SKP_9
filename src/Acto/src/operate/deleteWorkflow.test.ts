import { describe, expect, it, vi } from 'vitest';
import type { StudioApi } from '../api/client';
import { board, shared } from '../design/boardFixtures';
import { createBoardStore } from '../design/boardStore';
import { createOutputStore } from '../output/outputStore';
import { commitDelete, prepareDelete } from './deleteWorkflow';

function setup(start = board()) {
  const output = createOutputStore(null, () => '00:00:00');
  const store = createBoardStore(output, null);
  store.load(start);
  const api = {
    validateModel: vi.fn(async () => ({ ok: true as const, value: { ok: true, results: [] } })),
    applyModel: vi.fn(async () => ({ ok: true as const, value: { ok: true, applied: true, results: [], made: {} } })),
  };
  return { output, store, api, studio: api as unknown as StudioApi };
}
const texts = (o: ReturnType<typeof createOutputStore>) => o.lines().map((l) => l.text);

describe('deleting a triangle', () => {
  it('plans the workflow with its stamp and only the assignments no other workflow links', async () => {
    const t = setup();
    const plan = await prepareDelete(t.studio, t.store, t.output, 'daily');
    expect(plan!.changes).toEqual([
      { op: 'delete', table: 'workflows', id: 'daily', updatedAt: '2026-11-01T00:00:00Z' },
      { op: 'delete', table: 'assignments', id: 'a-daily-fetch', updatedAt: '2026-11-01T00:00:00Z' },
    ]);
    expect(t.api.validateModel).toHaveBeenCalledWith(plan!.changes);
    const s = setup(shared());
    const p2 = await prepareDelete(s.studio, s.store, s.output, 'daily');
    expect(p2!.changes.map((c) => c.table)).toEqual(['workflows']);
  });

  it('a running refusal leaves the board and names the reason BaseAPI gave', async () => {
    const t = setup();
    const before = t.store.state();
    t.api.validateModel.mockResolvedValue({ ok: true, value: { ok: false, results: [
      { index: 0, op: 'delete', table: 'workflows', id: 'daily', ok: false, status: 422, problem: { detail: 'running: stop it first' } },
    ] } } as never);
    expect(await prepareDelete(t.studio, t.store, t.output, 'daily')).toBeNull();
    expect(texts(t.output)).toContain('workflow daily: running: stop it first');
    expect(t.store.state()).toBe(before);
    expect(t.store.base().workflows.daily).toBeDefined();
  });

  it('is refused while saving', async () => {
    const t = setup();
    t.store.setSaving(true);
    expect(await prepareDelete(t.studio, t.store, t.output, 'daily')).toBeNull();
    expect(t.api.validateModel).not.toHaveBeenCalled();
  });

  it('commit applies, drops the workflow from the board and the base, and keeps steps and caches', async () => {
    const t = setup();
    const plan = (await prepareDelete(t.studio, t.store, t.output, 'daily'))!;
    expect(await commitDelete(t.studio, t.store, t.output, plan)).toBe(true);
    expect(t.api.applyModel).toHaveBeenCalledWith(plan.changes);
    for (const s of [t.store.state(), t.store.base()]) {
      expect(s.workflows.daily).toBeUndefined();
      expect(s.assignments['a-daily-fetch']).toBeUndefined();
      expect(Object.keys(s.steps)).toEqual(['fetch', 'expand', 'lonely']);
      expect(s.caches.c1).toBeDefined();
    }
    expect(t.store.unsaved().size).toBe(0);
    expect(texts(t.output).some((x) => x.includes('workflow daily') && x.includes('assignment fetch-assignment'))).toBe(true);
  });

  it('a refused commit leaves the board', async () => {
    const t = setup();
    const plan = (await prepareDelete(t.studio, t.store, t.output, 'daily'))!;
    t.api.applyModel.mockResolvedValue({ ok: true, value: { ok: false, applied: false, made: {}, results: [
      { index: 0, op: 'delete', table: 'workflows', id: 'daily', ok: false, status: 409, problem: {} },
    ] } } as never);
    expect(await commitDelete(t.studio, t.store, t.output, plan)).toBe(false);
    expect(t.store.state().workflows.daily).toBeDefined();
  });
});
