import { describe, expect, it, vi } from 'vitest';
import type { StudioApi } from '../api/client';
import { board, shared } from '../design/boardFixtures';
import { boardChanges } from '../design/changes';
import { createBoardStore } from '../design/boardStore';
import { createOutputStore } from '../output/outputStore';
import { commitDelete, commitDeletes, prepareDelete, prepareDeletes } from './deleteWorkflow';
import { saveBoard } from '../design/saveBoard';

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

  it('keeps a row that an unsaved edit linked to another workflow: no delete for it, and the next save does not touch a missing row', async () => {
    const t = setup();
    // unsaved: hourly also links daily's only-in-base row
    t.store.edit((b) => ({ ...b, workflows: { ...b.workflows, hourly: { ...b.workflows.hourly!, assignmentIds: ['a-hourly-fetch', 'a-daily-fetch'] } } }));
    const plan = (await prepareDelete(t.studio, t.store, t.output, 'daily'))!;
    expect(plan.changes.map((c) => `${c.table}:${c.id}`)).toEqual(['workflows:daily']);
    expect(await commitDelete(t.studio, t.store, t.output, plan)).toBe(true);
    expect(t.store.base().assignments['a-daily-fetch']).toBeDefined();
    expect(t.store.state().assignments['a-daily-fetch']).toBeDefined();
    const next = boardChanges(t.store.base(), t.store.state());
    expect(next.map((c) => `${c.op} ${c.table}:${c.id}`)).toEqual(['update workflows:hourly']);
    expect(next.some((c) => c.id === 'a-daily-fetch')).toBe(false);
  });

  describe('a delete and a Save never overlap', () => {
    const gate = <T,>() => { let open!: (v: T) => void; const p = new Promise<T>((r) => { open = r; }); return { p, open }; };
    const APPLIED = { ok: true as const, value: { ok: true, applied: true, results: [], made: {} } };

    it('commit holds the board while its apply runs: Save is refused meanwhile; released after', async () => {
      const t = setup();
      const plan = (await prepareDelete(t.studio, t.store, t.output, 'daily'))!;
      t.store.edit((b) => ({ ...b, steps: { ...b.steps, lonely: { ...b.steps.lonely!, name: 'l2' } } }));
      const g = gate<typeof APPLIED>();
      t.api.applyModel.mockReturnValueOnce(g.p as never);
      const running = commitDelete(t.studio, t.store, t.output, plan);
      expect(t.store.saving()).toBe(true);
      expect(await saveBoard(t.studio, t.store, t.output)).toBe('refused');
      expect(t.api.applyModel).toHaveBeenCalledTimes(1);
      expect(texts(t.output).at(-1)).toBe('Saving — wait for it to finish');
      g.open(APPLIED);
      expect(await running).toBe(true);
      expect(t.store.saving()).toBe(false);
      expect(t.store.state().workflows.daily).toBeUndefined();
    });

    it('commit releases the board when its apply fails or throws', async () => {
      const t = setup();
      const plan = (await prepareDelete(t.studio, t.store, t.output, 'daily'))!;
      t.api.applyModel.mockResolvedValueOnce({ ok: false, error: { kind: 'network', message: 'down' } } as never);
      expect(await commitDelete(t.studio, t.store, t.output, plan)).toBe(false);
      expect(t.store.saving()).toBe(false);
      t.api.applyModel.mockRejectedValueOnce(new Error('boom'));
      await expect(commitDelete(t.studio, t.store, t.output, plan)).rejects.toThrow('boom');
      expect(t.store.saving()).toBe(false);
    });

    it('prepare holds the board through the dry run', async () => {
      const t = setup();
      const g = gate<{ ok: true; value: { ok: boolean; results: never[] } }>();
      t.api.validateModel.mockReturnValueOnce(g.p as never);
      const running = prepareDelete(t.studio, t.store, t.output, 'daily');
      expect(t.store.saving()).toBe(true);
      g.open({ ok: true, value: { ok: true, results: [] } });
      expect(await running).not.toBeNull();
      expect(t.store.saving()).toBe(false);
    });

    it('commit is refused while a Save runs', async () => {
      const t = setup();
      const plan = (await prepareDelete(t.studio, t.store, t.output, 'daily'))!;
      t.store.edit((b) => ({ ...b, steps: { ...b.steps, lonely: { ...b.steps.lonely!, name: 'l2' } } }));
      const g = gate<typeof APPLIED>();
      t.api.applyModel.mockReturnValueOnce(g.p as never);
      const saving = saveBoard({ ...t.api, validateWorkflow: vi.fn(), publishDiagram: vi.fn() } as unknown as StudioApi, t.store, t.output);
      expect(await commitDelete(t.studio, t.store, t.output, plan)).toBe(false);
      expect(t.api.applyModel).toHaveBeenCalledTimes(1);
      g.open({ ok: true, value: { ok: false, applied: false, results: [], made: {} } } as never);
      await saving;
      expect(t.store.state().workflows.daily).toBeDefined();
    });
  });
});

describe('deleting several triangles', () => {
  const refuse = (id: string) => ({ ok: true, value: { ok: false, results: [
    { index: 0, op: 'delete', table: 'workflows', id, ok: false, status: 422, problem: { detail: 'running: stop it first' } },
  ] } }) as never;

  it('runs each dry run; a refused one is reported and left out, the rest are planned', async () => {
    const t = setup();
    t.api.validateModel.mockResolvedValueOnce(refuse('daily'));
    const plans = await prepareDeletes(t.studio, t.store, t.output, ['daily', 'hourly']);
    expect(t.api.validateModel).toHaveBeenCalledTimes(2);
    expect(plans.map((p) => p.workflowId)).toEqual(['hourly']);
    expect(texts(t.output)).toContain('workflow daily: running: stop it first');
    expect(t.store.saving()).toBe(false);
  });

  it('deletes one by one: a refusal of one is reported and the rest still go', async () => {
    const t = setup();
    const plans = await prepareDeletes(t.studio, t.store, t.output, ['daily', 'hourly']);
    expect(plans).toHaveLength(2);
    t.api.applyModel.mockResolvedValueOnce({ ok: true, value: { ok: false, applied: false, made: {}, results: [
      { index: 0, op: 'delete', table: 'workflows', id: 'daily', ok: false, status: 409, problem: {} },
    ] } } as never);
    expect(await commitDeletes(t.studio, t.store, t.output, plans)).toEqual(['hourly']);
    expect(t.api.applyModel).toHaveBeenCalledTimes(2);
    expect(t.store.state().workflows.daily).toBeDefined();
    expect(t.store.state().workflows.hourly).toBeUndefined();
  });

  it('a thrown apply of one is reported and the rest still go', async () => {
    const t = setup();
    const plans = await prepareDeletes(t.studio, t.store, t.output, ['daily', 'hourly']);
    t.api.applyModel.mockRejectedValueOnce(new Error('boom'));
    expect(await commitDeletes(t.studio, t.store, t.output, plans)).toEqual(['hourly']);
    expect(texts(t.output)).toContain('daily: not deleted — boom');
    expect(t.store.saving()).toBe(false);
  });
});
