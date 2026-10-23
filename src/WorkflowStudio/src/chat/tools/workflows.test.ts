import { describe, expect, it, vi } from 'vitest';
import type { StudioApi } from '../../api/client';
import { graphDto, workflowDto } from '../../api/fixtures';
import { cancelDelete, commitDelete, prepareDelete } from '../../app/deleteWorkflow';
import { loadedDocument } from '../../app/fixtures';
import { createInspectorService } from '../../app/inspectorService';
import { runWorkflow } from '../../app/runWorkflow';
import { saveDesign } from '../../app/saveDesign';
import type { StudioCommands } from '../../app/studioCommands';
import { EMPTY_DRAFT } from '../../design/draft';
import { createStudioStore } from '../../store/studioStore';
import { runTool } from '../runTool';
import { DESTRUCTIVE, TOOLS } from '../tools';
import type { ToolContext, ToolOutcome } from '../toolTypes';

const ok = <T,>(value: T) => ({ ok: true, value }) as const;
const notFound = { ok: false, error: { kind: 'notFound', status: 404 } } as const;

async function setup(over: Record<string, unknown> = {}) {
  const store = createStudioStore();
  store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
  store.dispatch({ type: 'loaded', workflowId: 'wf1', doc: await loadedDocument(graphDto()) });
  const api = {
    listWorkflows: async () => ok([workflowDto({ id: 'wf1' })]),
    listLive: async () => ok([]),
    saveDesign: vi.fn().mockResolvedValue(ok({ applied: true, errors: [] })),
    getGraph: vi.fn().mockResolvedValue(ok(graphDto())),
    getStep: vi.fn().mockResolvedValue(notFound), getProcessor: vi.fn().mockResolvedValue(notFound), getSchema: vi.fn().mockResolvedValue(notFound),
    publishDiagram: vi.fn().mockResolvedValue(ok(null)),
    startWorkflow: vi.fn().mockResolvedValue(ok(null)),
    stopWorkflow: vi.fn().mockResolvedValue(ok(null)),
    deleteWorkflow: vi.fn(async (_: string, dry: boolean) => ok({ applied: !dry, dryRun: dry, steps: 2, assignments: 1, caches: 0, processors: 1, errors: [] })),
    ...over,
  } as unknown as StudioApi;
  // the page's commands, as App builds them, over the real save / run / delete code
  let deleting = false;
  const commands: StudioCommands = {
    listWorkflows: () => api.listWorkflows(),
    open: async () => 'ready',
    newWorkflow: async () => 'wfN',
    activate: (id) => store.dispatch({ type: 'activate', workflowId: id }),
    save: (id) => saveDesign(api, store, id),
    run: (id, op) => runWorkflow(api, store, id, op, () => 'unknown' as never, undefined, () => {}),
    prepareDelete: (id) => prepareDelete(api, store, id),
    commitDelete: async (plan) => { if (deleting) return false; deleting = true; try { return await commitDelete(api, store, plan); } finally { deleting = false; } },
    close: (id) => store.dispatch({ type: 'close', workflowId: id }),
  };
  const ctx: ToolContext = { store, api, service: createInspectorService(api, store), commands, newId: () => 'n' };
  // the question's pin is wf1 unless a test says otherwise (null: none)
  const call = (name: string, args: object = {}, answer?: string, pin: string | null = 'wf1') =>
    runTool(ctx, { id: 'c1', name, arguments: JSON.stringify(args) }, answer, pin ?? undefined);
  const dirty = () => store.dispatch({ type: 'design', workflowId: 'wf1', draft: { ...EMPTY_DRAFT, sphere: { x: 400, y: 400 } } });
  return { store, api, ctx, call, dirty, commands };
}
const done = (o: ToolOutcome) => { if (o.kind !== 'done') throw new Error('asked'); return o; };
const ask = (o: ToolOutcome) => { if (o.kind !== 'ask') throw new Error('done'); return o.question; };

describe('the workflow tools', () => {
  it('are offered, the irreversible ones destructive, and none draws', () => {
    const names = TOOLS.map((t) => t.function.name);
    expect(names).toEqual(expect.arrayContaining(['open_workflow', 'new_workflow', 'activate', 'save', 'start', 'stop', 'delete_workflow', 'close_workflow']));
    expect([...DESTRUCTIVE].sort()).toEqual(['close_workflow', 'delete_workflow', 'stop']);
    expect(names.some((n) => /draw|wand/.test(n))).toBe(false);
  });

  it('an unknown tool and bad or truncated arguments are failed results naming the problem', async () => {
    const { ctx } = await setup();
    expect(done(await runTool(ctx, { id: 'c', name: 'nope', arguments: '{}' }))).toMatchObject({ ok: false, result: expect.stringContaining('nope') });
    const bad = done(await runTool(ctx, { id: 'c', name: 'save', arguments: '{"workflow": "or' }));
    expect(bad.ok).toBe(false);
    expect(bad.result).toContain('not valid JSON');
  });

  it('save applied: says so and repeats the Output lines', async () => {
    const { call, dirty } = await setup();
    dirty();
    const r = done(await call('save'));
    expect(r).toMatchObject({ ok: true, action: 'saved orders 1.0.0' });
    expect(r.result).toContain('saved orders 1.0.0');
    expect(r.entries.filter((e) => e.kind === 'output').map((e) => e.kind === 'output' && e.text)).toContain('Saved and applied');
  });

  it('save against errors: not ok, the Save lines in red, a problems entry, the error texts to the model', async () => {
    const errors = [{ kind: 'step', id: 's1', stage: 'steps', field: 'version', message: 'version is not valid' }];
    const { call, dirty } = await setup({ saveDesign: vi.fn().mockResolvedValue(ok({ applied: false, errors })) });
    dirty();
    const r = done(await call('save'));
    expect(r.ok).toBe(false);
    expect(r.entries).toContainEqual(expect.objectContaining({ kind: 'output', level: 'error', text: 'Saved; not applied: 1 error' }));
    expect(r.entries.some((e) => e.kind === 'problems')).toBe(true);
    expect(r.result).toContain('[error] Saved; not applied: 1 error');
    expect(r.result).toContain('BaseApi · step s1: version: version is not valid');
    expect(r.result).toContain('version is not valid');
  });

  it('save with nothing to save is a failed result with the reason', async () => {
    const { call } = await setup();
    expect(done(await call('save'))).toMatchObject({ ok: false, result: 'not saved: Nothing changed since the last Save' });
  });

  it('start waits for the press to end and repeats the lines; a refusal is a failure', async () => {
    const { call, store } = await setup();
    // the liveness store's line, a moment after the press was accepted
    setTimeout(() => store.dispatch({ type: 'liveChanged', workflowId: 'wf1', name: 'orders', at: 'x', running: true }), 20);
    const r = done(await call('start'));
    expect(r).toMatchObject({ ok: true, action: 'started orders' });
    expect(r.result).toContain('Start accepted by BaseApi (202)');
    expect(r.result).toContain('running');
    expect(store.getState().docs[0]!.run).toBeNull();

    const refused = await setup({ startWorkflow: vi.fn().mockResolvedValue({ ok: false, error: { kind: 'http', status: 409, message: 'busy' } }) });
    const f = done(await refused.call('start'));
    expect(f.ok).toBe(false);
    expect(f.result).toContain('[error] Start refused by BaseApi');
  });

  it('stop asks first; No stops nothing; Yes stops', async () => {
    const { call, api, store } = await setup();
    expect(ask(await call('stop'))).toEqual({ text: 'Stop orders 1.0.0?', choices: ['Yes', 'No'], pin: 'wf1' });
    const no = done(await call('stop', {}, 'No'));
    expect(no).toMatchObject({ ok: false, result: 'the user declined', action: 'user declined: stop orders' });
    expect(api.stopWorkflow).not.toHaveBeenCalled();
    setTimeout(() => store.dispatch({ type: 'liveChanged', workflowId: 'wf1', name: 'orders', at: 'x', running: false }), 20);
    const yes = done(await call('stop', {}, 'Yes'));
    expect(yes).toMatchObject({ ok: true, action: 'stopped orders' });
    expect(api.stopWorkflow).toHaveBeenCalledWith('wf1');
  });

  it('delete_workflow asks with the dialog\'s warnings; Yes deletes it; No logs the cancel', async () => {
    const { call, store, api } = await setup();
    const q = ask(await call('delete_workflow', { workflow: 'orders' }));
    expect(q.choices).toEqual(['Yes', 'No']);
    expect(q.warnings?.[0]).toBe('Deleted for good: the workflow, 2 steps and 1 assignment. Its id is gone forever: nothing can address it again.');
    expect(q.warnings).toContain('Kept: 0 caches (only unlinked from it) and 1 processor (untouched).');

    const no = done(await call('delete_workflow', { workflow: 'orders' }, 'No'));
    expect(no).toMatchObject({ ok: false, result: expect.stringContaining('the user declined') });
    expect(no.result).toContain('Delete cancelled');
    expect(store.getState().docs).toHaveLength(1);

    ask(await call('delete_workflow', { workflow: 'orders' }));
    const yes = done(await call('delete_workflow', { workflow: 'orders' }, 'Yes'));
    expect(yes).toMatchObject({ ok: true, action: 'deleted workflow orders 1.0.0' });
    expect(yes.result).toContain('Delete requested');
    expect(yes.result).toContain('Deleted: the workflow');
    expect(store.getState().docs).toHaveLength(0);
    expect(api.deleteWorkflow).toHaveBeenLastCalledWith('wf1', false);
  });

  it('delete_workflow says so when a deletion of it is already running', async () => {
    const { call, commands } = await setup();
    ask(await call('delete_workflow', { workflow: 'orders' }));
    commands.commitDelete = async () => false;
    const r = done(await call('delete_workflow', { workflow: 'orders' }, 'Yes'));
    expect(r.ok).toBe(false);
    expect(r.result).toContain('a deletion of this workflow is already running');
  });

  it('close_workflow closes a clean document, and on a dirty one asks; Cancel keeps it open', async () => {
    const clean = await setup();
    expect(done(await clean.call('close_workflow'))).toMatchObject({ ok: true, action: 'closed orders 1.0.0' });
    expect(clean.store.getState().docs).toHaveLength(0);

    const { call, store, dirty } = await setup();
    dirty();
    expect(ask(await call('close_workflow')).choices).toEqual(['Save', 'Discard', 'Cancel']);
    expect(done(await call('close_workflow', {}, 'Cancel'))).toMatchObject({ ok: false, result: 'the user cancelled' });
    expect(store.getState().docs).toHaveLength(1);
    expect(done(await call('close_workflow', {}, 'Discard')).ok).toBe(true);
    expect(store.getState().docs).toHaveLength(0);
  });

  it('close_workflow with Save saves, then closes only if the save applied', async () => {
    const good = await setup();
    good.dirty();
    expect(done(await good.call('close_workflow', {}, 'Save')).ok).toBe(true);
    expect(good.store.getState().docs).toHaveLength(0);

    const errors = [{ kind: 'step', id: 's1', stage: 'steps', field: 'version', message: 'bad' }];
    const bad = await setup({ saveDesign: vi.fn().mockResolvedValue(ok({ applied: false, errors })) });
    bad.dirty();
    const r = done(await bad.call('close_workflow', {}, 'Save'));
    expect(r.ok).toBe(false);
    expect(r.result).toContain('not closed');
    expect(bad.store.getState().docs).toHaveLength(1);
  });

  it('a workflow that is not open is named as such', async () => {
    const { call } = await setup({ listWorkflows: async () => ok([workflowDto({ id: 'wf1' }), workflowDto({ id: 'wf9', name: 'other' })]) });
    expect(done(await call('save', { workflow: 'other' }))).toMatchObject({ ok: false, result: 'workflow other is not open; open it first' });
  });

  it('an answer acts on the workflow the question named, not the one active by then', async () => {
    for (const tool of ['stop', 'close_workflow', 'delete_workflow']) {
      const { call, store, api } = await setup();
      store.dispatch({ type: 'open', workflowId: 'wf2', name: 'other', version: '1.0.0' });
      store.dispatch({ type: 'loaded', workflowId: 'wf2', doc: await loadedDocument(graphDto()) });
      store.dispatch({ type: 'activate', workflowId: 'wf1' });
      if (tool === 'close_workflow') store.dispatch({ type: 'design', workflowId: 'wf1', draft: { ...EMPTY_DRAFT, sphere: { x: 400, y: 400 } } });
      const q = ask(await call(tool));
      expect(q.pin).toBe('wf1');
      store.dispatch({ type: 'activate', workflowId: 'wf2' });
      if (tool === 'stop') setTimeout(() => store.dispatch({ type: 'liveChanged', workflowId: 'wf1', name: 'orders', at: 'x', running: false }), 20);
      const r = done(await call(tool, {}, tool === 'close_workflow' ? 'Discard' : 'Yes', q.pin));
      if (tool === 'stop') expect(api.stopWorkflow).toHaveBeenCalledWith('wf1');
      else expect(store.getState().docs.map((d) => d.workflowId)).toEqual(['wf2']);
      expect(r.action).toContain('orders');
    }
  });

  it('an answer with no pin refuses and does nothing, whatever is active', async () => {
    const { call, store, api } = await setup();
    for (const [tool, answer] of [['stop', 'Yes'], ['close_workflow', 'Discard'], ['delete_workflow', 'Yes']] as const) {
      const r = done(await call(tool, {}, answer, null));
      expect(r.ok).toBe(false);
      expect(r.result).toContain('the question lost its workflow; nothing was done');
    }
    expect(api.stopWorkflow).not.toHaveBeenCalled();
    expect(api.deleteWorkflow).not.toHaveBeenCalled();
    expect(store.getState().docs).toHaveLength(1);
  });

  it('delete: No declines and logs the cancel even when the prepared plan was lost; Yes then asks again', async () => {
    const { call, store } = await setup();
    const no = done(await call('delete_workflow', { workflow: 'orders' }, 'No'));
    expect(no).toMatchObject({ ok: false, action: 'user declined: delete orders' });
    expect(no.result).toContain('Delete cancelled');
    expect(store.getState().docs).toHaveLength(1);
    expect(ask(await call('delete_workflow', { workflow: 'orders' }, 'Yes')).warnings).toBeDefined();
  });

  it('delete while another deletion holds it names that reason', async () => {
    const { call, commands } = await setup();
    commands.prepareDelete = async () => null;
    const r = done(await call('delete_workflow', { workflow: 'orders' }));
    expect(r).toMatchObject({ ok: false, result: expect.stringContaining('a deletion of this workflow is already in progress') });
  });

  it('new_workflow echoes the lines of the new workflow', async () => {
    const { call, commands, store } = await setup();
    commands.newWorkflow = async () => {
      store.dispatch({ type: 'open', workflowId: 'wfN', name: 'untitled', version: '1.0.0' });
      store.dispatch({ type: 'log', workflowId: 'wfN', lines: [{ at: 'x', text: 'made' }] });
      return 'wfN';
    };
    expect(done(await call('new_workflow')).entries).toContainEqual({ kind: 'output', text: 'made', level: 'info', name: 'untitled' });
  });

  it('cancelDelete is the one Cancel line the menu writes', async () => {
    const { store } = await setup();
    cancelDelete(store, 'wf1');
    expect(store.getState().output.at(-1)!.text).toMatch(/^Delete cancelled/);
  });
});
