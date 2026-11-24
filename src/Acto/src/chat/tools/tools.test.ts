import { afterEach, describe, expect, it, vi } from 'vitest';
import { moveItems, setEntryCron } from '../../design/edits';
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
    expect(daily).toMatchObject({ entrySteps: [{ id: 'fetch', cron: null }], caches: ['c1'], cronExpression: null, unsaved: false, saved: true, steps: ['fetch', 'expand'] });
    expect(daily.payloads).toEqual([{ assignmentId: 'a-daily-fetch', name: 'fetch-assignment', version: '1.0.0', description: null, stepId: 'fetch', payload: '{}', sharedWith: [] }]);
  });

  it('readBoardShowsEntryCrons', async () => {
    const { ctx, store } = setup();
    store.edit((b) => setEntryCron(b, 'daily', 'fetch', '*/10 * * * * *'));
    const d = JSON.parse(done(await call(ctx, 'read_board')).result);
    expect(d.workflows.find((w: { id: string }) => w.id === 'daily').entrySteps).toEqual([{ id: 'fetch', cron: '*/10 * * * * *' }]);
    expect(d.workflows.find((w: { id: string }) => w.id === 'hourly').entrySteps).toEqual([{ id: 'fetch', cron: null }]);
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
    expect(store.state().workflows.n1).toMatchObject({ name: 'untitled', version: '1.0.0', cronExpression: null, at: { x: 700, y: 40 } });
    expect(output.lines().at(-1)).toMatchObject({ text: 'untitled created — it is saved only when you press Save', level: 'ok' });
    expect(focus).toHaveBeenCalledWith('n1');
    // refused before the question: a never-saved workflow cannot be started [user, 2026-11-23 rev 2]
    const s = done(await call(ctx, 'start', { workflow_id: 'n1' }));
    expect(s.ok).toBe(false);
    expect(s.result).toContain('untitled was never saved: save it first');
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

  it('delete_workflow asks, then makes the workflow a ghost: nothing is sent, its steps stay, Undo brings it back [user, 2026-11-23]', async () => {
    const live = liveStub();
    live.known([]);
    const { ctx, api, store } = setup(live);
    const asked = await call(ctx, 'delete_workflow', { workflow_id: 'daily' });
    expect(asked).toMatchObject({ kind: 'ask', question: { text: 'Delete daily? It is a ghost until Save; its steps and caches stay.', choices: ['Delete', 'Cancel'], pin: 'daily' } });
    expect(done(await call(ctx, 'delete_workflow', { workflow_id: 'daily' }, 'Cancel', 'daily')).ok).toBe(false);
    expect(store.state().workflows.daily).toBeDefined();
    expect(done(await call(ctx, 'delete_workflow', {}, 'Delete', 'daily')).ok).toBe(true);
    expect(store.state().workflows.daily).toBeUndefined();
    expect(store.state().steps.fetch).toBeDefined();
    expect(api.applyModel).not.toHaveBeenCalled();
    expect(api.validateModel).not.toHaveBeenCalled();
    store.undo();
    expect(store.state().workflows.daily).toBeDefined();
  });

  it('delete_workflow refuses a running workflow and changes nothing', async () => {
    const live = liveStub();
    live.known(['daily']);
    const { ctx, store } = setup(live);
    const out = done(await call(ctx, 'delete_workflow', {}, 'Delete', 'daily'));
    expect(out.ok).toBe(false);
    expect(out.result).toContain('daily is running — stop it first');
    expect(store.state().workflows.daily).toBeDefined();
  });
});

describe('check_workflow (final review: Save no longer checks; this asks what a Start would refuse)', () => {
  it('answers every problem BaseAPI finds in the saved workflow, and refuses a never-saved one', async () => {
    const { ctx, api, store } = setup();
    api.validateWorkflow!.mockResolvedValue({ ok: true, value: { valid: false, problems: [{ gate: 'cycle', title: 'Workflow contains a cycle', detail: 'a -> a' }, { gate: 'missingPayload', title: 'Step has no payload its config schema requires', detail: 'handler' }] } });
    const out = done(await call(ctx, 'check_workflow', { workflow_id: 'daily' }));
    expect(out.ok).toBe(true);
    expect(api.validateWorkflow).toHaveBeenCalledWith('daily');
    expect(out.result).toContain('Workflow contains a cycle — a -> a');
    expect(out.result).toContain('Step has no payload its config schema requires — handler');
    store.edit((b) => ({ ...b, workflows: { ...b.workflows, fresh: { ...b.workflows.hourly!, id: 'fresh', name: 'fresh', updatedAt: null } } }));
    expect(done(await call(ctx, 'check_workflow', { workflow_id: 'fresh' })).result).toContain('fresh was never saved: save it first');
  });
});

describe('start of a never-saved workflow', () => {
  it('is refused before the question: save it first [user, 2026-11-23 rev 2]', async () => {
    const { ctx, api, store } = setup();
    store.edit((b) => ({ ...b, workflows: { ...b.workflows, fresh: { ...b.workflows.hourly!, id: 'fresh', name: 'fresh', updatedAt: null } } }));
    const out = done(await call(ctx, 'start', { workflow_id: 'fresh' }));
    expect(out.ok).toBe(false);
    expect(out.result).toContain('fresh was never saved: save it first');
    expect(api.startWorkflow).not.toHaveBeenCalled();
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
