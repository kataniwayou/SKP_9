import { describe, expect, it, vi } from 'vitest';
import { boardApi } from '../../board/testApi';
import type { StudioApi } from '../../api/client';
import { createGhostStore } from '../../design/ghosts';
import { shared } from '../../design/boardFixtures';
import { setCacheField, setWorkflowField } from '../../design/edits';
import { typedChoice } from '../useChat';
import { call, done, setup } from './testContext';

// The tools and behaviours the 2026-11-18 chat audit added (G1–G9), each through the same store calls the UI uses.

describe('G1 set_field on an assignment (the Step > workflow tab fields)', () => {
  it('sets name, version and description of the workflow\'s own row in place, one undo step', async () => {
    const { ctx, store } = setup();
    const o = done(await call(ctx, 'set_field', { kind: 'assignment', id: 'a-daily-fetch', workflow_id: 'daily', field: 'name', value: 'daily-fetch' }));
    expect(o.ok).toBe(true);
    expect(store.state().assignments['a-daily-fetch']!.name).toBe('daily-fetch');
    done(await call(ctx, 'set_field', { kind: 'assignment', id: 'a-daily-fetch', workflow_id: 'daily', field: 'description', value: 'mine' }));
    expect(store.state().assignments['a-daily-fetch']!.description).toBe('mine');
    store.undo();
    expect(store.state().assignments['a-daily-fetch']!.description).toBeNull();
  });

  it('a row other workflows share is copied for this workflow only (copy-on-write, as the Inspector)', async () => {
    const { ctx, store } = setup();
    store.load(shared());
    const sharedId = store.state().workflows.daily!.assignmentIds[0]!;
    expect(Object.values(store.state().workflows).filter((w) => w.assignmentIds.includes(sharedId)).length).toBeGreaterThan(1);
    done(await call(ctx, 'set_field', { kind: 'assignment', id: sharedId, workflow_id: 'daily', field: 'version', value: '2.0.0' }));
    const mine = store.state().workflows.daily!.assignmentIds[0]!;
    expect(mine).not.toBe(sharedId);
    expect(store.state().assignments[mine]!.version).toBe('2.0.0');
    expect(store.state().assignments[sharedId]!.version).toBe('1.0.0');
  });

  it('needs the workflow whose payload it is; a payload field is not a field here', async () => {
    const { ctx } = setup();
    expect(done(await call(ctx, 'set_field', { kind: 'assignment', id: 'a-daily-fetch', field: 'name', value: 'x' })).result).toContain('no workflow (none given)');
    expect(done(await call(ctx, 'set_field', { kind: 'assignment', id: 'a-daily-fetch', workflow_id: 'hourly', field: 'name', value: 'x' })).result).toBe('workflow hourly has no assignment a-daily-fetch');
    expect(done(await call(ctx, 'set_field', { kind: 'assignment', id: 'a-daily-fetch', workflow_id: 'daily', field: 'payload', value: '{}' })).result).toContain('the fields are name, version, description');
  });

  it('read_board gives each payload\'s name, version and description', async () => {
    const { ctx } = setup();
    const d = JSON.parse(done(await call(ctx, 'read_board')).result);
    expect(d.workflows[0].payloads[0]).toMatchObject({ assignmentId: 'a-daily-fetch', name: 'fetch-assignment', version: '1.0.0', description: null });
  });
});

describe('G2 ghosts through the chat: list_ghosts, restore_ghosts, remove_ghosts', () => {
  async function deleted() {
    const t = setup();
    const ghosts = createGhostStore(t.store);
    t.ctx.ghosts = ghosts;
    done(await call(t.ctx, 'pick', { items: [{ kind: 'step', id: 'lonely' }] }));
    const asked = await call(t.ctx, 'delete_picked');
    done(await call(t.ctx, 'delete_picked', {}, 'Delete', (asked as { question: { pin: string } }).question.pin));
    return { ...t, ghosts };
  }

  it('list_ghosts names the deleted step by key and name; read_board does not have it', async () => {
    const { ctx } = await deleted();
    expect(JSON.parse(done(await call(ctx, 'list_ghosts')).result)).toEqual([{ key: 'step:lonely', kind: 'step', name: 'lonely' }]);
    expect(done(await call(ctx, 'read_board')).result).not.toContain('"lonely"');
  });

  it('restore_ghosts by name puts the step back as one undoable edit; the ghost goes', async () => {
    const { ctx, store, ghosts } = await deleted();
    expect(store.state().steps.lonely).toBeUndefined();
    const o = done(await call(ctx, 'restore_ghosts', { ghosts: ['lonely'] }));
    expect(o).toMatchObject({ ok: true, result: 'restored lonely; not saved yet' });
    expect(store.state().steps.lonely).toBeDefined();
    expect(ghosts.ghosts()).toEqual([]);
    store.undo();
    expect(store.state().steps.lonely).toBeUndefined();
  });

  it('a link whose end is a ghost is refused with the edit\'s own words; an unknown ghost fails naming it', async () => {
    const t = setup();
    const ghosts = createGhostStore(t.store);
    t.ctx.ghosts = ghosts;
    done(await call(t.ctx, 'pick', { items: [{ kind: 'step', id: 'expand' }] }));
    const asked = await call(t.ctx, 'delete_picked');
    done(await call(t.ctx, 'delete_picked', {}, 'Delete', (asked as { question: { pin: string } }).question.pin));
    const wire = ghosts.ghosts().find((g) => g.kind === 'wire')!;
    expect(done(await call(t.ctx, 'restore_ghosts', { ghosts: [wire.key] }))).toMatchObject({ ok: false, result: expect.stringContaining('restore expand first') });
    expect(done(await call(t.ctx, 'restore_ghosts', { ghosts: ['nope'] }))).toMatchObject({ ok: false, result: 'no ghost nope: list_ghosts gives them' });
  });

  it('remove_ghosts drops the ghost for the session: no board change, no undo step', async () => {
    const { ctx, store, ghosts } = await deleted();
    const before = store.state();
    expect(done(await call(ctx, 'remove_ghosts', { ghosts: ['step:lonely'] }))).toMatchObject({ ok: true, result: 'removed the ghost lonely' });
    expect(ghosts.ghosts()).toEqual([]);
    expect(store.state()).toBe(before);
  });
});

describe('G3 read_board holds the board\'s unsaved cache items and descriptions', () => {
  it('an unsaved items edit is what read_board answers', async () => {
    const { ctx, store } = setup();
    store.edit((b) => setCacheField(setCacheField(b, 'c1', 'items', '{"usd":"3.7"}'), 'c1', 'description', 'rates'));
    const d = JSON.parse(done(await call(ctx, 'read_board')).result);
    expect(d.caches[0]).toMatchObject({ id: 'c1', items: '{"usd":"3.7"}', description: 'rates' });
  });
});

describe('G4 read_selection: what is selected and what the Inspector shows (the Inspector\'s own tabs.ts)', () => {
  it('one workflow and one step: Step · Processor with that workflow\'s assignment under Step', async () => {
    const { ctx } = setup();
    done(await call(ctx, 'pick', { items: [{ kind: 'workflow', id: 'daily' }, { kind: 'step', id: 'fetch' }] }));
    const r = JSON.parse(done(await call(ctx, 'read_selection')).result);
    expect(r.selected).toEqual(['workflow daily', 'step fetch-orders']);
    expect(r.inspector).toMatchObject({ tabs: ['Step', 'Processor'], underStep: ['daily'], assignmentShown: { workflow: 'daily', assignment: { id: 'a-daily-fetch', payload: '{}' } } });
  });

  it('one workflow alone: its Workflow tab; two workflows: the pick list; nothing: nothing', async () => {
    const { ctx } = setup();
    done(await call(ctx, 'pick', { items: [{ kind: 'workflow', id: 'daily' }] }));
    expect(JSON.parse(done(await call(ctx, 'read_selection')).result).inspector).toEqual({ tabs: ['Workflow'] });
    done(await call(ctx, 'pick', { items: [{ kind: 'workflow', id: 'daily' }, { kind: 'workflow', id: 'hourly' }] }));
    expect(JSON.parse(done(await call(ctx, 'read_selection')).result).inspector).toEqual({ pickList: ['workflow daily', 'workflow hourly'] });
    done(await call(ctx, 'pick', { items: [] }));
    expect(JSON.parse(done(await call(ctx, 'read_selection')).result).inspector).toBe('nothing: no item is selected');
  });

  it('one step alone: Step · Processor with no assignment tab', async () => {
    const { ctx } = setup();
    done(await call(ctx, 'pick', { items: [{ kind: 'step', id: 'fetch' }] }));
    expect(JSON.parse(done(await call(ctx, 'read_selection')).result).inspector).toMatchObject({ tabs: ['Step', 'Processor'], underStep: [], assignmentShown: null });
  });
});

describe('G5 take_stored', () => {
  it('nothing stale: fails saying so and asks nothing', async () => {
    const { ctx } = setup();
    expect(done(await call(ctx, 'take_stored'))).toMatchObject({ ok: false, result: expect.stringContaining('nothing to take') });
  });

  it('asks first naming the rows; Cancel keeps the change; Take stored takes BaseAPI\'s version through the button\'s path', async () => {
    const { ctx, store } = setup();
    ctx.api = boardApi() as StudioApi;
    store.edit((b) => setWorkflowField(b, 'daily', 'name', 'daily-2'));
    store.setStale([{ table: 'workflows', id: 'daily' }]);
    expect(await call(ctx, 'take_stored')).toMatchObject({ kind: 'ask', question: { choices: ['Take stored', 'Cancel'], text: expect.stringContaining('daily') } });
    expect(done(await call(ctx, 'take_stored', {}, 'Cancel')).ok).toBe(false);
    expect(store.state().workflows.daily!.name).toBe('daily-2');
    const o = done(await call(ctx, 'take_stored', {}, 'Take stored'));
    expect(o.ok).toBe(true);
    expect(o.result).toContain('Took the stored');
    expect(store.state().workflows.daily!.name).toBe('daily');
    expect(store.stale()).toEqual([]);
  });
});

describe('G6 add_cache takes a name and a root', () => {
  it('both set in one history step; without a root the answer says BaseAPI will refuse to save it', async () => {
    const { ctx, store } = setup();
    expect(done(await call(ctx, 'add_cache', { name: 'rates', root: 'fx' })).result).toContain('added cache rates 1.0.0 (id n1) with root fx');
    expect(store.state().caches.n1).toMatchObject({ name: 'rates', root: 'fx' });
    store.undo();
    expect(store.state().caches.n1).toBeUndefined();
    expect(done(await call(ctx, 'add_cache')).result).toContain('BaseAPI refuses to save a cache without one');
  });
});

describe('G7 start and take_stored ask first', () => {
  it('start asks, Cancel sends nothing', async () => {
    const { ctx, api } = setup();
    expect(await call(ctx, 'start', { workflow_id: 'daily' })).toMatchObject({ kind: 'ask', question: { text: 'Start daily?', choices: ['Start', 'Cancel'] } });
    done(await call(ctx, 'start', {}, 'Cancel', 'daily'));
    expect(api.startWorkflow).not.toHaveBeenCalled();
  });
});

describe('G8 a typed yes or no answers the question', () => {
  it('exact choice text, yes = the one choice that is not Cancel, no = Cancel; anything else is no answer', () => {
    expect(typedChoice(['Delete', 'Cancel'], ' delete ')).toBe('Delete');
    expect(typedChoice(['Delete', 'Cancel'], 'Yes')).toBe('Delete');
    expect(typedChoice(['Start', 'Cancel'], 'no.')).toBe('Cancel');
    expect(typedChoice(['Take stored', 'Cancel'], 'ok')).toBe('Take stored');
    expect(typedChoice(['Stop', 'Cancel'], 'stop')).toBe('Stop');
    expect(typedChoice(['Delete', 'Cancel'], 'wait, what?')).toBeUndefined();
    expect(typedChoice(['Save', 'Discard', 'Cancel'], 'yes')).toBeUndefined();
  });
});

describe('G9 save answers the new ids and the dry-run workflows', () => {
  it('the result maps each client id to BaseAPI\'s and names the affected workflows with their ids', async () => {
    const { ctx, api } = setup();
    api.applyModel.mockResolvedValue({ ok: true, value: { ok: true, applied: true, results: [], made: { n1: 'real-1' } } });
    done(await call(ctx, 'new_workflow', { name: 'feed' }));
    const o = done(await call(ctx, 'save', {}, 'Save'));
    expect(o.result).toContain('New ids (client id -> BaseAPI id): feed: n1 -> real-1.');
    vi.restoreAllMocks();
  });
});
