import { describe, expect, it, vi } from 'vitest';
import type { ApiResult, StudioApi } from '../api/client';
import type { WorkflowDeleteOutcomeDto } from '../api/types';
import type { BoardStore } from '../design/boardStore';
import { createOutputStore } from '../output/outputStore';
import { commitDelete, confirmText, FRESH_READING_MS, prepareDelete, type DeletePlan } from './deleteWorkflow';
import { bw } from '../board/fixtures';
import { graphWith } from '../board/testApi';
import { createBoardStore } from '../design/boardStore';
import { saveWorkflow } from '../design/saveWorkflow';
import { moveStep, newWorkflowState } from '../design/state';

const names: Record<string, string> = { w1: 'orders', w2: 'billing', w3: 'extra', n1: 'new-workflow-1', n2: 'new-workflow-2' };
const saved = (id: string) => !id.startsWith('n');
const storeOf = () => {
  const remove = vi.fn();
  const store = { entry: (id: string) => ({ base: saved(id) ? {} : null, history: { present: { fields: { name: names[id] } } } }), remove } as unknown as BoardStore;
  return { store, remove };
};
type Dry = Partial<WorkflowDeleteOutcomeDto>;
const apiOf = (live: Promise<ApiResult<unknown>>, dry: (id: string, dryRun: boolean) => ApiResult<WorkflowDeleteOutcomeDto>) => {
  const del = vi.fn(async (id: string, dryRun: boolean) => dry(id, dryRun));
  return { api: { listLive: vi.fn(() => live), deleteWorkflow: del } as unknown as StudioApi, del };
};
const dto = (d: Dry): ApiResult<WorkflowDeleteOutcomeDto> => ({ ok: true, value: d as WorkflowDeleteOutcomeDto });
const liveOk = (ids: string[] = []) => Promise.resolve<ApiResult<unknown>>({ ok: true, value: ids });
const never = new Promise<never>(() => undefined);
const texts = (o: ReturnType<typeof createOutputStore>) => o.lines().map((l) => [l.level, l.text]);
const plan = (p: Partial<DeletePlan>): DeletePlan => ({ ids: ['w1'], names: ['orders'], steps: 0, assignments: 0, caches: 0, processors: 0, neverSaved: [], ...p });

describe('prepareDelete', () => {
  it('a live reading slower than the limit refuses and sends nothing', async () => {
    const { store } = storeOf(); const o = createOutputStore(null);
    const { api, del } = apiOf(never, () => dto({}));
    const wait = vi.fn((ms: number) => { expect(ms).toBe(FRESH_READING_MS); return Promise.resolve(); });
    expect(await prepareDelete(api, store, o, ['w1'], wait)).toBeNull();
    expect(del).not.toHaveBeenCalled();
    expect(texts(o)).toEqual([['error', 'orders: not deleted — could not confirm it is stopped (no live reading within 5 s)']]);
  });
  it('a failed live reading refuses', async () => {
    const { store } = storeOf(); const o = createOutputStore(null);
    const { api, del } = apiOf(Promise.resolve({ ok: false, error: { kind: 'network', message: 'down' } }), () => dto({}));
    expect(await prepareDelete(api, store, o, ['w1'], () => never)).toBeNull();
    expect(del).not.toHaveBeenCalled();
    expect(o.lines()[0]!.level).toBe('error');
    expect(o.lines()[0]!.text).toMatch(/^orders: not deleted — could not confirm it is stopped/);
  });
  it('a running workflow refuses, ids compared lower-cased', async () => {
    const { store } = storeOf(); const o = createOutputStore(null);
    const { api, del } = apiOf(liveOk(['W1']), () => dto({}));
    expect(await prepareDelete(api, store, o, ['w1'], () => never)).toBeNull();
    expect(del).not.toHaveBeenCalled();
    expect(texts(o)).toEqual([['error', 'orders: not deleted — it is running. Stop it first']]);
  });
  it('a dry run with errors refuses with the first message', async () => {
    const { store } = storeOf(); const o = createOutputStore(null);
    const { api } = apiOf(liveOk(), () => dto({ errors: [{ message: 'step s is shared' }] as never }));
    expect(await prepareDelete(api, store, o, ['w1'], () => never)).toBeNull();
    expect(texts(o)).toEqual([['error', 'orders: not deleted — step s is shared']]);
  });
  it('a dry run that is fine gives the plan and the confirm text', async () => {
    const { store } = storeOf(); const o = createOutputStore(null);
    const { api, del } = apiOf(liveOk(), () => dto({ steps: 5, assignments: 3, caches: 1, processors: 2, errors: [] }));
    const p = await prepareDelete(api, store, o, ['w1'], () => never);
    expect(p).toEqual({ ids: ['w1'], names: ['orders'], steps: 5, assignments: 3, caches: 1, processors: 2, neverSaved: [] });
    expect(del).toHaveBeenCalledWith('w1', true);
    expect(confirmText(p!)).toBe('5 steps, 3 assignments go. Delete orders?');
  });
  it('several workflows sum their counts', async () => {
    const { store } = storeOf(); const o = createOutputStore(null);
    const { api } = apiOf(liveOk(), (id) => dto(id === 'w1' ? { steps: 5, assignments: 3 } : { steps: 4, assignments: 1 }));
    const p = await prepareDelete(api, store, o, ['w1', 'w2'], () => never);
    expect(confirmText(p!)).toBe('9 steps, 4 assignments go. Delete 2 workflows?');
  });
  it('one refusal refuses all and each refusal is logged', async () => {
    const { store } = storeOf(); const o = createOutputStore(null);
    const { api } = apiOf(liveOk(['w2']), () => dto({ steps: 1, assignments: 1 }));
    expect(await prepareDelete(api, store, o, ['w1', 'w2'], () => never)).toBeNull();
    expect(texts(o)).toEqual([['error', 'billing: not deleted — it is running. Stop it first']]);
  });
  it('only never-saved: no request at all', async () => {
    const { store } = storeOf(); const o = createOutputStore(null);
    const { api, del } = apiOf(never, () => dto({}));
    const p = await prepareDelete(api, store, o, ['n1'], () => never);
    expect(api.listLive).not.toHaveBeenCalled(); expect(del).not.toHaveBeenCalled();
    expect(confirmText(p!)).toBe('Delete new-workflow-1? It was never saved.');
    const two = await prepareDelete(api, store, o, ['n1', 'n2'], () => never);
    expect(confirmText(two!)).toBe('Delete 2 workflows? They were never saved.');
  });
  it('a mix of saved and never-saved says the counts with the total', async () => {
    const { store } = storeOf(); const o = createOutputStore(null);
    const { api, del } = apiOf(liveOk(), (id) => dto(id === 'w1' ? { steps: 5, assignments: 3 } : { steps: 4, assignments: 1 }));
    const p = await prepareDelete(api, store, o, ['w1', 'w2', 'n1'], () => never);
    expect(del).toHaveBeenCalledTimes(2);
    expect(p!.neverSaved).toEqual(['n1']);
    expect(confirmText(p!)).toBe('9 steps, 4 assignments go. Delete 3 workflows?');
  });
});

describe('commitDelete', () => {
  it('applied removes the workflow and says what went', async () => {
    const { store, remove } = storeOf(); const o = createOutputStore(null);
    const { api, del } = apiOf(liveOk(), () => dto({ applied: true, steps: 5, assignments: 3 }));
    expect(await commitDelete(api, store, o, plan({ steps: 5, assignments: 3 }))).toEqual(['w1']);
    expect(del).toHaveBeenCalledWith('w1', false);
    expect(remove).toHaveBeenCalledWith('w1');
    expect(texts(o)).toEqual([['ok', 'orders deleted: 5 steps, 3 assignments']]);
  });
  it('not applied keeps the frame and logs the errors', async () => {
    const { store, remove } = storeOf(); const o = createOutputStore(null);
    const { api } = apiOf(liveOk(), () => dto({ applied: false, errors: [{ message: 'it started running' }] as never }));
    expect(await commitDelete(api, store, o, plan({}))).toEqual([]);
    expect(remove).not.toHaveBeenCalled();
    expect(texts(o)).toEqual([['error', 'orders: not deleted — it started running']]);
  });
  it('a failed request keeps the frame', async () => {
    const { store, remove } = storeOf(); const o = createOutputStore(null);
    const { api } = apiOf(liveOk(), () => ({ ok: false, error: { kind: 'network', message: 'down' } }));
    expect(await commitDelete(api, store, o, plan({}))).toEqual([]);
    expect(remove).not.toHaveBeenCalled();
    expect(texts(o)).toEqual([['error', 'orders: not deleted — Network error: down']]);
  });
  it('a never-saved workflow is discarded without a request', async () => {
    const { store, remove } = storeOf(); const o = createOutputStore(null);
    const { api, del } = apiOf(liveOk(), () => dto({}));
    expect(await commitDelete(api, store, o, plan({ ids: ['n1'], names: ['new-workflow-1'], neverSaved: ['n1'] }))).toEqual(['n1']);
    expect(del).not.toHaveBeenCalled(); expect(remove).toHaveBeenCalledWith('n1');
    expect(texts(o)).toEqual([['ok', 'new-workflow-1 discarded']]);
  });
});

describe('delete while saving', () => {
  const real = (base: 'saved' | 'new') => {
    const output = createOutputStore(null, () => '00:00:00');
    const store = createBoardStore(output, null);
    store.load({ listed: true, workflows: base === 'saved' ? [bw('w1', ['a'])] : [], failures: [] }, []);
    if (base === 'new') store.addWorkflow(newWorkflowState('w1', 'new-workflow-1', { x: 0, y: 0 }));
    else store.edit('w1', (s) => moveStep(s, 'a', { x: 99, y: 99 }));
    let land: () => void = () => {};
    const api = {
      getGraph: vi.fn(async () => ({ ok: true, value: graphWith({ entry: ['a'], steps: { a: [] } }) })),
      saveDesign: vi.fn(() => new Promise((res) => { land = () => res({ ok: true, value: { applied: true, errors: [] } }); })),
      validateWorkflow: vi.fn().mockResolvedValue({ ok: true, value: { valid: true, problems: [] } }),
      publishDiagram: vi.fn().mockResolvedValue({ ok: true, value: null }),
      getStep: vi.fn(), getProcessor: vi.fn(), getEntity: vi.fn(),
      listLive: vi.fn().mockResolvedValue({ ok: true, value: [] }),
      deleteWorkflow: vi.fn().mockResolvedValue({ ok: true, value: { applied: true, errors: [] } }),
    } as unknown as StudioApi;
    return { api, store, output, land: () => land() };
  };
  it.each([['saved'], ['new']] as const)('a %s workflow that is saving is not deleted, and no delete is sent', async (base) => {
    const { api, store, output, land } = real(base);
    const saving = saveWorkflow(api, store, output, 'w1');
    await vi.waitFor(() => expect(api.saveDesign).toHaveBeenCalled());
    const name = store.entry('w1')!.history.present.fields.name;
    expect(await prepareDelete(api, store, output, ['w1'], () => never)).toBeNull();
    expect(texts(output)).toContainEqual(['error', `${name}: not deleted — it is saving, wait for it to finish`]);
    expect(api.listLive).not.toHaveBeenCalled(); expect(api.deleteWorkflow).not.toHaveBeenCalled();
    land();
    expect(await saving).toBe('saved');
    expect(store.entry('w1')).not.toBeNull();
  });
  it('a confirm reached while a save started is refused at commit too', async () => {
    const { api, store, output } = real('new');
    const p = await prepareDelete(api, store, output, ['w1'], () => never);
    void saveWorkflow(api, store, output, 'w1');
    await vi.waitFor(() => expect(api.saveDesign).toHaveBeenCalled());
    expect(await commitDelete(api, store, output, p!)).toEqual([]);
    expect(store.entry('w1')).not.toBeNull();
    expect(texts(output)).toContainEqual(['error', 'new-workflow-1: not deleted — it is saving, wait for it to finish']);
    expect(texts(output)).not.toContainEqual(['ok', 'new-workflow-1 discarded']);
  });
});
