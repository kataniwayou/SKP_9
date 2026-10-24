import { describe, expect, it, vi } from 'vitest';
import type { StudioApi } from '../../api/client';
import { assignmentDto, graphDto, processorDto, schemaDto, stepDto, workflowDto } from '../../api/fixtures';
import { loadedDocument } from '../../app/fixtures';
import { createInspectorService } from '../../app/inspectorService';
import { fieldsOf } from '../../design/design';
import { targetKey } from '../../store/inspectorTarget';
import { shownDesignOf } from '../../store/problems';
import { activeDocument, shownTargetOf } from '../../store/studioState';
import { createStudioStore } from '../../store/studioStore';
import { runTool } from '../runTool';
import { DESTRUCTIVE } from '../tools';
import type { ToolContext, ToolOutcome } from '../toolTypes';

const ok = <T,>(value: T) => ({ ok: true, value }) as const;

async function setup() {
  const store = createStudioStore();
  store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
  store.dispatch({ type: 'loaded', workflowId: 'wf1', doc: await loadedDocument(graphDto({
    workflow: workflowDto({ entryStepIds: ['s1'], assignmentIds: ['a1'] }),
    steps: [stepDto('s1', { name: 'a', processorId: 'p1', nextStepIds: ['s2'] }), stepDto('s2', { name: 'b', processorId: 'p1' })],
    processors: [processorDto('p1', { name: 'fetcher', configSchemaId: 'sc1' })], schemas: [schemaDto('sc1', { name: 'cfg' })],
    assignments: [assignmentDto('a1', { stepId: 's1', payload: '{"k":1}' })],
  })) });
  // BaseApi's reads, answered at once (the Inspector waits for them)
  const api = {
    listWorkflows: async () => ok([workflowDto({ id: 'wf1' })]),
    listCaches: async () => ok([]),
    getEntity: vi.fn(async (kind: string, id: string) => {
      if (kind === 'assignment') return ok(assignmentDto(id, { stepId: 's1', payload: '{"k":1}' }));
      if (kind === 'schema') return ok(schemaDto(id, { name: 'cfg', definition: '{"type":"object"}' }));
      if (kind === 'step') return ok(stepDto(id, { name: id === 's1' ? 'a' : 'b' }));
      return ok(processorDto(id, { name: 'fetcher', configSchemaId: 'sc1' }));
    }),
  } as unknown as StudioApi;
  let n = 0;
  const ctx: ToolContext = { store, api, service: createInspectorService(api, store), commands: {} as ToolContext['commands'], newId: () => `n${++n}` };
  const call = (name: string, args: object = {}, answer?: string) => runTool(ctx, { id: 'c1', name, arguments: JSON.stringify(args) }, answer, answer === undefined ? undefined : 'wf1');
  const doc = () => store.getState().docs[0]!;
  return { store, ctx, call, doc, api };
}
const done = (o: ToolOutcome) => { if (o.kind !== 'done') throw new Error(`asked: ${JSON.stringify(o)}`); return o; };
const ask = (o: ToolOutcome) => { if (o.kind !== 'ask') throw new Error(`done: ${JSON.stringify(o)}`); return o.question; };

describe('the field tools', () => {
  it('set_field step a entryCondition Failed: the Inspector shows step a, and its entry condition is Failed', async () => {
    const { call, doc, store } = await setup();
    const r = done(await call('set_field', { target: { kind: 'step', step: 'a' }, field: 'entryCondition', value: 'Failed' }));
    expect(r).toMatchObject({ ok: true, action: 'entry condition of step a set to Failed' });
    expect(r.result).toContain('"Failed"');
    expect(activeDocument(store.getState())?.workflowId).toBe('wf1');
    expect(shownTargetOf(doc())).toEqual({ kind: 'step', id: 's1' });
    expect(fieldsOf(doc().edits, { kind: 'step', id: 's1' }).entryCondition).toBe(2);
    expect(shownDesignOf(doc())!.graph.steps.get('s1')!.entryCondition).toBe(2);
  });

  it('set_field on the assignment drills to it; invalid JSON is refused with the Inspector\'s message, nothing typed', async () => {
    const { call, doc } = await setup();
    const bad = done(await call('set_field', { target: { kind: 'assignment', step: 'a' }, field: 'payload', value: '{"k":' }));
    expect(bad.ok).toBe(false);
    expect(bad.result).toContain('Not valid JSON');
    expect(fieldsOf(doc().edits, { kind: 'assignment', id: 'a1', stepId: 's1' })).toEqual({});
    const good = done(await call('set_field', { target: { kind: 'assignment', step: 'a' }, field: 'payload', value: { k: 2 } }));
    expect(good).toMatchObject({ ok: true, action: 'payload of a\'s assignment set to {"k":2}' });
    expect(targetKey(shownTargetOf(doc()))).toBe('assignment:a1');
    expect(doc().selection).toEqual({ kind: 'step', stepId: 's1' });
    expect(fieldsOf(doc().edits, { kind: 'assignment', id: 'a1', stepId: 's1' }).payload).toBe('{"k":2}');
  });

  it('a cron the Inspector cannot read is typed as the user would, its note in the result (only the server rejects it)', async () => {
    const { call, doc } = await setup();
    const r = done(await call('set_field', { target: { kind: 'workflow' }, field: 'cronExpression', value: 'every day' }));
    expect(r.ok).toBe(true);
    expect(r.result).toContain('the Inspector notes: A cron expression has 5 fields');
    expect(fieldsOf(doc().edits, { kind: 'workflow' }).cronExpression).toBe('every day');
    const good = done(await call('set_field', { target: { kind: 'workflow' }, field: 'cronExpression', value: '0 6 * * *' }));
    expect(good.result).not.toContain('the Inspector notes');
  });

  it('a refused field names what it was for', async () => {
    const { call } = await setup();
    expect(done(await call('set_field', { target: { kind: 'step', step: 'zz' }, field: 'name', value: 'x' })).action).toBe('set name of step zz');
  });

  it('set_field on a schema drills step → processor → schema and makes the copy, as the Inspector does', async () => {
    const { call, doc } = await setup();
    const r = done(await call('set_field', { target: { kind: 'schema', step: 'a', slot: 'config' }, field: 'definition', value: '{"type":"string"}' }));
    expect(r.ok).toBe(true);
    expect(doc().inspector.trail.map((t) => t.kind)).toEqual(['processor', 'schema']);
    expect(Object.keys(doc().edits.schemas)).toEqual(['p1:config']);
  });

  it('set_field on a step the user deleted meanwhile: "no step named …", nothing changed', async () => {
    const { call, store, doc } = await setup();
    store.dispatch({ type: 'pick', workflowId: 'wf1', picks: [{ kind: 'node', id: 's2' }] });
    store.dispatch({ type: 'deletePicks', workflowId: 'wf1' });
    const edits = doc().edits;
    const r = done(await call('set_field', { target: { kind: 'step', step: 'b' }, field: 'name', value: 'x' }));
    expect(r.ok).toBe(false);
    expect(r.result).toContain('no step named b');
    expect(doc().edits).toBe(edits);
  });

  it('an unknown field names the fields there are; a bad entry condition names the conditions', async () => {
    const { call } = await setup();
    expect(done(await call('set_field', { target: { kind: 'step', step: 'a' }, field: 'payload', value: '{}' })).result).toContain('name, version, description, entryCondition');
    expect(done(await call('set_field', { target: { kind: 'step', step: 'a' }, field: 'entryCondition', value: 'Sometimes' })).result).toContain('Completed, Failed');
  });

  it('create_assignment shows the new assignment; remove_assignment asks and removes after Yes; revert_entity drops the edits', async () => {
    const { call, doc } = await setup();
    expect(done(await call('create_assignment', { step: 'a' })).result).toContain('already has an assignment');
    const made = done(await call('create_assignment', { step: 'b' }));
    expect(made).toMatchObject({ ok: true, action: '+ assignment of b' });
    expect(made.result).toContain('b-assignment 1.0.0');
    expect(shownTargetOf(doc())?.kind).toBe('assignment');

    expect(DESTRUCTIVE.has('remove_assignment')).toBe(true);
    const q = ask(await call('remove_assignment', { step: 'a' }));
    expect(q).toMatchObject({ text: 'Remove the assignment of step a from orders 1.0.0?', pin: 'wf1' });
    expect(doc().edits.assignments.s1).toBeUndefined();
    expect(done(await call('remove_assignment', { step: 'a' }, 'No')).ok).toBe(false);
    expect(doc().edits.assignments.s1).toBeUndefined();
    const removed = done(await call('remove_assignment', { step: 'a' }, 'Yes'));
    expect(removed).toMatchObject({ ok: true, action: '- assignment of a' });
    expect(removed.result).toContain('Undo brings it back');
    expect(doc().edits.assignments.s1).toMatchObject({ op: 'delete', id: 'a1' });
    // removing an assignment is an Undo step (2026-10-23): undo brings it back and says so, redo removes it again
    expect(done(await call('undo')).result).toContain('back: the assignment of step a');
    expect(doc().edits.assignments.s1).toBeUndefined();
    expect(done(await call('redo')).result).toContain('gone: the assignment of step a');
    expect(doc().edits.assignments.s1).toMatchObject({ op: 'delete', id: 'a1' });

    done(await call('set_field', { target: { kind: 'workflow' }, field: 'description', value: 'feeds' }));
    expect(doc().edits.workflow).not.toBeNull();
    expect(done(await call('revert_entity', { target: { kind: 'workflow' } }))).toMatchObject({ ok: true, action: 'reverted workflow orders' });
    expect(fieldsOf(doc().edits, { kind: 'workflow' })).toEqual({});
  });
});
