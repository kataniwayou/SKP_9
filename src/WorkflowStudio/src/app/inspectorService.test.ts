import { describe, expect, it, vi } from 'vitest';
import type { ApiResult, StudioApi } from '../api/client';
import { assignmentDto, stepDto, workflowDto } from '../api/fixtures';
import { createStudioStore } from '../store/studioStore';
import { loadedDocument } from './fixtures';
import { createInspectorService } from './inspectorService';

const ok = <T,>(value: T): ApiResult<T> => ({ ok: true, value });
const flush = () => new Promise((r) => setTimeout(r, 0));

async function setup(api: Partial<StudioApi>) {
  const store = createStudioStore();
  store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
  store.dispatch({ type: 'loaded', workflowId: 'wf1', doc: await loadedDocument() });
  store.dispatch({ type: 'select', workflowId: 'wf1', selection: { kind: 'step', stepId: 's1' } });
  const afterWrite = vi.fn();
  const service = createInspectorService(api as StudioApi, store, afterWrite);
  const inspector = () => store.getState().docs[0]!.inspector;
  return { store, service, afterWrite, inspector };
}

describe('InspectorService', () => {
  it('reads the shown entity once, and not again while it is read', async () => {
    const getEntity = vi.fn().mockResolvedValue(ok(stepDto('s1', { name: 'fetch' })));
    const { service, inspector } = await setup({ getEntity });
    service.read('wf1');
    service.read('wf1');
    await flush();
    service.read('wf1');
    expect(getEntity).toHaveBeenCalledTimes(1);
    expect(inspector().saved?.dto).toMatchObject({ name: 'fetch' });
  });

  it('drops an answer for an entity the user has left (review focus 2)', async () => {
    let answer!: (r: ApiResult<unknown>) => void;
    const getEntity = vi.fn().mockReturnValueOnce(new Promise((r) => { answer = r; })).mockResolvedValue(ok({ id: 'p1' }));
    const { store, service, inspector } = await setup({ getEntity });
    service.read('wf1');
    store.dispatch({ type: 'drill', workflowId: 'wf1', target: { kind: 'processor', id: 'p1' } });
    answer(ok(stepDto('s1')));
    await flush();
    expect(inspector().saved).toBeNull();
  });

  it('says when the shown entity no longer exists', async () => {
    const { service, inspector } = await setup({ getEntity: vi.fn().mockResolvedValue({ ok: false, error: { kind: 'notFound', status: 404 } }) });
    service.read('wf1');
    await flush();
    expect(inspector().readError).toBe('This step no longer exists.');
  });

  it('saves from a fresh GET, so structure goes back as the server holds it now (review focus 3)', async () => {
    const getEntity = vi.fn()
      .mockResolvedValueOnce(ok(stepDto('s1', { nextStepIds: ['s2'] })))            // what the form was filled from
      .mockResolvedValueOnce(ok(stepDto('s1', { nextStepIds: ['s2', 's3'] })));     // what the server holds at save time
    const putEntity = vi.fn().mockResolvedValue(ok(stepDto('s1', { description: 'now', nextStepIds: ['s2', 's3'] })));
    const { store, service, afterWrite, inspector } = await setup({ getEntity, putEntity });
    service.read('wf1');
    await flush();
    store.dispatch({ type: 'edit', workflowId: 'wf1', key: 'description', text: 'now', saved: '' });

    expect(await service.save('wf1')).toBe(true);
    expect(putEntity).toHaveBeenCalledWith('step', 's1', {
      name: 'step-s1', version: '1.0.0', description: 'now', processorId: 'p1', nextStepIds: ['s2', 's3'], entryCondition: 1,
    });
    expect(inspector()).toMatchObject({ edits: {}, busy: false });
    expect(afterWrite).toHaveBeenCalledTimes(1);
  });

  it('nothing to save is a success that sends nothing', async () => {
    const putEntity = vi.fn();
    const { service } = await setup({ putEntity, getEntity: vi.fn() });
    expect(await service.save('wf1')).toBe(true);
    expect(putEntity).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: 'badRequest', status: 400, detail: 'Validation failed', errors: { Version: ['Version must be x.y.z.'], EntryStepIds: ['Needs an entry step.'] } },
      { fields: { version: ['Version must be x.y.z.'] }, banner: 'Not saved: Needs an entry step.' }],
    [{ kind: 'badRequest', status: 400, detail: 'Validation failed', errors: {} }, { fields: {}, banner: 'Not saved: Validation failed' }],
    [{ kind: 'conflict', status: 409, detail: 'Unique constraint violation: root already exists.', entity: null },
      { fields: {}, banner: 'Not saved: Unique constraint violation: root already exists.' }],
    [{ kind: 'notFound', status: 404 }, { fields: {}, banner: 'Not saved: this step no longer exists.' }],
    [{ kind: 'network', message: 'Failed to fetch' }, { fields: {}, banner: 'Not saved: BaseApi unreachable' }],
  ])('a failed save keeps the edits and says why (%o)', async (error, failure) => {
    const getEntity = vi.fn().mockResolvedValue(ok(stepDto('s1')));
    const { store, service, afterWrite, inspector } = await setup({ getEntity, putEntity: vi.fn().mockResolvedValue({ ok: false, error }) });
    store.dispatch({ type: 'edit', workflowId: 'wf1', key: 'version', text: 'abc', saved: '1.0.0' });
    expect(await service.save('wf1')).toBe(false);
    expect(inspector()).toMatchObject({ edits: { version: 'abc' }, busy: false, failure });
    expect(afterWrite).not.toHaveBeenCalled();
  });

  it('creates an assignment, then links it to the workflow it was read from', async () => {
    const created = assignmentDto('a9', { name: 'step-s1-assignment', stepId: 's1' });
    const createAssignment = vi.fn().mockResolvedValue(ok(created));
    const getEntity = vi.fn().mockResolvedValue(ok(workflowDto({ assignmentIds: ['a1'], entryStepIds: ['s1'] })));
    const putEntity = vi.fn().mockResolvedValue(ok(workflowDto({ assignmentIds: ['a1', 'a9'] })));
    const { store, service, afterWrite, inspector } = await setup({ createAssignment, getEntity, putEntity });
    store.dispatch({ type: 'drill', workflowId: 'wf1', target: { kind: 'newAssignment', stepId: 's1', stepName: 'step-s1' } });
    service.read('wf1');
    store.dispatch({ type: 'edit', workflowId: 'wf1', key: 'payload', text: '{"k":1}', saved: '{}' });

    expect(await service.create('wf1')).toBe(true);
    expect(createAssignment).toHaveBeenCalledWith({ name: 'step-s1-assignment', version: '1.0.0', description: null, stepId: 's1', payload: '{"k":1}' });
    expect(putEntity).toHaveBeenCalledWith('workflow', 'wf1', expect.objectContaining({ assignmentIds: ['a1', 'a9'], entryStepIds: ['s1'] }));
    expect(inspector().trail).toEqual([{ kind: 'assignment', id: 'a9', stepId: 's1' }]);
    expect(afterWrite).toHaveBeenCalledTimes(1);
  });

  it('reports an assignment that was created but not linked, and shows it', async () => {
    const { store, service, inspector } = await setup({
      createAssignment: vi.fn().mockResolvedValue(ok(assignmentDto('a9'))),
      getEntity: vi.fn().mockResolvedValue(ok(workflowDto())),
      putEntity: vi.fn().mockResolvedValue({ ok: false, error: { kind: 'network', message: 'down' } }),
    });
    store.dispatch({ type: 'drill', workflowId: 'wf1', target: { kind: 'newAssignment', stepId: 's1', stepName: 'step-s1' } });
    service.read('wf1');
    expect(await service.create('wf1')).toBe(false);
    expect(inspector().trail.at(-1)).toEqual({ kind: 'assignment', id: 'a9', stepId: 's1' });
    expect(inspector().failure?.banner).toBe('Created but not linked to this workflow: Network error: down');
  });

  it('unlinks the shown assignment from this workflow only, and goes back to its step', async () => {
    const putEntity = vi.fn().mockResolvedValue(ok(workflowDto({ assignmentIds: ['a2'] })));
    const { store, service, afterWrite, inspector } = await setup({
      getEntity: vi.fn().mockResolvedValue(ok(workflowDto({ assignmentIds: ['a1', 'a2'] }))), putEntity,
    });
    store.dispatch({ type: 'drill', workflowId: 'wf1', target: { kind: 'assignment', id: 'a1', stepId: 's1' } });
    expect(await service.unlink('wf1')).toBe(true);
    expect(putEntity).toHaveBeenCalledWith('workflow', 'wf1', expect.objectContaining({ assignmentIds: ['a2'] }));
    expect(inspector().trail).toEqual([]);
    expect(afterWrite).toHaveBeenCalledTimes(1);
  });

  it('a save that fails after the user drilled away leaves the shown entity without a failure', async () => {
    let answer!: (r: ApiResult<unknown>) => void;
    const getEntity = vi.fn().mockReturnValue(new Promise((r) => { answer = r; }));
    const { store, service, inspector } = await setup({ getEntity });
    store.dispatch({ type: 'edit', workflowId: 'wf1', key: 'version', text: 'abc', saved: '1.0.0' });
    const saving = service.save('wf1');
    store.dispatch({ type: 'drill', workflowId: 'wf1', target: { kind: 'processor', id: 'p1' } });
    answer({ ok: false, error: { kind: 'network', message: 'down' } });
    expect(await saving).toBe(false);
    expect(inspector().failure).toBeNull();
    expect(inspector().busy).toBe(false);
  });

  it('a second write while one is in flight is refused', async () => {
    const getEntity = vi.fn().mockReturnValue(new Promise(() => {}));
    const { store, service } = await setup({ getEntity });
    store.dispatch({ type: 'edit', workflowId: 'wf1', key: 'version', text: 'abc', saved: '1.0.0' });
    void service.save('wf1');
    expect(await service.save('wf1')).toBe(false);
    expect(await service.unlink('wf1')).toBe(false);
    expect(getEntity).toHaveBeenCalledTimes(1);
  });

  it('a save is not clean while text typed during it is left unsaved (final review 1)', async () => {
    let answer!: (r: ApiResult<unknown>) => void;
    const getEntity = vi.fn().mockResolvedValue(ok(stepDto('s1')));
    const putEntity = vi.fn().mockReturnValue(new Promise((r) => { answer = r; }));
    const { store, service, inspector } = await setup({ getEntity, putEntity });
    store.dispatch({ type: 'edit', workflowId: 'wf1', key: 'description', text: 'sent', saved: '' });
    const saving = service.save('wf1');
    await flush();
    store.dispatch({ type: 'edit', workflowId: 'wf1', key: 'name', text: 'typed meanwhile', saved: 'step-s1' });
    answer(ok(stepDto('s1', { description: 'sent' })));
    expect(await saving).toBe(false);
    expect(inspector()).toMatchObject({ edits: { name: 'typed meanwhile' }, busy: false, failure: null });
  });

  it('a create keeps the text typed while it was in flight, on the new assignment (final review 1)', async () => {
    let answer!: (r: ApiResult<unknown>) => void;
    const createAssignment = vi.fn().mockReturnValue(new Promise((r) => { answer = r; }));
    const { store, service, inspector } = await setup({
      createAssignment, getEntity: vi.fn().mockResolvedValue(ok(workflowDto())), putEntity: vi.fn().mockResolvedValue(ok(workflowDto())),
    });
    store.dispatch({ type: 'drill', workflowId: 'wf1', target: { kind: 'newAssignment', stepId: 's1', stepName: 'step-s1' } });
    service.read('wf1');
    store.dispatch({ type: 'edit', workflowId: 'wf1', key: 'payload', text: '{"k":1}', saved: '{}' });
    const creating = service.create('wf1');
    store.dispatch({ type: 'edit', workflowId: 'wf1', key: 'description', text: 'typed meanwhile', saved: '' });
    answer(ok(assignmentDto('a9', { stepId: 's1', payload: '{"k":1}' })));
    await creating;
    expect(inspector().trail).toEqual([{ kind: 'assignment', id: 'a9', stepId: 's1' }]);
    expect(inspector().edits).toEqual({ description: 'typed meanwhile' });
  });

  it('an unlink that lands after the user went elsewhere leaves that Inspector alone (final review 3)', async () => {
    let answer!: (r: ApiResult<unknown>) => void;
    const getEntity = vi.fn().mockReturnValue(new Promise((r) => { answer = r; }));
    const { store, service, inspector } = await setup({ getEntity, putEntity: vi.fn().mockResolvedValue(ok(workflowDto())) });
    store.dispatch({ type: 'drill', workflowId: 'wf1', target: { kind: 'assignment', id: 'a1', stepId: 's1' } });
    const unlinking = service.unlink('wf1');
    store.dispatch({ type: 'back', workflowId: 'wf1', depth: 0 });
    store.dispatch({ type: 'drill', workflowId: 'wf1', target: { kind: 'processor', id: 'p1' } });
    store.dispatch({ type: 'edit', workflowId: 'wf1', key: 'description', text: 'typed', saved: '' });
    answer(ok(workflowDto({ assignmentIds: ['a1'] })));
    expect(await unlinking).toBe(true);
    expect(inspector()).toMatchObject({ trail: [{ kind: 'processor', id: 'p1' }], edits: { description: 'typed' }, busy: false });
  });

  it('an unlink that lands after the user left and re-opened the same assignment keeps what was typed there', async () => {
    let answer!: (r: ApiResult<unknown>) => void;
    const putEntity = vi.fn().mockReturnValue(new Promise((r) => { answer = r; }));
    const { store, service, afterWrite, inspector } = await setup({
      getEntity: vi.fn().mockResolvedValue(ok(workflowDto({ assignmentIds: ['a1'] }))), putEntity,
    });
    store.dispatch({ type: 'drill', workflowId: 'wf1', target: { kind: 'assignment', id: 'a1', stepId: 's1' } });
    const unlinking = service.unlink('wf1');
    await flush();
    expect(putEntity).toHaveBeenCalledTimes(1);
    store.dispatch({ type: 'back', workflowId: 'wf1', depth: 0 });
    store.dispatch({ type: 'drill', workflowId: 'wf1', target: { kind: 'assignment', id: 'a1', stepId: 's1' } });
    store.dispatch({ type: 'edit', workflowId: 'wf1', key: 'description', text: 'typed', saved: '' });
    answer(ok(workflowDto({ assignmentIds: [] })));
    expect(await unlinking).toBe(true);
    expect(inspector()).toMatchObject({ trail: [{ kind: 'assignment', id: 'a1', stepId: 's1' }], edits: { description: 'typed' }, busy: false });
    expect(afterWrite).toHaveBeenCalledTimes(1);
  });

  it('after created, Save is refused until the link settles; a failed link still says so and keeps the typed text', async () => {
    let answer!: (r: ApiResult<unknown>) => void;
    const getEntity = vi.fn().mockReturnValue(new Promise((r) => { answer = r; }));
    const putEntity = vi.fn();
    const { store, service, afterWrite, inspector } = await setup({
      createAssignment: vi.fn().mockResolvedValue(ok(assignmentDto('a9', { stepId: 's1' }))), getEntity, putEntity,
    });
    store.dispatch({ type: 'drill', workflowId: 'wf1', target: { kind: 'newAssignment', stepId: 's1', stepName: 'step-s1' } });
    service.read('wf1');
    const creating = service.create('wf1');
    await flush();
    expect(inspector()).toMatchObject({ trail: [{ kind: 'assignment', id: 'a9', stepId: 's1' }], busy: true });
    store.dispatch({ type: 'edit', workflowId: 'wf1', key: 'description', text: 'typed', saved: '' });
    expect(await service.save('wf1')).toBe(false);
    expect(await service.unlink('wf1')).toBe(false);
    expect(getEntity).toHaveBeenCalledTimes(1);
    answer({ ok: false, error: { kind: 'network', message: 'down' } });
    expect(await creating).toBe(false);
    expect(putEntity).not.toHaveBeenCalled();
    expect(inspector()).toMatchObject({ busy: false, edits: { description: 'typed' }, failure: { banner: 'Created but not linked to this workflow: Network error: down' } });
    expect(afterWrite).toHaveBeenCalledTimes(1);
  });

  it('a create that links clears busy once the link is done', async () => {
    const { store, service, inspector } = await setup({
      createAssignment: vi.fn().mockResolvedValue(ok(assignmentDto('a9'))),
      getEntity: vi.fn().mockResolvedValue(ok(workflowDto())), putEntity: vi.fn().mockResolvedValue(ok(workflowDto({ assignmentIds: ['a9'] }))),
    });
    store.dispatch({ type: 'drill', workflowId: 'wf1', target: { kind: 'newAssignment', stepId: 's1', stepName: 'step-s1' } });
    service.read('wf1');
    expect(await service.create('wf1')).toBe(true);
    expect(inspector()).toMatchObject({ busy: false, failure: null });
  });

  it('an assignment answer without an id is a failure and links nothing', async () => {
    const putEntity = vi.fn();
    const { store, service, inspector } = await setup({
      createAssignment: vi.fn().mockResolvedValue(ok({ ...assignmentDto('a9'), id: undefined })),
      getEntity: vi.fn().mockResolvedValue(ok(workflowDto())), putEntity,
    });
    store.dispatch({ type: 'drill', workflowId: 'wf1', target: { kind: 'newAssignment', stepId: 's1', stepName: 'step-s1' } });
    service.read('wf1');
    expect(await service.create('wf1')).toBe(false);
    expect(putEntity).not.toHaveBeenCalled();
    expect(inspector().failure?.banner).toBe('Not saved: BaseApi returned no id for the new assignment');
  });
});
