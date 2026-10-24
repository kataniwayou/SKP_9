import { describe, expect, it, vi } from 'vitest';
import type { StudioApi } from '../../api/client';
import { assignmentDto, cacheDto, graphDto, processorDto, schemaDto, stepDto, workflowDto } from '../../api/fixtures';
import { loadedDocument } from '../../app/fixtures';
import { createInspectorService } from '../../app/inspectorService';
import { newWorkflowDocument } from '../../app/newWorkflow';
import { createStudioStore } from '../../store/studioStore';
import { DESTRUCTIVE, TOOL_DEFS, TOOLS } from '../tools';
import { READ_TOOLS } from './read';
import type { ToolContext, ToolDef } from '../toolTypes';

const ok = <T,>(value: T) => ({ ok: true, value }) as const;
const notFound = { ok: false, error: { kind: 'notFound', status: 404 } } as const;

async function setup() {
  const store = createStudioStore();
  store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
  store.dispatch({ type: 'loaded', workflowId: 'wf1', doc: await loadedDocument(graphDto({
    workflow: workflowDto({ entryStepIds: ['s1'], assignmentIds: ['a1'] }),
    steps: [stepDto('s1', { name: 'fetch', processorId: 'p1', nextStepIds: ['s2'] }), stepDto('s2', { name: 'parse', processorId: 'p1' })],
    processors: [processorDto('p1', { name: 'fetcher', configSchemaId: 'sc1' })], schemas: [schemaDto('sc1', { name: 'cfg' })],
    assignments: [assignmentDto('a1', { stepId: 's1', payload: '{"k":1}' })],
  })) });
  const api = {
    listWorkflows: async () => ok([workflowDto({ id: 'wf1' }), workflowDto({ id: 'wf2', name: 'other' })]),
    listLive: async () => ok(['WF2']),
    listLiveness: async () => ok([{ processorId: 'P1', live: true, healthy: 1, replicas: 2 }]),
    listProcessors: async () => ok([processorDto('p1', { name: 'fetcher', configSchemaId: 'sc1' })]),
    listCaches: async () => ok([cacheDto('c1', { name: 'store', root: 'r' })]),
    listSchemas: async () => ok([schemaDto('sc1', { name: 'cfg' })]),
    getEntity: vi.fn(async (kind: string, id: string) => {
      if (kind === 'assignment') return ok(assignmentDto(id, { stepId: 's1', payload: '{"k":1}' }));
      if (kind === 'schema') return ok(schemaDto(id, { name: 'cfg', definition: '{"type":"object"}' }));
      if (kind === 'cache') return ok(cacheDto(id, { name: 'store', root: 'r' }));
      return notFound;
    }),
  } as unknown as StudioApi;
  const ctx: ToolContext = { store, api, service: createInspectorService(api, store), commands: {} as ToolContext['commands'], newId: () => 'n' };
  const tool = (name: string): ToolDef => TOOL_DEFS.find((t) => t.name === name)!;
  const run = async (name: string, args: Record<string, unknown> = {}) => {
    const out = await tool(name).run(ctx, args);
    if (out.kind !== 'done') throw new Error('asked');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { ok: out.ok, data: (out.ok ? JSON.parse(out.result) : out.result) as any };
  };
  return { store, ctx, run, api };
}

describe('the reading tools', () => {
  it('are offered to the model as functions, none destructive', () => {
    expect(TOOLS.map((t) => t.function.name).slice(0, 7)).toEqual(['list_workflows', 'list_processors', 'list_caches', 'list_schemas', 'read_design', 'read_entity', 'read_output']);
    expect(READ_TOOLS.some((t) => DESTRUCTIVE.has(t.name))).toBe(false);
  });

  it('list workflows with running and open', async () => {
    const { run } = await setup();
    expect((await run('list_workflows')).data).toEqual([
      { id: 'wf1', name: 'orders', version: '1.0.0', running: false, open: true },
      { id: 'wf2', name: 'other', version: '1.0.0', running: true, open: false },
    ]);
  });

  it('list processors with their schema names, caches and schemas', async () => {
    const { run } = await setup();
    expect((await run('list_processors')).data).toEqual([{ id: 'p1', name: 'fetcher', version: '1.0.0', health: 'live · 1 of 2 replicas healthy', schemas: { input: null, output: null, config: 'cfg 1.0.0' } }]);
    expect((await run('list_caches')).data).toEqual([{ id: 'c1', name: 'store', version: '1.0.0', root: 'r' }]);
    expect((await run('list_schemas')).data).toEqual([{ id: 'sc1', name: 'cfg', version: '1.0.0' }]);
  });

  it('read_design names every step and has no problems on a clean document', async () => {
    const { run } = await setup();
    const r = await run('read_design');
    expect(r.data.steps.map((s: { name: string }) => s.name)).toEqual(['fetch', 'parse']);
    expect(r.data.workflow).toMatchObject({ id: 'wf1', running: false });
    expect(r.data.steps[0]).toMatchObject({ processor: { name: 'fetcher', version: '1.0.0', health: 'live · 1 of 2 replicas healthy' }, entryCondition: 'Completed', assignmentId: 'a1', next: ['s2'] });
    expect(r.data.problems).toEqual([]);
    expect(r.data.blocks.length).toBeGreaterThan(2);
  });

  it('health and running are unknown when BaseApi cannot say, not reported for a processor it does not list', async () => {
    const { ctx, run } = await setup();
    ctx.api.listLive = async () => notFound;
    ctx.api.listLiveness = async () => { throw new Error('down'); };
    expect((await run('read_design')).data.workflow.running).toBeNull();
    expect((await run('list_processors')).data[0].health).toBe('unknown: BaseApi could not say');
    ctx.api.listLiveness = async () => ok([]);
    expect((await run('list_processors')).data[0].health).toBe('not reported');
  });

  it('read_design says when the workflow is not open', async () => {
    const { run } = await setup();
    expect((await run('read_design', { workflow: 'other' })).data).toBe('workflow other is not open; open it first');
  });

  it('read_entity shows a step with the design edits over it, and leaves the Inspector alone', async () => {
    const { run, store, ctx } = await setup();
    store.dispatch({ type: 'select', workflowId: 'wf1', selection: { kind: 'step', stepId: 's1' } });
    ctx.service.edit('wf1', { key: 'name', label: 'Name', kind: 'text' }, 'fetch-2');
    store.dispatch({ type: 'select', workflowId: 'wf1', selection: null });
    const before = store.getState();
    const r = await run('read_entity', { target: { kind: 'step', step: 'fetch-2' } });
    expect(r.data).toMatchObject({ kind: 'step', id: 's1', unsaved: true, fields: { name: 'fetch-2', entryCondition: 'Completed' }, assignmentId: 'a1' });
    expect(store.getState()).toBe(before);
  });

  it('read_entity reads an assignment, a config schema (from BaseApi) and an empty slot', async () => {
    const { run } = await setup();
    expect((await run('read_entity', { target: { kind: 'assignment', step: 'fetch' } })).data.fields.payload).toBe('{"k":1}');
    expect((await run('read_entity', { target: { kind: 'schema', step: 'fetch', slot: 'config' } })).data.fields.definition).toBe('{"type":"object"}');
    expect((await run('read_entity', { target: { kind: 'schema', step: 'fetch', slot: 'input' } })).data).toMatchObject({ fields: { definition: '{}' } });
  });

  it('read_entity says what is missing', async () => {
    const { run } = await setup();
    expect((await run('read_entity', { target: { kind: 'assignment', step: 'parse' } })).data).toBe('step parse has no assignment');
    expect((await run('read_entity', { target: { kind: 'step', step: 'zzz' } })).data).toBe('no step named zzz in orders');
    expect((await run('read_entity', { target: { kind: 'schema', step: 'fetch' } })).data).toContain('slot');
    expect((await run('read_entity', { target: { kind: 'cache', cache: 'store' } })).data).toMatchObject({ kind: 'cache', fields: { root: 'r' } });
  });

  it('read_output gives the newest lines of the active workflow', async () => {
    const { run, store } = await setup();
    store.dispatch({ type: 'log', workflowId: 'wf1', lines: [1, 2, 3].map((i) => ({ at: `2026-10-23T10:0${i}:00Z`, text: `line ${i}` })) });
    expect((await run('read_output', { last: 2 })).data.map((l: { text: string }) => l.text)).toEqual(['line 2', 'line 3']);
  });

  it('read_entity reads the assignment of a pasted step over its original row, as the Inspector does', async () => {
    const { run, store, api } = await setup();
    store.dispatch({ type: 'pick', workflowId: 'wf1', picks: [{ kind: 'node', id: 's1' }] });
    store.dispatch({ type: 'copy', workflowId: 'wf1' });
    let n = 0;
    store.dispatch({ type: 'paste', workflowId: 'wf1', newId: () => `new${++n}` });
    const pastedId = Object.keys(store.getState().docs[0]!.design.draft.blocks.steps)[0]!;
    const r = await run('read_entity', { target: { kind: 'assignment', step: pastedId } });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ kind: 'assignment', fields: { payload: '{"k":1}' } });
    expect(api.getEntity).toHaveBeenCalledWith('assignment', 'a1');
  });

  it('read_entity reads a new, unsaved workflow from its own graph, with no GET', async () => {
    const { run, store, api } = await setup();
    store.dispatch({ type: 'new', workflowId: 'wfN', doc: await newWorkflowDocument('wfN', 'untitled') });
    const r = await run('read_entity', { target: { kind: 'workflow' } });
    expect(r.data).toMatchObject({ kind: 'workflow', id: 'wfN', fields: { name: 'untitled', version: '1.0.0' } });
    expect(api.getEntity).not.toHaveBeenCalled();
  });

  it('read_entity on a workflow name says the list could not be read when it could not', async () => {
    const { run, ctx } = await setup();
    ctx.api.listWorkflows = async () => ({ ok: false, error: { kind: 'network', message: 'down' } });
    expect((await run('read_entity', { workflow: 'other', target: { kind: 'workflow' } })).data).toMatch(/^could not read the list of workflows/);
  });
});
