import { describe, expect, it, vi } from 'vitest';
import type { StudioApi } from '../../api/client';
import type { Pick } from '../../board/picks';
import { fakeApi, graphWith } from '../../board/testApi';
import { createBoardStore } from '../../design/boardStore';
import { bwFull, proc } from '../../design/fixtures';
import { createOutputStore } from '../../output/outputStore';
import { liveStub } from '../../test/liveStub';
import { runTool } from '../runTool';
import type { ToolContext, ToolOutcome } from '../toolTypes';
import '../tools';

function setup() {
  const output = createOutputStore(null, () => '00:00:00');
  const store = createBoardStore(output, null);
  store.load({ listed: true, workflows: [bwFull()], failures: [] }, [proc('p1', 'Analyst')]);
  const api = fakeApi({ graph: graphWith({ entry: ['a'], steps: { a: ['b'], b: [] } }) });
  let n = 0;
  let picks: Pick[] = [];
  const focus = vi.fn();
  const mem = new Map<string, string>();
  const session = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } } as unknown as Storage;
  const ctx: ToolContext = {
    store, api: api as StudioApi, output, live: liveStub(),
    commands: { focus, setPicks: (p) => { picks = p; }, picks: () => picks, newWorkflowAt: () => ({ x: 700, y: 40 }) },
    processors: () => [proc('p1', 'Analyst'), proc('p2', 'Other')], caches: () => [], session, newId: () => `n${++n}`,
  };
  return { ctx, store, focus, picks: () => picks };
}

type Store = ReturnType<typeof setup>['store'];
const call = (ctx: ToolContext, name: string, args: object = {}, answer?: string, pin?: string) =>
  runTool(ctx, { id: 'c', name, arguments: JSON.stringify(args) }, answer, pin);
const done = (o: ToolOutcome) => { if (o.kind !== 'done') throw new Error('asked'); return o; };
const state = (store: Store) => store.entry('w1')!.history.present;

describe('design tools', () => {
  it('add_step needs a processor, then adds one step right of the rightmost, one history step', async () => {
    const { ctx, store, focus } = setup();
    expect(done(await call(ctx, 'add_step', { workflow_id: 'w1' }))).toMatchObject({ ok: false, result: 'add_step needs processor_id' });
    const before = state(store);
    expect(done(await call(ctx, 'add_step', { workflow_id: 'w1', processor_id: 'p1' })).ok).toBe(true);
    const rightmost = Object.values(before.steps).reduce((a, b) => (b.at.x > a.at.x ? b : a));
    const added = Object.values(state(store).steps).find((s) => s.isNew)!;
    expect(added.processorId).toBe('p1');
    expect(added.at).toEqual({ x: rightmost.at.x + 250, y: rightmost.at.y });
    expect(focus).toHaveBeenCalledWith('w1', [added.id]);
    store.undo('w1');
    expect(state(store)).toBe(before);
  });

  it('add_step with a position uses it; an unlisted processor fails', async () => {
    const { ctx, store } = setup();
    done(await call(ctx, 'add_step', { workflow_id: 'w1', processor_id: 'p2', x: 300, y: 50 }));
    expect(Object.values(state(store).steps).find((s) => s.isNew)!.at).toEqual({ x: 300, y: 50 });
    expect(done(await call(ctx, 'add_step', { workflow_id: 'w1', processor_id: 'zz' })).ok).toBe(false);
  });

  it('set_processor swaps; add_cache makes new-cache-1 then new-cache-2', async () => {
    const { ctx, store } = setup();
    expect(done(await call(ctx, 'set_processor', { workflow_id: 'w1', step_id: 'a', processor_id: 'p2' })).ok).toBe(true);
    expect(state(store).steps.a!.processorId).toBe('p2');
    done(await call(ctx, 'add_cache', { workflow_id: 'w1' }));
    done(await call(ctx, 'add_cache', { workflow_id: 'w1' }));
    const names = Object.values(state(store).caches).map((c) => c.name);
    expect(names).toContain('new-cache-1');
    expect(names).toContain('new-cache-2');
    expect(done(await call(ctx, 'add_cache', { workflow_id: 'w1', cache_id: 'nope' })).ok).toBe(false);
  });

  it('connect returns the Plan 2 refusals; disconnect removes the wire', async () => {
    const { ctx, store } = setup();
    expect(done(await call(ctx, 'connect', { workflow_id: 'w1', from: 'a', to: 'a' })).result).toContain('A step cannot wire to itself');
    expect(done(await call(ctx, 'connect', { workflow_id: 'w1', from: 'a', to: 'b' })).result).toContain('That wire already exists');
    expect(done(await call(ctx, 'connect', { workflow_id: 'w1', from: 'a', to: 'zz' })).result).toContain('A wire stays inside its workflow');
    expect(done(await call(ctx, 'connect', { workflow_id: 'w1', from: 'b', to: 'a' })).ok).toBe(true);
    expect(state(store).steps.b!.nextStepIds).toEqual(['a']);
    expect(done(await call(ctx, 'disconnect', { workflow_id: 'w1', from: 'a', to: 'b' })).ok).toBe(true);
    expect(state(store).steps.a!.nextStepIds).toEqual([]);
    expect(done(await call(ctx, 'disconnect', { workflow_id: 'w1', from: 'a', to: 'b' })).ok).toBe(false);
  });

  it('move_blocks moves three steps as one undo step', async () => {
    const { ctx, store } = setup();
    done(await call(ctx, 'add_step', { workflow_id: 'w1', processor_id: 'p1' }));
    const ids = Object.keys(state(store).steps);
    const before = state(store);
    const o = done(await call(ctx, 'move_blocks', { workflow_id: 'w1', moves: ids.map((id, i) => ({ step_id: id, x: 100 + i * 10, y: 200 })) }));
    expect(o.ok).toBe(true);
    expect(state(store).steps[ids[2]!]!.at).toEqual({ x: 120, y: 200 });
    store.undo('w1');
    expect(state(store)).toBe(before);
  });

  it('undo after add_step removes it (the same history), redo brings it back', async () => {
    const { ctx, store } = setup();
    done(await call(ctx, 'add_step', { workflow_id: 'w1', processor_id: 'p1' }));
    expect(Object.keys(state(store).steps)).toHaveLength(3);
    expect(done(await call(ctx, 'undo', { workflow_id: 'w1' })).ok).toBe(true);
    expect(Object.keys(state(store).steps)).toHaveLength(2);
    expect(done(await call(ctx, 'redo', { workflow_id: 'w1' })).ok).toBe(true);
    expect(Object.keys(state(store).steps)).toHaveLength(3);
    expect(done(await call(ctx, 'redo', { workflow_id: 'w1' })).ok).toBe(false);
  });

  it('a saving workflow refuses an acting tool with a failed result; an unknown workflow names itself', async () => {
    const { ctx, store } = setup();
    store.setSaving('w1', true);
    const o = done(await call(ctx, 'add_step', { workflow_id: 'w1', processor_id: 'p1' }));
    expect(o.ok).toBe(false);
    expect(o.result).toContain('saving');
    expect(done(await call(ctx, 'add_step', { workflow_id: 'ghost', processor_id: 'p1' })).result).toBe('no workflow ghost on the board');
  });

  it('pick validates every item; copy and paste round-trip and pick the pasted steps', async () => {
    const { ctx, store, picks } = setup();
    const bad = done(await call(ctx, 'pick', { items: [{ kind: 'step', workflowId: 'w1', stepId: 'ghost' }] }));
    expect(bad.ok).toBe(false);
    expect(bad.result).toContain('ghost');
    expect(done(await call(ctx, 'copy')).result).toContain('Nothing to copy');
    expect(done(await call(ctx, 'paste', { workflow_id: 'w1' })).result).toBe('Nothing copied yet');
    done(await call(ctx, 'pick', { items: [{ kind: 'step', workflowId: 'w1', stepId: 'a' }, { kind: 'step', workflowId: 'w1', stepId: 'b' }] }));
    expect(done(await call(ctx, 'copy')).ok).toBe(true);
    expect(done(await call(ctx, 'paste', { workflow_id: 'w1' })).ok).toBe(true);
    expect(Object.keys(state(store).steps)).toHaveLength(4);
    expect(picks()).toHaveLength(2);
    expect(picks().every((p) => p.kind === 'step' && state(store).steps[p.stepId]?.isNew)).toBe(true);
  });

  it('delete_picked names what it asks about and deletes exactly that, whatever is picked meanwhile', async () => {
    const { ctx, store } = setup();
    await call(ctx, 'pick', { items: [{ kind: 'step', workflowId: 'w1', stepId: 'b' }, { kind: 'wire', workflowId: 'w1', wireId: 'a>b' }, { kind: 'cache', workflowId: 'w1', cacheId: 'c1' }] });
    const asked = await call(ctx, 'delete_picked');
    if (asked.kind !== 'ask') throw new Error('not asked');
    expect(asked.question.text).toContain('step ');
    expect(asked.question.text).toContain('wire ');
    expect(asked.question.text).toContain('cache c1-name');
    expect(asked.question.text).toContain('(orders)');
    expect(JSON.parse(asked.question.pin!)).toHaveLength(3);
    await call(ctx, 'pick', { items: [{ kind: 'step', workflowId: 'w1', stepId: 'a' }] });
    const o = done(await call(ctx, 'delete_picked', {}, 'Delete', asked.question.pin));
    expect(o.ok).toBe(true);
    expect(state(store).steps.b).toBeUndefined();
    expect(state(store).steps.a).toBeDefined();
    expect(state(store).caches.c1).toBeUndefined();
  });

  it('delete_picked lists five names then "and N more"', async () => {
    const { ctx } = setup();
    for (let i = 0; i < 4; i++) done(await call(ctx, 'add_step', { workflow_id: 'w1', processor_id: 'p1' }));
    const items = Object.keys(state(ctx.store).steps).map((stepId) => ({ kind: 'step', workflowId: 'w1', stepId }));
    await call(ctx, 'pick', { items });
    const asked = await call(ctx, 'delete_picked');
    if (asked.kind !== 'ask') throw new Error('not asked');
    expect(asked.question.text).toContain('and 1 more');
  });

  it('delete_picked reports nothing deleted when every step is refused', async () => {
    const { ctx, store } = setup();
    const second = bwFull();
    second.graph.workflow = { ...second.graph.workflow, id: 'w2', name: 'billing' };
    second.stepIds = ['a', 'b'];
    store.load({ listed: true, workflows: [bwFull(), second], failures: [] }, [proc('p1', 'Analyst')]);
    await call(ctx, 'pick', { items: [{ kind: 'step', workflowId: 'w1', stepId: 'b' }] });
    const asked = await call(ctx, 'delete_picked');
    if (asked.kind !== 'ask') throw new Error('not asked');
    const o = done(await call(ctx, 'delete_picked', {}, 'Delete', asked.question.pin));
    expect(o.ok).toBe(false);
    expect(o.result).toContain('nothing was deleted');
    expect(o.result).not.toContain('deleted the picked');
  });

  it('add_cache avoids names in the library list', async () => {
    const { ctx, store } = setup();
    ctx.caches = () => [{ id: 'x', name: 'new-cache-1', version: '1.0.0', description: null, root: '', items: '{}', audit: { createdAt: '', createdBy: null, updatedAt: '', updatedBy: null } }];
    done(await call(ctx, 'add_cache', { workflow_id: 'w1' }));
    expect(Object.values(state(store).caches).map((c) => c.name)).toContain('new-cache-2');
  });

  it('delete_picked asks, then deletes like the selection bar; declining does nothing', async () => {
    const { ctx, store } = setup();
    expect(done(await call(ctx, 'delete_picked')).ok).toBe(false);
    await call(ctx, 'pick', { items: [{ kind: 'step', workflowId: 'w1', stepId: 'b' }] });
    const q = await call(ctx, 'delete_picked');
    if (q.kind !== 'ask') throw new Error('not asked');
    expect(done(await call(ctx, 'delete_picked', {}, 'Cancel', q.question.pin)).ok).toBe(false);
    expect(state(store).steps.b).toBeDefined();
    expect(done(await call(ctx, 'delete_picked', {}, 'Delete', q.question.pin)).ok).toBe(true);
    expect(state(store).steps.b).toBeUndefined();
  });
});
