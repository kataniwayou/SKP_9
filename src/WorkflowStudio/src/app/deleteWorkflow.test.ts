import { describe, expect, it, vi } from 'vitest';
import type { ApiResult, StudioApi } from '../api/client';
import { graphDto } from '../api/fixtures';
import type { WorkflowDeleteOutcomeDto } from '../api/types';
import { EMPTY_DRAFT } from '../design/draft';
import { createStudioStore } from '../store/studioStore';
import { cancelDelete, commitDelete, FRESH_READING_MS, prepareDelete } from './deleteWorkflow';
import { loadedDocument } from './fixtures';

const NOW = () => new Date('2026-10-10T09:00:00Z');
const WF = 'aaaaaaaa-0000-0000-0000-000000000001';
const never = () => new Promise<void>(() => {});

async function storeWithDoc() {
  const store = createStudioStore();
  store.dispatch({ type: 'open', workflowId: WF, name: 'orders', version: '1.0.0' });
  store.dispatch({ type: 'loaded', workflowId: WF, doc: await loadedDocument(graphDto()) });
  return store;
}
const outcome = (over: Partial<WorkflowDeleteOutcomeDto> = {}): ApiResult<WorkflowDeleteOutcomeDto> => ({
  ok: true,
  value: {
    applied: false, dryRun: true, steps: 3, assignments: 1, caches: 2, processors: 1, errors: [],
    log: [{ stage: 'outcome', level: 'info', kind: 'outcome', id: null, message: 'dry run passed', rolledBack: false }], ...over,
  },
});
const apiWith = (
  live: () => Promise<ApiResult<unknown>>,
  dry: ApiResult<WorkflowDeleteOutcomeDto> = outcome(),
  real: ApiResult<WorkflowDeleteOutcomeDto> = outcome({ applied: true, dryRun: false }),
) => {
  const deleteWorkflow = vi.fn((_: string, dryRun: boolean) => Promise.resolve(dryRun ? dry : real));
  const listLive = vi.fn(live);
  return { api: { listLive, deleteWorkflow } as unknown as StudioApi, deleteWorkflow, listLive };
};
const reads = (value: unknown) => () => Promise.resolve<ApiResult<unknown>>({ ok: true, value });
const texts = (store: ReturnType<typeof createStudioStore>) => store.getState().output.map((l) => [l.level, l.text, l.name]);

describe('Workspace › Delete workflow… (the user\'s rules, 2026-10-10)', () => {
  it('a fresh reading saying not running, then a clean dry run: the plan with the dry run\'s counts; nothing destructive sent', async () => {
    const store = await storeWithDoc();
    const { api, deleteWorkflow, listLive } = apiWith(reads([]));
    const plan = await prepareDelete(api, store, WF, { now: NOW, wait: never });
    expect(plan).toEqual({ workflowId: WF, name: 'orders', steps: 3, assignments: 1, caches: 2, processors: 1, dropsDraft: false });
    expect(listLive).toHaveBeenCalledTimes(1);
    expect(deleteWorkflow.mock.calls).toEqual([[WF, true]]);
    expect(texts(store)).toEqual([
      ['info', 'Delete requested: reading the live set now (a reading from before the request does not count)', 'orders'],
      ['info', 'Live set read now: not running. Dry run: BaseApi deletes it in a transaction and rolls back', 'orders'],
      ['info', 'BaseApi · dry run passed', 'orders'],
    ]);
  });

  it('running in the fresh reading: refused in red, no dry run', async () => {
    const store = await storeWithDoc();
    const { api, deleteWorkflow } = apiWith(reads([WF.toUpperCase()]));
    expect(await prepareDelete(api, store, WF, { now: NOW, wait: never })).toBeNull();
    expect(deleteWorkflow).not.toHaveBeenCalled();
    expect(texts(store).at(-1)).toEqual(['error', 'Not deleted: it is running. Stop it first: deleted while running, it could never be stopped', 'orders']);
  });

  it('no fresh reading in time, or an unreadable one: it cannot be proven stopped, refused', async () => {
    const slow = await storeWithDoc();
    const hanging = apiWith(() => new Promise<ApiResult<unknown>>(() => {}));
    const wait = vi.fn(() => Promise.resolve());
    expect(await prepareDelete(hanging.api, slow, WF, { now: NOW, wait })).toBeNull();
    expect(wait).toHaveBeenCalledWith(FRESH_READING_MS);
    expect(texts(slow).at(-1)![1]).toBe('Not deleted: could not confirm it is stopped (no liveness reading within 5 s)');
    expect(hanging.deleteWorkflow).not.toHaveBeenCalled();

    const failed = await storeWithDoc();
    const down = apiWith(() => Promise.resolve<ApiResult<unknown>>({ ok: false, error: { kind: 'network', message: 'down' } }));
    expect(await prepareDelete(down.api, failed, WF, { now: NOW, wait: never })).toBeNull();
    expect(texts(failed).at(-1)![0]).toBe('error');
    expect(texts(failed).at(-1)![1]).toMatch(/^Not deleted: could not confirm it is stopped/);
    expect(down.deleteWorkflow).not.toHaveBeenCalled();
  });

  it('a dry run with errors: its lines, then refused in red; no warning', async () => {
    const store = await storeWithDoc();
    const { api } = apiWith(reads([]), outcome({ errors: [{ kind: 'step', id: 's1', stage: 'delete', field: null, message: 'not deleted: used' }] }));
    expect(await prepareDelete(api, store, WF, { now: NOW, wait: never })).toBeNull();
    expect(texts(store).at(-1)).toEqual(['error', 'Not deleted: the dry run found 1 error', 'orders']);
  });

  it('a draft not saved: the plan says it is dropped', async () => {
    const store = await storeWithDoc();
    store.dispatch({ type: 'design', workflowId: WF, draft: { ...EMPTY_DRAFT, sphere: { x: 400, y: 400 } } });
    const { api } = apiWith(reads([]));
    expect((await prepareDelete(api, store, WF, { now: NOW, wait: never }))!.dropsDraft).toBe(true);
  });

  it('Cancel sends nothing and leaves the document; Continue deletes: the document closes, Output keeps the lines by name', async () => {
    const store = await storeWithDoc();
    const { api, deleteWorkflow } = apiWith(reads([]));
    const plan = (await prepareDelete(api, store, WF, { now: NOW, wait: never }))!;
    cancelDelete(store, WF, NOW);
    expect(deleteWorkflow).toHaveBeenCalledTimes(1);
    expect(store.getState().docs.map((d) => d.workflowId)).toEqual([WF]);
    expect(texts(store).at(-1)![1]).toBe('Delete cancelled: nothing was sent; the workflow is as it was');

    expect(await commitDelete(api, store, plan, NOW)).toBe(true);
    expect(deleteWorkflow.mock.calls).toEqual([[WF, true], [WF, false]]);
    expect(store.getState().docs).toEqual([]);
    expect(store.getState().activeId).toBeNull();
    expect(texts(store).slice(-2)).toEqual([
      ['info', 'BaseApi · dry run passed', 'orders'],
      ['info', 'Deleted: the workflow, 3 steps and 1 assignment; its id is gone for good', 'orders'],
    ]);
  });

  it('Continue refused by the real run (it started meanwhile): red lines, the document stays', async () => {
    const store = await storeWithDoc();
    const refused = outcome({
      applied: false, dryRun: false, errors: [{ kind: 'workflow', id: WF, stage: 'liveness', field: null, message: 'running: stop it first.' }],
      log: [{ stage: 'liveness', level: 'error', kind: 'workflow', id: WF, message: "workflow 'orders': running: stop it first.", rolledBack: false }],
    });
    const { api } = apiWith(reads([]), outcome(), refused);
    const plan = (await prepareDelete(api, store, WF, { now: NOW, wait: never }))!;
    expect(await commitDelete(api, store, plan, NOW)).toBe(false);
    expect(store.getState().docs.map((d) => d.workflowId)).toEqual([WF]);
    expect(texts(store).slice(-2)).toEqual([
      ['error', "BaseApi · workflow 'orders': running: stop it first.", 'orders'],
      ['error', 'Not deleted: 1 error', 'orders'],
    ]);
  });
});
