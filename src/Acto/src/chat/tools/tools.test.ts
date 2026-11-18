import { afterEach, describe, expect, it, vi } from 'vitest';
import { moveItems } from '../../design/edits';
import { liveStub } from '../../test/liveStub';
import { call, done, setup } from './testContext';

afterEach(() => { vi.useRealTimers(); });

describe('reading tools', () => {
  it('list_workflows names each workflow with its state and what reaches it', async () => {
    const { ctx, store, live } = setup(liveStub());
    live.known(['daily']);
    store.edit((b) => moveItems(b, [{ ref: { kind: 'step', id: 'expand' }, at: { x: 5, y: 5 } }]));
    const rows = JSON.parse(done(await call(ctx, 'list_workflows')).result);
    expect(rows).toEqual([
      { id: 'daily', name: 'daily', version: '1.0.0', status: 'Running', unsaved: true, saved: true, steps: 2 },
      { id: 'hourly', name: 'hourly', version: '1.0.0', status: 'Stopped', unsaved: true, saved: true, steps: 2 },
    ]);
  });

  it('read_board gives the graph: steps, wires, caches and the triangles with entry steps, caches, cron, state and payloads', async () => {
    const { ctx } = setup();
    const d = JSON.parse(done(await call(ctx, 'read_board')).result);
    expect(d.steps.map((s: { id: string; next: string[] }) => [s.id, s.next])).toEqual([['fetch', ['expand']], ['expand', []], ['lonely', []]]);
    expect(d.steps[0].processor).toMatchObject({ id: 'p1', name: 'proc' });
    expect(d.caches).toEqual([{ id: 'c1', name: 'c1', version: '1.0.0', description: null, root: 'r', items: expect.any(String), at: { x: 0, y: -100 } }]);
    expect(d.steps[0]).toHaveProperty('description');
    const daily = d.workflows.find((w: { id: string }) => w.id === 'daily');
    expect(daily).toMatchObject({ entrySteps: ['fetch'], caches: ['c1'], cronExpression: null, unsaved: false, saved: true, steps: ['fetch', 'expand'] });
    expect(daily.payloads).toEqual([{ assignmentId: 'a-daily-fetch', name: 'fetch-assignment', version: '1.0.0', description: null, stepId: 'fetch', payload: '{}', sharedWith: [] }]);
  });

  it('read_output gives the newest lines', async () => {
    const { ctx, output } = setup();
    for (let i = 0; i < 30; i++) output.log(`line ${i}`);
    expect(JSON.parse(done(await call(ctx, 'read_output')).result)).toHaveLength(20);
  });
});

describe('workflow tools', () => {
  it('an unknown workflow_id fails naming it and calls nothing', async () => {
    const { ctx, api, focus } = setup();
    for (const tool of ['start', 'stop', 'delete_workflow', 'set_entry', 'link_cache', 'set_payload']) {
      expect(done(await call(ctx, tool, { workflow_id: 'ghost', step_id: 'fetch', cache_id: 'c1', payload: '{}' }))).toMatchObject({ ok: false, result: 'no workflow ghost on the board' });
    }
    expect(api.startWorkflow).not.toHaveBeenCalled();
    expect(api.applyModel).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });

  it('new_workflow makes an unsaved triangle at the free spot, logs the toolbox line; start on it is refused', async () => {
    const { ctx, store, output, focus, api } = setup();
    const o = done(await call(ctx, 'new_workflow'));
    expect(o.result).toContain('id n1');
    expect(store.state().workflows.n1).toMatchObject({ name: 'new-workflow-1', version: '1.0.0', cronExpression: null, at: { x: 700, y: 40 } });
    expect(output.lines().at(-1)).toMatchObject({ text: 'new-workflow-1 created — it is saved only when you press Save', level: 'ok' });
    expect(focus).toHaveBeenCalledWith('n1');
    expect(await call(ctx, 'start', { workflow_id: 'n1' })).toMatchObject({ kind: 'ask' });
    const s = done(await call(ctx, 'start', {}, 'Start', 'n1'));
    expect(s.ok).toBe(false);
    expect(s.result).toContain('new-workflow-1: not saved yet — BaseAPI has no such workflow');
    expect(api.startWorkflow).not.toHaveBeenCalled();
    expect(done(await call(ctx, 'new_workflow', { name: 'feed' })).result).toContain('workflow feed');
  });

  it('start asks first (user, 2026-11-18); Cancel sends nothing; Start sends the request and answers that it was accepted, not that it runs', async () => {
    vi.useFakeTimers();
    const { ctx, api, focus } = setup();
    expect(await call(ctx, 'start', { workflow_id: 'daily' })).toEqual({ kind: 'ask', question: { text: 'Start daily?', choices: ['Start', 'Cancel'], pin: 'daily' } });
    expect(done(await call(ctx, 'start', { workflow_id: 'daily' }, 'Cancel', 'daily'))).toMatchObject({ ok: false, result: 'the user declined' });
    expect(api.startWorkflow).not.toHaveBeenCalled();
    const o = done(await call(ctx, 'start', {}, 'Start', 'daily'));
    expect(o.ok).toBe(true);
    expect(api.startWorkflow).toHaveBeenCalledWith('daily');
    expect(o.result).toContain('not confirmed yet');
    expect(focus).toHaveBeenCalledWith('daily');
  });

  it('stop asks first; Stop sends it, Cancel sends nothing', async () => {
    vi.useFakeTimers();
    const { ctx, api } = setup();
    expect(await call(ctx, 'stop', { workflow_id: 'daily' })).toEqual({ kind: 'ask', question: { text: 'Stop daily?', choices: ['Stop', 'Cancel'], pin: 'daily' } });
    expect(done(await call(ctx, 'stop', { workflow_id: 'daily' }, 'Cancel', 'daily')).ok).toBe(false);
    expect(api.stopWorkflow).not.toHaveBeenCalled();
    expect(done(await call(ctx, 'stop', {}, 'Stop', 'daily')).ok).toBe(true);
    expect(api.stopWorkflow).toHaveBeenCalledWith('daily');
  });

  it('delete_workflow asks with the confirm text from the dry run; Cancel sends nothing, Delete deletes', async () => {
    const { ctx, api, store } = setup();
    const asked = await call(ctx, 'delete_workflow', { workflow_id: 'daily' });
    const text = 'Delete workflow daily, assignment fetch-assignment? Its steps and caches stay.';
    expect(asked).toMatchObject({ kind: 'ask', question: { text, choices: ['Delete', 'Cancel'], pin: JSON.stringify({ w: 'daily', text }) } });
    expect(api.validateModel).toHaveBeenCalledTimes(1);
    expect(api.applyModel).not.toHaveBeenCalled();
    expect(done(await call(ctx, 'delete_workflow', { workflow_id: 'daily' }, 'Cancel', JSON.stringify({ w: 'daily', text }))).ok).toBe(false);
    expect(store.state().workflows.daily).toBeDefined();
    const gone = done(await call(ctx, 'delete_workflow', {}, 'Delete', JSON.stringify({ w: 'daily', text })));
    expect(gone.ok).toBe(true);
    expect(api.applyModel).toHaveBeenCalledTimes(1);
    expect(store.state().workflows.daily).toBeUndefined();
    expect(store.state().steps.fetch).toBeDefined();
  });

  it('delete_workflow answered with a pin of the old shape (a bare id) asks again and deletes nothing', async () => {
    const { ctx, api, store } = setup();
    expect(await call(ctx, 'delete_workflow', {}, 'Delete', 'daily')).toMatchObject({ kind: 'ask' });
    expect(api.applyModel).not.toHaveBeenCalled();
    expect(store.state().workflows.daily).toBeDefined();
  });
});

describe('history tools', () => {
  it('undo and redo act on the one board history', async () => {
    const { ctx, store } = setup();
    expect(done(await call(ctx, 'undo')).ok).toBe(false);
    store.edit((b) => moveItems(b, [{ ref: { kind: 'step', id: 'expand' }, at: { x: 5, y: 5 } }]));
    expect(done(await call(ctx, 'undo')).ok).toBe(true);
    expect(store.state().steps.expand!.at).toEqual({ x: 400, y: 200 });
    expect(done(await call(ctx, 'redo')).ok).toBe(true);
    expect(store.state().steps.expand!.at).toEqual({ x: 5, y: 5 });
  });
});
