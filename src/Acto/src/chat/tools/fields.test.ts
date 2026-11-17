import { describe, expect, it, vi } from 'vitest';
import type { StudioApi } from '../../api/client';
import type { Pick } from '../../board/picks';
import { bw } from '../../board/fixtures';
import { fakeApi } from '../../board/testApi';
import { createBoardStore } from '../../design/boardStore';
import { bwFull, proc } from '../../design/fixtures';
import { AUDIT } from '../../model/fixtures';
import { createOutputStore } from '../../output/outputStore';
import { liveStub } from '../../test/liveStub';
import { runTool } from '../runTool';
import type { ToolContext, ToolOutcome } from '../toolTypes';
import '../tools';

const SCHEMA = JSON.stringify({ type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] });

function setup() {
  const output = createOutputStore(null, () => '00:00:00');
  const store = createBoardStore(output, null);
  const w1 = bwFull();
  const p1 = { ...proc('p1', 'Analyst'), configSchemaId: 'sc1' };
  w1.graph.processors = new Map([['p1', p1]]);
  w1.graph.schemas = new Map([['sc1', { id: 'sc1', name: 'cfg', version: '1.0.0', description: null, definition: SCHEMA, audit: AUDIT }]]);
  const w2 = bw('w2', ['a']);
  store.load({ listed: true, workflows: [w1, w2], failures: [] }, [p1]);
  let n = 0;
  let picks: Pick[] = [];
  const focus = vi.fn();
  const ctx: ToolContext = {
    store, api: fakeApi() as StudioApi, output, live: liveStub(),
    commands: { focus, setPicks: (p) => { picks = p; }, picks: () => picks, newWorkflowAt: () => ({ x: 700, y: 40 }) },
    processors: () => [p1], caches: () => [], session: null, newId: () => `n${++n}`,
  };
  return { ctx, store };
}

type Store = ReturnType<typeof setup>['store'];
const call = (ctx: ToolContext, name: string, args: object = {}, answer?: string, pin?: string) =>
  runTool(ctx, { id: 'c', name, arguments: JSON.stringify(args) }, answer, pin);
const done = (o: ToolOutcome) => { if (o.kind !== 'done') throw new Error('asked'); return o; };
const state = (store: Store, id = 'w1') => store.entry(id)!.history.present;
const setF = (ctx: ToolContext, target: object, key: string, value: string | number) => call(ctx, 'set_field', { workflow_id: 'w1', target, key, value });

describe('field tools', () => {
  it('set_field on a step name sets it as one undo step', async () => {
    const { ctx, store } = setup();
    const before = state(store);
    const o = done(await setF(ctx, { kind: 'step', id: 'a' }, 'name', 'fetch'));
    expect(o.ok).toBe(true);
    expect(state(store).steps.a!.name).toBe('fetch');
    store.undo('w1');
    expect(state(store)).toBe(before);
  });

  it('sets workflow, cache and entry condition fields; an empty description clears it', async () => {
    const { ctx, store } = setup();
    expect(done(await setF(ctx, { kind: 'workflow' }, 'cronExpression', '0 * * * *')).ok).toBe(true);
    expect(state(store).fields.cronExpression).toBe('0 * * * *');
    done(await setF(ctx, { kind: 'workflow' }, 'cronExpression', ''));
    expect(state(store).fields.cronExpression).toBeNull();
    expect(done(await setF(ctx, { kind: 'cache', id: 'c1' }, 'root', 'x')).ok).toBe(true);
    expect(state(store).caches.c1!.root).toBe('x');
    expect(done(await setF(ctx, { kind: 'step', id: 'b' }, 'entryCondition', 2)).ok).toBe(true);
    expect(state(store).steps.b!.entryCondition).toBe(2);
    expect(done(await setF(ctx, { kind: 'step', id: 'b' }, 'entryCondition', 9)).ok).toBe(false);
  });

  it('a chat edit of a field is its own undo step, not merged into the user typing', async () => {
    const { ctx, store } = setup();
    const before = state(store);
    store.edit('w1', (s) => ({ ...s, steps: { ...s.steps, a: { ...s.steps.a!, name: 'typed' } } }), 'field:a:name');
    const typed = state(store);
    await setF(ctx, { kind: 'step', id: 'a' }, 'name', 'chatted');
    store.undo('w1');
    expect(state(store)).toBe(typed);
    store.undo('w1');
    expect(state(store)).toBe(before);
  });

  it('a shared step another workflow is changing: failed with the lock message', async () => {
    const { ctx, store } = setup();
    store.edit('w2', (s) => ({ ...s, steps: { ...s.steps, a: { ...s.steps.a!, name: 'mine' } } }));
    const o = done(await setF(ctx, { kind: 'step', id: 'a' }, 'name', 'fetch'));
    expect(o.ok).toBe(false);
    expect(o.result).toContain('is being changed in w2-name');
    expect(state(store).steps.a!.name).toBe('a-name');
  });

  it('an unknown key or target fails by name', async () => {
    const { ctx } = setup();
    expect(done(await setF(ctx, { kind: 'step', id: 'a' }, 'color', 'red')).result).toContain('step has no field color');
    expect(done(await setF(ctx, { kind: 'cache', id: 'c1' }, 'entryCondition', 1)).result).toContain('cache has no field entryCondition');
    expect(done(await setF(ctx, { kind: 'step', id: 'zz' }, 'name', 'x')).result).toContain('no step zz');
    expect(done(await setF(ctx, { kind: 'cache', id: 'zz' }, 'name', 'x')).ok).toBe(false);
  });

  it('a processor field and a slot definition (a schema copy, payloads re-checked)', async () => {
    const { ctx, store } = setup();
    expect(done(await setF(ctx, { kind: 'processor', id: 'p1' }, 'name', 'Renamed')).ok).toBe(true);
    expect(state(store).processors!.p1!.fields.name).toBe('Renamed');
    await call(ctx, 'create_assignment', { workflow_id: 'w1', step_id: 'b', payload: '{"n":1}' });
    const o = done(await setF(ctx, { kind: 'slot', id: 'p1', slot: 'config' }, 'definition', JSON.stringify({ type: 'object', required: ['q'] })));
    expect(o.ok).toBe(true);
    const copy = state(store).processors!.p1!.slots.config as { copy: { id: string; definition: string } };
    expect(copy.copy.id).toBe('n2');
    expect(o.result).toContain('Payload check');
    expect(o.result).toContain('q');
    expect(done(await setF(ctx, { kind: 'slot', id: 'p1', slot: 'input' }, 'name', 'x')).result).toContain('has no input schema');
  });

  it('create_assignment with an invalid payload lists the problems and keeps it', async () => {
    const { ctx, store } = setup();
    const o = done(await call(ctx, 'create_assignment', { workflow_id: 'w1', step_id: 'b', payload: '{"n":"x"}' }));
    expect(o.ok).toBe(true);
    expect(o.result).toContain('Payload check');
    expect(state(store).assignments.b!.payload).toBe('{"n":"x"}');
    expect(done(await call(ctx, 'create_assignment', { workflow_id: 'w1', step_id: 'b', payload: '{"n":2}' })).result).not.toContain('Payload check');
    expect(done(await call(ctx, 'create_assignment', { workflow_id: 'w1', step_id: 'zz', payload: '{}' })).ok).toBe(false);
  });

  it('remove_assignment asks first, names and pins what it asked about', async () => {
    const { ctx, store } = setup();
    const asked = await call(ctx, 'remove_assignment', { workflow_id: 'w1', step_id: 'a' });
    if (asked.kind !== 'ask') throw new Error('not asked');
    expect(asked.question.text).toContain('a-name');
    expect(asked.question.text).toContain('orders');
    expect(state(store).assignments.a).toBeDefined();
    const declined = done(await call(ctx, 'remove_assignment', { workflow_id: 'w1', step_id: 'a' }, 'Cancel', asked.question.pin));
    expect(declined.ok).toBe(false);
    expect(state(store).assignments.a).toBeDefined();
    // the answer removes what was asked about, whatever the call now says
    const ok = done(await call(ctx, 'remove_assignment', { workflow_id: 'w2', step_id: 'zz' }, 'Remove', asked.question.pin));
    expect(ok.ok).toBe(true);
    expect(state(store).assignments.a).toBeUndefined();
    expect(done(await call(ctx, 'remove_assignment', { workflow_id: 'w1', step_id: 'a' })).ok).toBe(false);
  });
});
