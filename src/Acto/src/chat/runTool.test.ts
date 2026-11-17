import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeApi } from '../board/testApi';
import { createBoardStore } from '../design/boardStore';
import { newWorkflowState } from '../design/state';
import { createOutputStore } from '../output/outputStore';
import { liveStub } from '../test/liveStub';
import { runTool } from './runTool';
import { DESTRUCTIVE, TOOL_DEFS, toolsForModel } from './tools';
import { workflowArg, type ToolContext, type ToolOutcome } from './toolTypes';

function context(): ToolContext {
  const output = createOutputStore(null);
  const store = createBoardStore(output, null);
  store.addWorkflow(newWorkflowState('wf1', 'orders', { x: 0, y: 0 }));
  return {
    store, api: fakeApi(), output, live: liveStub(),
    commands: { focus: vi.fn(), setPicks: vi.fn(), picks: () => [], newWorkflowAt: () => ({ x: 0, y: 0 }) },
    processors: () => [], caches: () => [], session: null, newId: () => 'n1',
  };
}

const done = (o: ToolOutcome) => { if (o.kind !== 'done') throw new Error('asked'); return o; };

describe('workflowArg', () => {
  it('names a workflow on the board by its id', () => {
    expect(workflowArg(context(), { workflow_id: 'wf1' })).toEqual({ id: 'wf1', name: 'orders' });
  });

  it('a workflow id that is gone or never existed is an error naming it, with no side effect (Review Focus 3)', () => {
    const ctx = context();
    const before = ctx.store.boards();
    expect(workflowArg(ctx, { workflow_id: 'nope' })).toEqual({ error: 'no workflow nope on the board' });
    ctx.store.remove('wf1');
    expect(workflowArg(ctx, { workflow_id: 'wf1' })).toEqual({ error: 'no workflow wf1 on the board' });
    expect(before).toHaveLength(1);
  });

  it('a missing or non-text id is an error too', () => {
    expect(workflowArg(context(), {})).toEqual({ error: 'no workflow (none given) on the board' });
    expect(workflowArg(context(), { workflow_id: 7 })).toEqual({ error: 'no workflow 7 on the board' });
  });
});

describe('the tool list', () => {
  afterEach(() => { TOOL_DEFS.splice(0, TOOL_DEFS.length); });

  it('is empty until the tools are added, and the destructive ones are named', () => {
    expect(TOOL_DEFS).toEqual([]);
    expect(toolsForModel()).toEqual([]);
    expect([...DESTRUCTIVE].sort()).toEqual(['delete_picked', 'delete_workflow', 'remove_assignment', 'stop']);
  });

  it('is sent to the model as it is at the time, OpenAI style', () => {
    TOOL_DEFS.push({ name: 'x', description: 'd', parameters: { type: 'object' }, run: async () => ({ kind: 'done', ok: true, result: '', action: '', entries: [] }) });
    expect(toolsForModel()).toEqual([{ type: 'function', function: { name: 'x', description: 'd', parameters: { type: 'object' } } }]);
  });
});

describe('runTool', () => {
  afterEach(() => { TOOL_DEFS.splice(0, TOOL_DEFS.length); });

  it('a name that is no tool is a failed result naming it', async () => {
    expect(done(await runTool(context(), { id: 'c', name: 'nope', arguments: '{}' }))).toMatchObject({ ok: false, result: 'there is no tool named nope' });
  });

  it('arguments that are not a JSON object are a failed result', async () => {
    TOOL_DEFS.push({ name: 'x', description: '', parameters: {}, run: async () => ({ kind: 'done', ok: true, result: 'ran', action: 'x', entries: [] }) });
    expect(done(await runTool(context(), { id: 'c', name: 'x', arguments: '{"workflow_id": "wf' }))).toMatchObject({ ok: false, result: expect.stringMatching(/not valid JSON/) });
    expect(done(await runTool(context(), { id: 'c', name: 'x', arguments: '[1]' }))).toMatchObject({ ok: false, result: 'the arguments of x must be a JSON object' });
    expect(done(await runTool(context(), { id: 'c', name: 'x', arguments: '' }))).toMatchObject({ ok: true, result: 'ran' });
  });

  it('a tool that throws is a failed result, not a crash', async () => {
    TOOL_DEFS.push({ name: 'boom', description: '', parameters: {}, run: async () => { throw new Error('kaput'); } });
    expect(done(await runTool(context(), { id: 'c', name: 'boom', arguments: '{}' }))).toMatchObject({ ok: false, result: 'boom failed: kaput', action: 'boom failed' });
  });

  it('passes the answer and the pinned workflow on', async () => {
    const run = vi.fn(async () => ({ kind: 'done' as const, ok: true, result: '', action: '', entries: [] }));
    TOOL_DEFS.push({ name: 'x', description: '', parameters: {}, run });
    const ctx = context();
    await runTool(ctx, { id: 'c', name: 'x', arguments: '{"a":1}' }, 'Yes', 'wf1');
    expect(run).toHaveBeenCalledWith(ctx, { a: 1 }, 'Yes', 'wf1');
  });
});
