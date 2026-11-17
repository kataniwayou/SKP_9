import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StudioApi } from '../../api/client';
import { fakeApi, graphWith } from '../../board/testApi';
import { createBoardStore } from '../../design/boardStore';
import { bwFull, proc } from '../../design/fixtures';
import { moveStep } from '../../design/state';
import { createOutputStore } from '../../output/outputStore';
import { liveStub } from '../../test/liveStub';
import { runTool } from '../runTool';
import type { ToolContext, ToolOutcome } from '../toolTypes';
import { edit } from './common';
import '../tools';

function setup(live: ReturnType<typeof liveStub> = liveStub()) {
  const output = createOutputStore(null, () => '00:00:00');
  const store = createBoardStore(output, null);
  store.load({ listed: true, workflows: [bwFull()], failures: [] }, [proc('p1', 'Analyst')]);
  const api = fakeApi({ graph: graphWith({ entry: ['a'], steps: { a: ['b'], b: [] } }) });
  Object.assign(api, {
    saveDesign: vi.fn().mockResolvedValue({ ok: true, value: { applied: true, errors: [] } }),
    validateWorkflow: vi.fn().mockResolvedValue({ ok: true, value: { valid: true, problems: [] } }),
    startWorkflow: vi.fn().mockResolvedValue({ ok: true, value: null }),
    stopWorkflow: vi.fn().mockResolvedValue({ ok: true, value: null }),
    listLive: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    deleteWorkflow: vi.fn().mockResolvedValue({ ok: true, value: { applied: true, errors: [], steps: 2, assignments: 1, caches: 0, processors: 0 } }),
  });
  let n = 0;
  const focus = vi.fn();
  const ctx: ToolContext = {
    store, api: api as StudioApi, output, live,
    commands: { focus, setPicks: vi.fn(), picks: () => [], newWorkflowAt: () => ({ x: 700, y: 40 }) },
    processors: () => [proc('p1', 'Analyst')], caches: () => [], session: null, newId: () => `n${++n}`,
  };
  return { ctx, live, api: api as unknown as Record<string, ReturnType<typeof vi.fn>>, store, output, focus };
}

const call = (ctx: ToolContext, name: string, args: object = {}, answer?: string, pin?: string) =>
  runTool(ctx, { id: 'c', name, arguments: JSON.stringify(args) }, answer, pin);
const done = (o: ToolOutcome) => { if (o.kind !== 'done') throw new Error('asked'); return o; };

afterEach(() => { vi.useRealTimers(); });

describe('reading tools', () => {
  it('list_workflows names each workflow with its state', async () => {
    const { ctx, store, live } = setup(liveStub());
    live.known(['w1']);
    store.edit('w1', (s) => moveStep(s, 'a', { x: 5, y: 5 }));
    const o = done(await call(ctx, 'list_workflows'));
    expect(JSON.parse(o.result)).toEqual([{ id: 'w1', name: 'orders', version: '1.0.0', status: 'Running', unsaved: true, saved: true, steps: 2 }]);
  });

  it('read_design gives roles derived from the wires', async () => {
    const { ctx } = setup();
    const o = done(await call(ctx, 'read_design', { workflow_id: 'w1' }));
    const d = JSON.parse(o.result);
    expect(d.steps.map((s: { id: string; role: string; next: string[] }) => [s.id, s.role, s.next])).toEqual([['a', 'first', ['b']], ['b', 'reached', []]]);
    expect(d.steps[0].processor).toMatchObject({ id: 'p1', health: 'checking…' });
    expect(d.caches).toHaveLength(1);
    expect(d.assignments).toHaveLength(1);
    expect(d.unsaved).toBe(false);
  });

  it('list_processors, list_caches carry health and fields; list_schemas needs the api', async () => {
    const { ctx, api, live } = setup();
    live.known([], { p1: true });
    expect(JSON.parse(done(await call(ctx, 'list_processors')).result)).toEqual([{ id: 'p1', name: 'Analyst', version: '1.0.0', health: 'live · 1 of 1 replica healthy' }]);
    expect(done(await call(ctx, 'list_caches')).ok).toBe(true);
    expect(done(await call(ctx, 'list_schemas')).ok).toBe(false);
    api.listSchemas = vi.fn().mockResolvedValue({ ok: true, value: [{ id: 's1', name: 'in', version: '2' }] });
    expect(JSON.parse(done(await call(ctx, 'list_schemas')).result)).toEqual([{ id: 's1', name: 'in', version: '2' }]);
  });

  it('read_entity reads the stored entity; read_output the newest lines', async () => {
    const { ctx, api, output } = setup();
    api.getEntity = vi.fn().mockResolvedValue({ ok: true, value: { id: 's1', name: 'fetch' } });
    expect(JSON.parse(done(await call(ctx, 'read_entity', { kind: 'step', id: 's1' })).result)).toEqual({ id: 's1', name: 'fetch' });
    expect(api.getEntity).toHaveBeenCalledWith('step', 's1');
    expect(done(await call(ctx, 'read_entity', { kind: 'bogus', id: 'x' })).ok).toBe(false);
    for (let i = 0; i < 30; i++) output.log(`line ${i}`);
    expect(JSON.parse(done(await call(ctx, 'read_output')).result)).toHaveLength(20);
    const three = JSON.parse(done(await call(ctx, 'read_output', { last: 3 })).result);
    expect(three.map((l: { text: string }) => l.text)).toEqual(['line 27', 'line 28', 'line 29']);
  });
});

describe('workflow tools', () => {
  it('an unknown workflow_id fails naming it and calls nothing (Review Focus 3)', async () => {
    const { ctx, api, focus } = setup();
    for (const tool of ['read_design', 'save', 'start', 'stop', 'delete_workflow']) {
      const o = done(await call(ctx, tool, { workflow_id: 'ghost' }));
      expect(o).toMatchObject({ ok: false, result: 'no workflow ghost on the board' });
    }
    expect(api.saveDesign).not.toHaveBeenCalled();
    expect(api.startWorkflow).not.toHaveBeenCalled();
    expect(api.deleteWorkflow).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });

  it('save saves and focuses the workflow', async () => {
    const { ctx, api, focus } = setup();
    const o = done(await call(ctx, 'save', { workflow_id: 'w1' }));
    expect(o.ok).toBe(true);
    expect(o.result).toContain('saved orders');
    expect(api.saveDesign).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledWith('w1');
  });

  it('save on a workflow another save holds fails with "<name> is already saving", and edits are refused naming the lock', async () => {
    const { ctx, api, store } = setup();
    let release!: (v: unknown) => void;
    api.saveDesign = vi.fn(() => new Promise((r) => { release = r; }));
    const first = call(ctx, 'save', { workflow_id: 'w1' });
    await vi.waitFor(() => expect(store.entry('w1')!.saving).toBe(true));
    const second = done(await call(ctx, 'save', { workflow_id: 'w1' }));
    expect(second.ok).toBe(false);
    expect(second.result).toContain('orders is already saving');
    // an edit while the save holds the workflow: a failed result, the store untouched (Review Focus 1)
    const before = store.entry('w1')!.history.present;
    const e = await edit(ctx, 'w1', (s) => moveStep(s, 'a', { x: 1, y: 1 }));
    expect(e).toMatchObject({ ok: false, result: 'orders is saving — wait for it to finish' });
    expect(store.entry('w1')!.history.present).toBe(before);
    release({ ok: true, value: { applied: false, errors: [] } });
    await first;
  });

  it('edit returns the store\'s refusal of a rule of its own, and the change when allowed', async () => {
    const { ctx, store } = setup();
    expect(await edit(ctx, 'w1', () => ({ refused: 'A step cannot wire to itself' }))).toMatchObject({ ok: false, result: 'A step cannot wire to itself' });
    const ok = await edit(ctx, 'w1', (s) => moveStep(s, 'a', { x: 9, y: 9 }), 'chat:x');
    expect(ok.ok).toBe(true);
    expect(store.entry('w1')!.unsaved).toBe(true);
    expect(await edit(ctx, 'ghost', (s) => s)).toMatchObject({ ok: false, result: 'no workflow ghost on the board' });
  });

  it('start on a never-saved workflow fails with the not-saved line', async () => {
    const { ctx, api } = setup();
    const id = 'n1';
    expect(done(await call(ctx, 'new_workflow')).result).toContain(`id ${id}`);
    const o = done(await call(ctx, 'start', { workflow_id: id }));
    expect(o.ok).toBe(false);
    expect(o.result).toContain('new-workflow-1: not saved yet — BaseAPI has no such workflow');
    expect(api.startWorkflow).not.toHaveBeenCalled();
  });

  it('start sends the request and answers that it was accepted, not that it runs', async () => {
    vi.useFakeTimers();
    const { ctx, api, focus } = setup();
    const o = done(await call(ctx, 'start', { workflow_id: 'w1' }));
    expect(o.ok).toBe(true);
    expect(api.startWorkflow).toHaveBeenCalledWith('w1');
    expect(o.result).toContain('not confirmed yet');
    expect(focus).toHaveBeenCalledWith('w1');
  });

  it('stop asks first; Stop sends it, Cancel sends nothing', async () => {
    vi.useFakeTimers();
    const { ctx, api } = setup();
    const asked = await call(ctx, 'stop', { workflow_id: 'w1' });
    expect(asked).toEqual({ kind: 'ask', question: { text: 'Stop orders?', choices: ['Stop', 'Cancel'], pin: 'w1' } });
    expect(api.stopWorkflow).not.toHaveBeenCalled();
    expect(done(await call(ctx, 'stop', { workflow_id: 'w1' }, 'Cancel', 'w1')).ok).toBe(false);
    expect(api.stopWorkflow).not.toHaveBeenCalled();
    expect(done(await call(ctx, 'stop', {}, 'Stop', 'w1')).ok).toBe(true);
    expect(api.stopWorkflow).toHaveBeenCalledWith('w1');
  });

  it('delete_workflow asks with the confirm text; Delete deletes, Cancel sends nothing', async () => {
    const { ctx, api, store, live } = setup();
    live.known([]);
    api.listLive = vi.fn().mockResolvedValue({ ok: true, value: [] });
    const asked = await call(ctx, 'delete_workflow', { workflow_id: 'w1' });
    expect(asked).toMatchObject({ kind: 'ask', question: { text: '2 steps, 1 assignment go. Delete orders?', choices: ['Delete', 'Cancel'], pin: 'w1' } });
    expect(api.deleteWorkflow).toHaveBeenCalledTimes(1); // the dry run only
    api.deleteWorkflow.mockClear(); api.listLive.mockClear();
    const declined = done(await call(ctx, 'delete_workflow', { workflow_id: 'w1' }, 'Cancel', 'w1'));
    expect(declined.ok).toBe(false);
    expect(api.deleteWorkflow).not.toHaveBeenCalled();
    expect(api.listLive).not.toHaveBeenCalled();
    expect(store.entry('w1')).not.toBeNull();
    const gone = done(await call(ctx, 'delete_workflow', {}, 'Delete', 'w1'));
    expect(gone.ok).toBe(true);
    expect(api.deleteWorkflow).toHaveBeenLastCalledWith('w1', false);
    expect(store.entry('w1')).toBeNull();
  });

  it('delete_workflow on a workflow that is saving is refused naming why, without asking', async () => {
    const { ctx, store } = setup();
    store.setSaving('w1', true);
    const o = done(await call(ctx, 'delete_workflow', { workflow_id: 'w1' }));
    expect(o).toMatchObject({ ok: false });
    expect(o.result).toContain('it is saving, wait for it to finish');
  });

  it('new_workflow places a frame, names it, logs the toolbox line and is then listed as unsaved', async () => {
    const { ctx, store, output, focus } = setup();
    const o = done(await call(ctx, 'new_workflow'));
    expect(o.ok).toBe(true);
    expect(o.result).toContain('id n1');
    expect(store.boards().find((b) => b.graph.workflow.id === 'n1')!.frame).toMatchObject({ x: 700, y: 40 });
    expect(output.lines().at(-1)).toMatchObject({ text: 'new-workflow-1 created — it is saved only when you press Save', level: 'ok' });
    expect(focus).toHaveBeenCalledWith('n1');
    const rows = JSON.parse(done(await call(ctx, 'list_workflows')).result);
    expect(rows.find((r: { id: string }) => r.id === 'n1')).toMatchObject({ name: 'new-workflow-1', unsaved: true, saved: false, steps: 0 });
    // the lowest free N; a given name wins
    expect(done(await call(ctx, 'new_workflow')).result).toContain('new-workflow-2');
    expect(done(await call(ctx, 'new_workflow', { name: 'feed' })).result).toContain('workflow feed');
  });
});
