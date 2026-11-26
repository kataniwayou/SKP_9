import { withPicks } from '../../board/selection';
import { describe, expect, it, vi } from 'vitest';
import { createGhostStore } from '../../design/ghosts';
import { schemaBoard, shared } from '../../design/boardFixtures';
import { moveItems } from '../../design/edits';
import { liveStub } from '../../test/liveStub';
import { call, done, setup } from './testContext';

describe('graph edit tools', () => {
  it('add_step makes one unsaved step of the named processor, one history step; an unknown processor fails naming it', async () => {
    const { ctx, store } = setup();
    expect(done(await call(ctx, 'add_step', { processor_id: 'p1' }))).toMatchObject({ ok: true, result: expect.stringContaining('id n1') });
    expect(store.state().steps.n1).toMatchObject({ name: 'proc', processorId: 'p1', updatedAt: null, nextStepIds: [] });
    store.undo();
    expect(store.state().steps.n1).toBeUndefined();
    expect(done(await call(ctx, 'add_step', { processor_id: 'ghost' }))).toMatchObject({ ok: false, result: 'no processor ghost' });
  });

  it('add_step with x and y puts the step there; add_cache makes cache', async () => {
    const { ctx, store } = setup();
    await call(ctx, 'add_step', { processor_id: 'p1', name: 'mine', x: 1000, y: 1000 });
    expect(store.state().steps.n1).toMatchObject({ name: 'mine', at: { x: 1000, y: 1000 } });
    expect(done(await call(ctx, 'add_cache')).result).toContain('cache');
    expect(store.state().caches.n2).toMatchObject({ name: 'cache', version: '1.0.0' });
  });

  it('connect wires; a duplicate is the edit\'s own refusal; an unknown id fails naming it; disconnect removes', async () => {
    const { ctx, store, output } = setup();
    expect(done(await call(ctx, 'connect', { from: 'expand', to: 'lonely' })).ok).toBe(true);
    expect(store.state().steps.expand!.nextStepIds).toEqual(['lonely']);
    expect(done(await call(ctx, 'connect', { from: 'expand', to: 'lonely' }))).toMatchObject({ ok: false, result: 'That wire already exists' });
    expect(output.lines().at(-1)).toMatchObject({ text: 'That wire already exists', level: 'warn' });
    expect(done(await call(ctx, 'connect', { from: 'expand', to: 'ghost' }))).toMatchObject({ ok: false, result: 'no step ghost on the board' });
    expect(done(await call(ctx, 'disconnect', { from: 'expand', to: 'lonely' })).ok).toBe(true);
    expect(store.state().steps.expand!.nextStepIds).toEqual([]);
    expect(done(await call(ctx, 'disconnect', { from: 'expand', to: 'lonely' })).ok).toBe(false);
  });

  it('setEntryCronSetsAndClears: one undoable edit per call', async () => {
    const { ctx, store } = setup();
    expect(done(await call(ctx, 'set_entry_cron', { workflow_id: 'daily', step_id: 'fetch', value: '*/10 * * * * *' })).ok).toBe(true);
    expect(store.state().workflows.daily!.entryCrons).toEqual({ fetch: '*/10 * * * * *' });
    store.undo();
    expect(store.state().workflows.daily!.entryCrons).toEqual({});
    store.redo();
    expect(done(await call(ctx, 'set_entry_cron', { workflow_id: 'daily', step_id: 'fetch', value: null })).ok).toBe(true);
    expect(store.state().workflows.daily!.entryCrons).toEqual({});
  });

  it('setEntryCronValidates: refuses unparseable and over-long, accepts 5- and 6-field, clears on blank', async () => {
    const { ctx, store } = setup();
    const bad = done(await call(ctx, 'set_entry_cron', { workflow_id: 'daily', step_id: 'fetch', value: 'every day' }));
    expect(bad.ok).toBe(false);
    expect(bad.result).toContain('A cron expression has 5 fields, or 6 with seconds first');
    expect(store.state().workflows.daily!.entryCrons).toEqual({});
    const long = done(await call(ctx, 'set_entry_cron', { workflow_id: 'daily', step_id: 'fetch', value: '*/5 * * * *' + ' '.repeat(110) }));
    expect(long.ok).toBe(false);
    expect(long.result).toContain('at most 120');
    expect(store.state().workflows.daily!.entryCrons).toEqual({});
    expect(done(await call(ctx, 'set_entry_cron', { workflow_id: 'daily', step_id: 'fetch', value: '*/10 * * * * *' })).ok).toBe(true);
    expect(done(await call(ctx, 'set_entry_cron', { workflow_id: 'daily', step_id: 'fetch', value: '0 9 * * 1' })).ok).toBe(true);
    expect(store.state().workflows.daily!.entryCrons).toEqual({ fetch: '0 9 * * 1' });
    expect(done(await call(ctx, 'set_entry_cron', { workflow_id: 'daily', step_id: 'fetch', value: '   ' })).ok).toBe(true);
    expect(store.state().workflows.daily!.entryCrons).toEqual({});
  });

  it('setEntryCronRefusesANonEntryStep', async () => {
    const { ctx, store } = setup();
    expect(done(await call(ctx, 'set_entry_cron', { workflow_id: 'daily', step_id: 'lonely', value: '* * * * * *' }))).toMatchObject({ ok: false, result: 'lonely is not an entry step of daily' });
    expect(store.state().workflows.daily!.entryCrons).toEqual({});
  });

  it('set_entry, remove_entry, link_cache and unlink_cache change the triangle', async () => {
    const { ctx, store } = setup();
    expect(done(await call(ctx, 'set_entry', { workflow_id: 'daily', step_id: 'lonely' })).ok).toBe(true);
    expect(store.state().workflows.daily!.entryStepIds).toEqual(['fetch', 'lonely']);
    expect(done(await call(ctx, 'set_entry', { workflow_id: 'daily', step_id: 'lonely' }))).toMatchObject({ ok: false, result: 'daily already starts at lonely' });
    expect(done(await call(ctx, 'remove_entry', { workflow_id: 'daily', step_id: 'lonely' })).ok).toBe(true);
    expect(done(await call(ctx, 'remove_entry', { workflow_id: 'daily', step_id: 'lonely' })).ok).toBe(false);
    expect(done(await call(ctx, 'link_cache', { workflow_id: 'hourly', cache_id: 'c1' })).ok).toBe(true);
    expect(done(await call(ctx, 'link_cache', { workflow_id: 'hourly', cache_id: 'c1' }))).toMatchObject({ ok: false, result: 'hourly already uses c1' });
    expect(done(await call(ctx, 'unlink_cache', { workflow_id: 'hourly', cache_id: 'c1' })).ok).toBe(true);
    expect(store.state().workflows.hourly!.cacheIds).toEqual([]);
    expect(done(await call(ctx, 'set_entry', { workflow_id: 'daily', step_id: 'ghost' })).result).toBe('no step ghost on the board');
    expect(done(await call(ctx, 'link_cache', { workflow_id: 'daily', cache_id: 'ghost' })).result).toBe('no cache ghost on the board');
  });

  it('set_processor changes a step\'s processor', async () => {
    const { ctx, store } = setup();
    expect(done(await call(ctx, 'set_processor', { step_id: 'lonely', processor_id: 'ghost' })).result).toBe('no processor ghost');
    expect(done(await call(ctx, 'set_processor', { step_id: 'ghost', processor_id: 'p1' })).result).toBe('no step ghost on the board');
    expect(done(await call(ctx, 'set_processor', { step_id: 'lonely', processor_id: 'p1' })).ok).toBe(true);
    expect(store.state().steps.lonely!.processorId).toBe('p1');
  });

  it('move_blocks moves steps, caches and triangles in one history step', async () => {
    const { ctx, store } = setup();
    const o = done(await call(ctx, 'move_blocks', { blocks: [{ kind: 'step', id: 'lonely', x: 1, y: 2 }, { kind: 'workflow', id: 'daily', x: 3, y: 4 }] }));
    expect(o.ok).toBe(true);
    expect(store.state().steps.lonely!.at).toEqual({ x: 1, y: 2 });
    expect(store.state().workflows.daily!.at).toEqual({ x: 3, y: 4 });
    store.undo();
    expect(store.state().steps.lonely!.at).toEqual({ x: 600, y: 200 });
    expect(done(await call(ctx, 'move_blocks', { blocks: [{ kind: 'step', id: 'ghost', x: 1, y: 2 }] })).result).toBe('no step ghost on the board');
  });
});

describe('field and payload tools', () => {
  it('set_field sets a field of each kind as the Inspector does, one undo step each; a bad field or id is named', async () => {
    const { ctx, store } = setup();
    expect(done(await call(ctx, 'set_field', { kind: 'workflow', id: 'daily', field: 'description', value: 'nightly' })).ok).toBe(true);
    expect(store.state().workflows.daily!.description).toBe('nightly');
    const refused = done(await call(ctx, 'set_field', { kind: 'workflow', id: 'daily', field: 'cronExpression', value: '0 * * * *' }));
    expect(refused.ok).toBe(false);
    expect(refused.result).toBe('a workflow has no field cronExpression: the fields are name, version, description');
    expect(done(await call(ctx, 'set_field', { kind: 'step', id: 'fetch', field: 'entryCondition', value: 2 })).ok).toBe(true);
    expect(store.state().steps.fetch!.entryCondition).toBe(2);
    expect(done(await call(ctx, 'set_field', { kind: 'cache', id: 'c1', field: 'root', value: 'x' })).ok).toBe(true);
    expect(store.state().caches.c1!.root).toBe('x');
    expect(done(await call(ctx, 'set_field', { kind: 'processor', id: 'p1', field: 'version', value: '2.0.0' })).ok).toBe(true);
    expect(store.state().processors.p1!.version).toBe('2.0.0');
    store.undo();
    expect(store.state().processors.p1!.version).toBe('1.0.0');
    expect(store.state().caches.c1!.root).toBe('x');
    expect(done(await call(ctx, 'set_field', { kind: 'step', id: 'fetch', field: 'colour', value: 'x' })).result).toContain('name, version, description, entryCondition');
    expect(done(await call(ctx, 'set_field', { kind: 'step', id: 'ghost', field: 'name', value: 'x' })).result).toBe('no step ghost on the board');
    expect(done(await call(ctx, 'set_field', { kind: 'step', id: 'fetch', field: 'entryCondition', value: 9 })).ok).toBe(false);
  });

  it('set_payload sets this workflow\'s payload in place; on a shared row it copies for this workflow only', async () => {
    const { ctx, store } = setup();
    expect(done(await call(ctx, 'set_payload', { workflow_id: 'daily', step_id: 'fetch', payload: '{"a":1}' })).ok).toBe(true);
    expect(store.state().assignments['a-daily-fetch']!.payload).toBe('{"a":1}');
    const sh = setup();
    sh.store.load(shared());
    expect(done(await call(sh.ctx, 'set_payload', { workflow_id: 'daily', step_id: 'fetch', payload: '{"d":1}' })).ok).toBe(true);
    const b = sh.store.state();
    expect(b.assignments['a-shared']!.payload).toBe('{"shared":true}');
    expect(b.workflows.daily!.assignmentIds).toEqual(['n1']);
    expect(b.workflows.hourly!.assignmentIds).toEqual(['a-shared']);
    expect(done(await call(sh.ctx, 'set_payload', { workflow_id: 'daily', step_id: 'ghost', payload: '{}' })).result).toBe('no step ghost on the board');
  });

  it('set_payload without payload lays a new one out from the config schema, as ＋ Create [user, 2026-11-19]; never over an existing one', async () => {
    const { ctx, store } = setup();
    const b0 = store.state();
    const def = JSON.stringify({ type: 'object', required: ['topic'], properties: { topic: { type: 'string' }, acks: { type: 'string', default: 'all' } } });
    store.load({ ...b0, processors: { ...b0.processors, p1: { ...b0.processors.p1!, configSchemaId: 's1' } },
      schemas: { s1: { id: 's1', name: 'cfg', version: '1.0.0', description: null, definition: def, audit: { createdAt: '', createdBy: null, updatedAt: '', updatedBy: null }, at: null, updatedAt: 'x' } } });
    // expand: daily reaches it, has no payload there yet
    const r = done(await call(ctx, 'set_payload', { workflow_id: 'daily', step_id: 'expand' }));
    const laidOut = JSON.stringify({ topic: '<string>', acks: 'all' }, null, 2);
    expect(r).toMatchObject({ ok: true, result: expect.stringContaining(laidOut) });
    expect(r.result).toContain('fill the "<type>" placeholders');
    const made = store.state().assignments[store.state().workflows.daily!.assignmentIds.at(-1)!]!;
    expect(made).toMatchObject({ stepId: 'expand', name: 'expand-assignment', payload: laidOut });
    // a payload already there is not replaced by a laid-out one
    const before = store.state();
    expect(done(await call(ctx, 'set_payload', { workflow_id: 'daily', step_id: 'fetch' }))).toMatchObject({
      ok: false, result: 'daily on step fetch-orders already has a payload: give `payload` to change it' });
    expect(store.state()).toBe(before);
  });

  it('set_payload without payload on a step whose processor has no config schema makes {}', async () => {
    const { ctx, store } = setup();
    expect(done(await call(ctx, 'set_payload', { workflow_id: 'daily', step_id: 'expand' })).result).toContain('laid out from its config schema: {}');
    expect(store.state().assignments[store.state().workflows.daily!.assignmentIds.at(-1)!]!.payload).toBe('{}');
  });

  it('remove_assignment asks first and pins the workflow and the assignment; Cancel does nothing, Remove unlinks', async () => {
    const { ctx, store } = setup();
    const asked = await call(ctx, 'remove_assignment', { workflow_id: 'daily', assignment_id: 'a-daily-fetch' });
    expect(asked).toMatchObject({ kind: 'ask', question: { choices: ['Remove', 'Cancel'] } });
    const pin = (asked as { question: { pin: string } }).question.pin;
    expect(JSON.parse(pin)).toEqual({ w: 'daily', a: 'a-daily-fetch' });
    expect(done(await call(ctx, 'remove_assignment', {}, 'Cancel', pin)).ok).toBe(false);
    expect(store.state().assignments['a-daily-fetch']).toBeDefined();
    // the pin wins over what the arguments say now
    expect(done(await call(ctx, 'remove_assignment', { workflow_id: 'hourly', assignment_id: 'a-hourly-fetch' }, 'Remove', pin)).ok).toBe(true);
    expect(store.state().workflows.daily!.assignmentIds).toEqual([]);
    expect(store.state().workflows.hourly!.assignmentIds).toEqual(['a-hourly-fetch']);
    expect(done(await call(ctx, 'remove_assignment', { workflow_id: 'daily', assignment_id: 'nope' })).result).toBe('workflow daily has no assignment nope');
  });
});

describe('picks, clipboard and delete_picked', () => {
  it('pick sets the page\'s picks; a triangle may be mixed in; a thing that is not there fails naming it', async () => {
    const { ctx } = setup();
    expect(done(await call(ctx, 'pick', { items: [{ kind: 'step', id: 'fetch' }, { kind: 'wire', from: 'fetch', to: 'expand' }, { kind: 'entry', workflow_id: 'daily', step_id: 'fetch' }] })).ok).toBe(true);
    expect(ctx.commands.picks()).toEqual([{ kind: 'step', id: 'fetch' }, { kind: 'wire', from: 'fetch', to: 'expand' }, { kind: 'entry', workflowId: 'daily', stepId: 'fetch' }]);
    expect(done(await call(ctx, 'pick', { items: [{ kind: 'workflow', id: 'daily' }, { kind: 'step', id: 'fetch' }] })).ok).toBe(true);
    expect(done(await call(ctx, 'pick', { items: [{ kind: 'workflow', id: 'daily' }] })).ok).toBe(true);
    expect(done(await call(ctx, 'pick', { items: [{ kind: 'wire', from: 'expand', to: 'fetch' }] })).result).toBe('no wire expand > fetch on the board');
    expect(done(await call(ctx, 'pick', { items: [{ kind: 'step', id: 'ghost' }] })).result).toBe('no step ghost on the board');
    expect(done(await call(ctx, 'pick', { items: [] })).ok).toBe(true);
    expect(ctx.commands.picks()).toEqual([]);
  });

  it('copy and paste: pasted steps are new, unsaved, one history step, and picked', async () => {
    const { ctx, store } = setup();
    expect(done(await call(ctx, 'paste')).ok).toBe(false);
    expect(done(await call(ctx, 'copy', { step_ids: ['ghost'] })).result).toBe('no step ghost on the board');
    expect(done(await call(ctx, 'copy', { step_ids: ['fetch', 'expand'] })).ok).toBe(true);
    expect(done(await call(ctx, 'paste')).ok).toBe(true);
    const made = Object.values(store.state().steps).filter((s) => s.updatedAt === null);
    expect(made.map((s) => s.name).sort()).toEqual(['expand-2', 'fetch-orders-2']);
    expect(ctx.commands.picks()).toEqual(made.map((s) => ({ kind: 'step', id: s.id })));
    store.undo();
    expect(Object.keys(store.state().steps)).toHaveLength(3);
  });

  it('copy and paste of a workflow and a cache: every field but the name; links among the copies join them', async () => {
    const { ctx, store } = setup();
    expect(done(await call(ctx, 'copy', { cache_ids: ['ghost'] })).result).toBe('no cache ghost on the board');
    expect(done(await call(ctx, 'copy', { workflow_ids: ['daily'], cache_ids: ['c1'] })).result).toBe('Copied 1 workflow and 1 cache');
    const out = done(await call(ctx, 'paste'));
    expect(out.result).toBe('pasted 1 workflow and 1 cache: cache c1-2, workflow daily-2; they are picked and not saved yet');
    const s = store.state();
    const wf = Object.values(s.workflows).find((w) => w.name === 'daily-2')!;
    const c = Object.values(s.caches).find((x) => x.name === 'c1-2')!;
    expect(wf).toMatchObject({ entryStepIds: ['fetch'], cacheIds: [c.id], assignmentIds: s.workflows.daily!.assignmentIds, updatedAt: null });
    expect(ctx.commands.picks()).toEqual([{ kind: 'cache', id: c.id }, { kind: 'workflow', id: wf.id }]);
  });

  it('copy without ids copies the picked triangles, steps and caches', async () => {
    const { ctx, store } = setup();
    ctx.commands.setPicks([{ kind: 'workflow', id: 'hourly' }, { kind: 'cache', id: 'c1' }, { kind: 'wire', from: 'fetch', to: 'expand' }]);
    expect(done(await call(ctx, 'copy')).result).toBe('Copied 1 workflow and 1 cache');
    expect(done(await call(ctx, 'paste')).ok).toBe(true);
    expect(Object.values(store.state().workflows).map((w) => w.name)).toContain('hourly-2');
  });

  it('copy without step_ids copies the picked steps', async () => {
    const { ctx } = setup();
    ctx.commands.setPicks([{ kind: 'step', id: 'lonely' }]);
    expect(done(await call(ctx, 'copy')).ok).toBe(true);
    expect(done(await call(ctx, 'paste')).ok).toBe(true);
  });

  it('delete_picked asks first, pins exactly the picks it named, and deletes those in one history step', async () => {
    const { ctx, store } = setup();
    expect(done(await call(ctx, 'delete_picked')).ok).toBe(false);
    ctx.commands.setPicks([{ kind: 'step', id: 'lonely' }, { kind: 'wire', from: 'fetch', to: 'expand' }]);
    const asked = await call(ctx, 'delete_picked');
    expect(asked).toMatchObject({ kind: 'ask', question: { choices: ['Delete', 'Cancel'] } });
    const pin = (asked as { question: { pin: string } }).question.pin;
    expect(store.state().steps.lonely).toBeDefined();
    ctx.commands.setPicks([{ kind: 'step', id: 'expand' }]);   // the picks change after the question: the pin wins
    expect(done(await call(ctx, 'delete_picked', {}, 'Cancel', pin)).ok).toBe(false);
    expect(store.state().steps.lonely).toBeDefined();
    expect(done(await call(ctx, 'delete_picked', {}, 'Delete', pin)).ok).toBe(true);
    expect(store.state().steps.lonely).toBeUndefined();
    expect(store.state().steps.expand).toBeDefined();
    expect(store.state().steps.fetch!.nextStepIds).toEqual([]);
    store.undo();
    expect(store.state().steps.lonely).toBeDefined();
    expect(store.state().steps.fetch!.nextStepIds).toEqual(['expand']);
  });

  it('delete_picked takes a picked triangle with the rest, as one ghosting change; a running one stops it all [user, 2026-11-23]', async () => {
    const live = liveStub();
    live.known([]);
    const { ctx, store } = setup(live);
    ctx.commands.setPicks([{ kind: 'workflow', id: 'daily' }, { kind: 'step', id: 'lonely' }]);
    const asked = await call(ctx, 'delete_picked');
    expect(asked).toMatchObject({ kind: 'ask', question: { text: 'Delete 1 workflow, 1 step?' } });
    expect(done(await call(ctx, 'delete_picked', {}, 'Delete', (asked as { question: { pin: string } }).question.pin)).ok).toBe(true);
    expect(store.state().workflows.daily).toBeUndefined();
    expect(store.state().steps.lonely).toBeUndefined();
    store.undo();
    live.known(['daily']);
    ctx.commands.setPicks([{ kind: 'workflow', id: 'daily' }, { kind: 'step', id: 'lonely' }]);
    const out = done(await call(ctx, 'delete_picked')); // refused before the question is asked
    expect(out.ok).toBe(false);
    expect(out.result).toContain('daily is running — stop it first');
    expect(store.state().steps.lonely).toBeDefined();
  });
});

describe('save', () => {
  it('with nothing unsaved says so and asks nothing', async () => {
    const { ctx, api } = setup();
    expect(done(await call(ctx, 'save'))).toMatchObject({ ok: true, result: expect.stringContaining('nothing to save') });
    expect(api.applyModel).not.toHaveBeenCalled();
  });

  it('asks first with the number of changes; Cancel sends nothing; Save runs saveBoard and reports Output', async () => {
    const { ctx, store, api } = setup();
    store.edit((b) => moveItems(b, [{ ref: { kind: 'step', id: 'expand' }, at: { x: 5, y: 5 } }]));
    expect(await call(ctx, 'save')).toMatchObject({ kind: 'ask', question: { choices: ['Save', 'Cancel'], text: expect.stringContaining('1 change') } });
    expect(api.applyModel).not.toHaveBeenCalled();
    expect(done(await call(ctx, 'save', {}, 'Cancel')).ok).toBe(false);
    expect(api.applyModel).not.toHaveBeenCalled();
    const o = done(await call(ctx, 'save', {}, 'Save'));
    expect(api.applyModel).toHaveBeenCalledTimes(1);
    expect(o.result).toContain('Pushed 1 change');
  });

  it('gives the page ghost ghost store the made ids (the same remap as the Save button)', async () => {
    const { ctx, store, api } = setup();
    const remap = vi.fn();
    ctx.ghosts = { ghosts: () => [], get: () => undefined, remove: vi.fn(), remap, moveGhosts: vi.fn(), subscribe: () => () => {} };
    api.applyModel.mockResolvedValue({ ok: true, value: { ok: true, applied: true, results: [], made: { tmp1: 'real1' } } });
    store.edit((b) => moveItems(b, [{ ref: { kind: 'step', id: 'expand' }, at: { x: 5, y: 5 } }]));
    done(await call(ctx, 'save', {}, 'Save'));
    expect(remap).toHaveBeenCalledWith({ tmp1: 'real1' });
  });
});

describe('the removed tools', () => {
  it('create_assignment, read_design and anything about frames are gone', async () => {
    const { ctx } = setup();
    for (const t of ['create_assignment', 'read_design', 'open_workflow']) expect(done(await call(ctx, t)).ok).toBe(false);
  });
});

describe('ghosts and the selection', () => {
  it('the board read never lists a ghost: a deleted triangle is gone from it though the page still shows its ghost', async () => {
    const live = liveStub();
    live.known([]);
    const { ctx, store } = setup(live);
    const ghosts = createGhostStore(store);
    ctx.ghosts = ghosts;
    const asked = await call(ctx, 'delete_workflow', { workflow_id: 'hourly' });
    done(await call(ctx, 'delete_workflow', {}, 'Delete', (asked as { question: { pin: string } }).question.pin));
    expect(ghosts.ghosts().some((g) => g.key === 'workflow:hourly')).toBe(true);
    const d = JSON.parse(done(await call(ctx, 'read_board')).result);
    expect(d.workflows.map((w: { id: string }) => w.id)).toEqual(['daily']);
    expect(JSON.stringify(d)).not.toContain('hourly');
    expect(JSON.parse(done(await call(ctx, 'list_workflows')).result).map((w: { id: string }) => w.id)).toEqual(['daily']);
  });

  it('pick takes the items as given: triangles picked together and mixed with other items; its triangles are the selected workflows', async () => {
    const { ctx } = setup();
    expect(done(await call(ctx, 'pick', { items: [{ kind: 'workflow', id: 'daily' }, { kind: 'workflow', id: 'hourly' }] })).ok).toBe(true);
    expect(ctx.commands.picks()).toEqual([{ kind: 'workflow', id: 'daily' }, { kind: 'workflow', id: 'hourly' }]);
    expect(done(await call(ctx, 'pick', { items: [{ kind: 'workflow', id: 'daily' }, { kind: 'step', id: 'fetch' }] })).ok).toBe(true);
    const picks = ctx.commands.picks();
    expect(picks).toEqual([{ kind: 'workflow', id: 'daily' }, { kind: 'step', id: 'fetch' }]);
    expect(withPicks({ workflows: ['hourly'], picks: [] }, picks)).toEqual({ workflows: ['daily'], picks });
  });
});

describe('set_field on a cache\'s items (final review, 2026-11-24)', () => {
  it('refuses items text the board could not save, naming why, and leaves the items as they were', async () => {
    const { ctx, store } = setup();
    const before = store.state().caches.c1!.items;
    for (const [value, why] of [['{"n":5}', 'must be a string'], ['{"a:b":"x"}', "must not contain ':'"], [`{"${'k'.repeat(257)}":"x"}`, 'at most 256'], ['not json', 'valid JSON']] as const) {
      const o = done(await call(ctx, 'set_field', { kind: 'cache', id: 'c1', field: 'items', value }));
      expect(o.ok, value).toBe(false);
      expect(o.result, value).toContain(why);
    }
    expect(store.state().caches.c1!.items).toBe(before);
  });

  it('sets valid items text', async () => {
    const { ctx, store } = setup();
    expect(done(await call(ctx, 'set_field', { kind: 'cache', id: 'c1', field: 'items', value: '{"usd":"3.7"}' })).ok).toBe(true);
    expect(store.state().caches.c1!.items).toBe('{"usd":"3.7"}');
  });
});

describe('the Schemas mode cards (2026-11-26): the chat does what the user\'s own clicks can do', () => {
  // schemaBoard: sx (input) and sc (config) are wired through p1, which steps run; sh is held by p2, which no step uses; so is an orphan
  const onSchemas = () => { const s = setup(); s.store.load(schemaBoard()); return s; };

  it('set_schemas_mode turns the mode on and off; off lets go of picked cards; the same mode twice is said', async () => {
    const { ctx } = onSchemas();
    expect(done(await call(ctx, 'set_schemas_mode', { on: true })).result).toMatch(/turned the Schemas mode on/);
    expect(ctx.commands.schemasMode()).toBe(true);
    expect(done(await call(ctx, 'set_schemas_mode', { on: true })).result).toBe('the Schemas mode is already on');
    ctx.commands.setPicks([{ kind: 'schema', id: 'so' }, { kind: 'step', id: 'fetch' }]);
    done(await call(ctx, 'set_schemas_mode', { on: false }));
    expect(ctx.commands.schemasMode()).toBe(false);
    expect(ctx.commands.picks()).toEqual([{ kind: 'step', id: 'fetch' }]);
    expect(done(await call(ctx, 'set_schemas_mode', { on: 'yes' })).ok).toBe(false);
  });

  it('pick takes schema cards and processor cards only while the mode is on, and only a processor no step uses', async () => {
    const { ctx } = onSchemas();
    const off = done(await call(ctx, 'pick', { items: [{ kind: 'schema', id: 'so' }] }));
    expect(off.ok).toBe(false);
    expect(off.result).toMatch(/Schemas mode is off.*set_schemas_mode/);
    ctx.commands.setSchemasMode(true);
    expect(done(await call(ctx, 'pick', { items: [{ kind: 'schema', id: 'so' }, { kind: 'processor', id: 'p2' }] })).ok).toBe(true);
    expect(ctx.commands.picks()).toEqual([{ kind: 'schema', id: 'so' }, { kind: 'processor', id: 'p2' }]);
    const used = done(await call(ctx, 'pick', { items: [{ kind: 'processor', id: 'p1' }] }));
    expect(used.ok).toBe(false);
    expect(used.result).toMatch(/has no card: only a processor no step uses/);
    expect(done(await call(ctx, 'pick', { items: [{ kind: 'schema', id: 'nope' }] })).result).toBe('no schema nope on the board');
  });

  it('move_blocks moves schema and processor cards, their place only, in one history step', async () => {
    const { ctx, store } = onSchemas();
    expect(done(await call(ctx, 'move_blocks', { blocks: [{ kind: 'schema', id: 'so', x: 1, y: 2 }] })).result).toMatch(/Schemas mode is off/);
    ctx.commands.setSchemasMode(true);
    const before = store.state();
    expect(done(await call(ctx, 'move_blocks', { blocks: [{ kind: 'schema', id: 'so', x: 1300, y: 420 }, { kind: 'processor', id: 'p2', x: 950, y: 520 }] })).ok).toBe(true);
    expect(store.state().schemas.so!.at).toEqual({ x: 1300, y: 420 });
    expect(store.state().processors.p2!.at).toEqual({ x: 950, y: 520 });
    expect({ ...store.state().schemas.so!, at: null }).toEqual({ ...before.schemas.so!, at: null });
    store.undo();
    expect(store.state().schemas.so!.at).toEqual(before.schemas.so!.at);
    expect(store.state().processors.p2!.at).toEqual(before.processors.p2!.at);
  });

  it('delete_picked deletes orphan schemas picked alone, naming them, and refuses every other card with its reason', async () => {
    const { ctx, store } = onSchemas();
    ctx.commands.setSchemasMode(true);
    ctx.commands.setPicks([{ kind: 'schema', id: 'so' }]);
    const asked = await call(ctx, 'delete_picked');
    expect(asked.kind).toBe('ask');
    if (asked.kind !== 'ask') return;
    expect(asked.question.text).toBe('Delete 1 orphan schema?');
    const out = done(await call(ctx, 'delete_picked', {}, 'Delete', asked.question.pin));
    expect(out.ok).toBe(true);
    expect(out.result).toBe('deleted 1 orphan schema');
    expect(store.state().schemas.so).toBeUndefined();

    const refused = async (picks: Parameters<typeof ctx.commands.setPicks>[0]) => {
      const s = onSchemas(); s.ctx.commands.setSchemasMode(true); s.ctx.commands.setPicks(picks);
      const o = done(await call(s.ctx, 'delete_picked'));
      expect(o.ok).toBe(false);
      expect(s.store.state().schemas).toEqual(schemaBoard().schemas);
      return o.result;
    };
    expect(await refused([{ kind: 'schema', id: 'sx' }])).toMatch(/schema orders-in 1\.0\.0 is wired \(used by step .*fetch.*\): only an orphan schema can be deleted/);
    expect(await refused([{ kind: 'schema', id: 'sh' }])).toBe('schema held-out 1.0.0 is held by processor idle-proc 2.0.0, which no step uses: only an orphan schema can be deleted');
    expect(await refused([{ kind: 'processor', id: 'p2' }])).toBe('processor idle-proc 2.0.0 is never deleted: Acto does not change, copy or delete a processor');
    expect(await refused([{ kind: 'schema', id: 'so' }, { kind: 'step', id: 'fetch' }])).toBe('orphan schemas are deleted on their own: pick them without other items');
  });

  it('copy refuses a pick with a schema or processor card (no Copy on schemas; a processor is never copied)', async () => {
    const { ctx } = onSchemas();
    ctx.commands.setSchemasMode(true);
    ctx.commands.setPicks([{ kind: 'schema', id: 'so' }, { kind: 'step', id: 'fetch' }]);
    const o = done(await call(ctx, 'copy'));
    expect(o.ok).toBe(false);
    expect(o.result).toBe('schemas and processors are never copied: pick only workflows, steps or caches');
  });

  it('read_board gives the mode, every schema with its state, users and place, and the processor cards', async () => {
    const { ctx } = onSchemas();
    const read = () => call(ctx, 'read_board').then((o) => JSON.parse(done(o).result) as { schemasMode: string; schemas: { id: string; state: string; usedBy: { stepId: string; slot: string }[]; heldBy: { processorId: string }[]; at: unknown }[]; processorCards: { id: string; holds: { schemaId: string; slot: string }[] }[] });
    expect((await read()).schemasMode).toBe('off');
    ctx.commands.setSchemasMode(true);
    const r = await read();
    expect(r.schemasMode).toBe('on');
    const by = Object.fromEntries(r.schemas.map((s) => [s.id, s]));
    expect(Object.fromEntries(r.schemas.map((s) => [s.id, s.state]))).toEqual({ sx: 'wired', sc: 'wired', sh: 'held', so: 'orphan' });
    expect(by.sx!.usedBy.map((u) => u.slot)).toContain('input');
    expect(by.sh!.heldBy).toEqual([{ processorId: 'p2', slot: 'output' }]);
    expect(by.so!.at).toEqual({ x: 1200, y: 400 });
    expect(r.processorCards).toEqual([expect.objectContaining({ id: 'p2', holds: [{ schemaId: 'sh', slot: 'output' }] })]);
  });
});
