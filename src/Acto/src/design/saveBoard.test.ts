import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioApi } from '../api/client';
import { createOutputStore } from '../output/outputStore';
import { board, shared } from './boardFixtures';
import { createBoardStore } from './boardStore';
import { saveBoard } from './saveBoard';

vi.mock('../board/loadBoard', () => ({ loadBoard: vi.fn() }));
import { loadBoard } from '../board/loadBoard';

const T2 = '2026-11-02T00:00:00Z';

function setup(start = board()) {
  const output = createOutputStore(null, () => '00:00:00');
  const store = createBoardStore(output, null);
  store.load(start);
  const api = {
    applyModel: vi.fn(async () => ({ ok: true as const, value: { ok: true, applied: true, results: [], made: {} } })),
    validateWorkflow: vi.fn(async () => ({ ok: true as const, value: { problems: [] } })),
    publishDiagram: vi.fn(async () => ({ ok: true as const, value: null })),
  };
  return { output, store, api, studio: api as unknown as StudioApi };
}
const texts = (o: ReturnType<typeof createOutputStore>) => o.lines().map((l) => l.text);
const rename = (s: ReturnType<typeof setup>['store'], wf: string, name: string) =>
  s.edit((b) => ({ ...b, workflows: { ...b.workflows, [wf]: { ...b.workflows[wf]!, name } } }));

beforeEach(() => vi.mocked(loadBoard).mockReset());

describe('saveBoard', () => {
  it('says nothing when nothing changed', async () => {
    const t = setup();
    expect(await saveBoard(t.studio, t.store, t.output)).toBe('nothing');
    expect(t.api.applyModel).not.toHaveBeenCalled();
  });

  it('sends the diff and adopts the re-read', async () => {
    const t = setup();
    rename(t.store, 'daily', 'daily-2');
    const b = board();
    const fresh = { ...b, workflows: { ...b.workflows, daily: { ...b.workflows.daily!, name: 'daily-2', updatedAt: T2 } } };
    vi.mocked(loadBoard).mockResolvedValue({ ok: true, value: fresh });
    expect(await saveBoard(t.studio, t.store, t.output)).toBe('saved');
    const sent = (t.api.applyModel.mock.calls as unknown as unknown[][])[0]![0] as { op: string; table: string; id: string }[];
    expect(sent.map((c) => `${c.op} ${c.table} ${c.id}`)).toEqual(['update workflows daily']);
    expect(t.store.base()).toBe(fresh);
    expect(t.store.state()).toBe(fresh);
    expect(t.store.saving()).toBe(false);
  });

  it('a refusal keeps the board, marks failures and names each by kind and name', async () => {
    const t = setup();
    t.store.edit((b) => ({ ...b, steps: { ...b.steps, fetch: { ...b.steps.fetch!, name: 'fetch-2' } } }));
    const before = t.store.state();
    t.api.applyModel.mockResolvedValue({ ok: true, value: { ok: false, applied: false, made: {},
      results: [{ index: 0, op: 'update', table: 'steps', id: 'fetch', ok: false, status: 422, problem: { title: 'Invalid', errors: { Name: ['too long', 'odd'] } } }] } } as never);
    expect(await saveBoard(t.studio, t.store, t.output)).toBe('refused');
    expect(t.store.state()).toBe(before);
    expect(t.store.failures().get('step:fetch')).toBe('step fetch-2: too long; odd');
    expect(texts(t.output)).toContain('step fetch-2: too long; odd');
    expect(t.api.validateWorkflow).not.toHaveBeenCalled();
    expect(t.store.saving()).toBe(false);
  });

  it('says "changed elsewhere" for a 409', async () => {
    const t = setup();
    rename(t.store, 'daily', 'daily-2');
    t.api.applyModel.mockResolvedValue({ ok: true, value: { ok: false, applied: false, made: {}, results: [
      { index: 0, op: 'update', table: 'workflows', id: 'daily', ok: false, status: 409, problem: { detail: 'stale' } },
    ] } } as never);
    await saveBoard(t.studio, t.store, t.output);
    expect(texts(t.output)).toContain('daily-2 changed elsewhere — undo your changes to it, or reload');
    expect(t.store.failures().has('workflow:daily')).toBe(true);
  });

  it('validates and publishes exactly the affected workflows', async () => {
    const t = setup();
    rename(t.store, 'daily', 'daily-2');
    vi.mocked(loadBoard).mockResolvedValue({ ok: true, value: { ...board(), workflows: { ...board().workflows, daily: { ...board().workflows.daily!, name: 'daily-2' } } } });
    await saveBoard(t.studio, t.store, t.output);
    expect(t.api.validateWorkflow.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['daily']);
    const pub = t.api.publishDiagram.mock.calls as unknown as [string, string][];
    expect(pub.map((c) => c[0])).toEqual(['daily']);
    expect(pub[0]![1]).toContain('<svg');
  });

  it('a step-only change on a shared step republishes both workflows', async () => {
    const t = setup();
    t.store.edit((b) => ({ ...b, steps: { ...b.steps, fetch: { ...b.steps.fetch!, name: 'fetch-2' } } }));
    vi.mocked(loadBoard).mockResolvedValue({ ok: true, value: board() });
    await saveBoard(t.studio, t.store, t.output);
    expect(t.api.publishDiagram.mock.calls.map((c) => (c as unknown[])[0]).sort()).toEqual(['daily', 'hourly']);
  });

  it('problems go to the store and to Output', async () => {
    const t = setup(shared());
    rename(t.store, 'daily', 'daily-2');
    vi.mocked(loadBoard).mockResolvedValue({ ok: true, value: shared() });
    t.api.validateWorkflow.mockResolvedValue({ ok: true, value: { problems: [{ title: 'Cycle', detail: 'a -> a' }] } } as never);
    await saveBoard(t.studio, t.store, t.output);
    expect(t.store.problems('daily')).toBe(1);
    expect(texts(t.output)).toContain('daily: Cycle — a -> a');
  });

  it('a failed re-read keeps the present with BaseAPI ids and warns to reload', async () => {
    const t = setup();
    t.store.edit((b) => ({ ...b, steps: { ...b.steps, new1: { ...b.steps.lonely!, id: 'new1', name: 'new-step', updatedAt: null } },
      workflows: { ...b.workflows, daily: { ...b.workflows.daily!, entryStepIds: ['fetch', 'new1'] } } }));
    t.api.applyModel.mockResolvedValue({ ok: true, value: { ok: true, applied: true, results: [], made: { new1: 'g-1' } } });
    vi.mocked(loadBoard).mockResolvedValue({ ok: false, error: { kind: 'network', message: 'down' } });
    expect(await saveBoard(t.studio, t.store, t.output)).toBe('saved');
    const s = t.store.state();
    expect(s.steps['g-1']?.name).toBe('new-step');
    expect(s.steps.new1).toBeUndefined();
    expect(s.workflows.daily!.entryStepIds).toEqual(['fetch', 'g-1']);
    expect(texts(t.output).some((x) => x.includes('Reload'))).toBe(true);
    expect(t.api.publishDiagram).toHaveBeenCalledWith('daily', expect.stringContaining('<svg'));
  });

  it('always clears saving, also when the request throws', async () => {
    const t = setup();
    rename(t.store, 'daily', 'daily-2');
    t.api.applyModel.mockRejectedValue(new Error('boom'));
    await expect(saveBoard(t.studio, t.store, t.output)).rejects.toThrow('boom');
    expect(t.store.saving()).toBe(false);
  });
});
