import { describe, expect, it, vi } from 'vitest';
import type { StudioApi } from '../api/client';
import { assignmentDto, cacheDto, graphDto, processorDto, schemaDto, stepDto, workflowDto } from '../api/fixtures';
import type { WorkflowGraphDto } from '../api/types';
import { applyDesign, applyEdits } from '../design/apply';
import { EMPTY_EDITS, removeAssignment, setField } from '../design/design';
import { addCircuitWire, setEnd } from '../circuit/circuit';
import { circuitOf, EMPTY_DRAFT, removeWires, withCircuit } from '../design/draft';
import { designDirty, designOf } from '../store/studioState';
import { createStudioStore } from '../store/studioStore';
import { loadedDocument } from './fixtures';
import { buildDesignRequest, saveDesign, type DesignRequest } from './saveDesign';

const notFound = { ok: false, error: { kind: 'notFound', status: 404 } } as const;

describe('buildDesignRequest (plan 8 §4.2)', () => {
  it('sends only the changes: loaded stamps, wiring, a schema copy with its re-point, cache fields, assignment operations, the layout', async () => {
    const base = await loadedDocument(graphDto({
      workflow: workflowDto({ updatedAt: 'w0' }),
      steps: [stepDto('s1', { nextStepIds: ['s2'], updatedAt: 't1' }), stepDto('s2', { updatedAt: 't2' })],
      processors: [processorDto('p1', { configSchemaId: 'sc1' })],
      assignments: [assignmentDto('a2', { stepId: 's2', updatedAt: 'ta' })],
      caches: [cacheDto('c1')],
    }));
    let edits = setField(EMPTY_EDITS, { kind: 'step', id: 's2' }, stepDto('s2', { updatedAt: 't2' }), 'name', 'renamed', () => 'x');
    edits = setField(edits, { kind: 'schema', processorId: 'p1', slot: 'config' }, schemaDto('sc1'), 'definition', '{"type":"string"}', () => 'copy1');
    edits = setField(edits, { kind: 'cache', id: 'c1' }, cacheDto('c1'), 'root', 'r2', () => 'x');
    edits = removeAssignment(edits, 's2', { id: 'a2', updatedAt: 'ta' });
    const draft = removeWires(EMPTY_DRAFT, applyEdits(base, edits), ['s1->s2'], () => null);

    const body = buildDesignRequest(base, applyDesign(base, draft, edits), { draft, edits });

    expect(body.workflow).toEqual({ updatedAt: 'w0', fields: {}, entryStepIds: null, cacheIds: null });
    expect(body.steps).toEqual([
      { id: 's1', updatedAt: 't1', fields: {}, nextStepIds: [] },
      { id: 's2', updatedAt: 't2', fields: { name: 'renamed' }, nextStepIds: null },
    ]);
    expect(body.processors).toEqual([{ id: 'p1', fields: {}, slots: { config: 'copy1' } }]);
    expect(body.schemas).toEqual([{ id: 'copy1', name: 'schema-sc1', version: '1.0.0', description: null, definition: '{"type":"string"}' }]);
    expect(body.caches).toEqual([{ id: 'c1', fields: { root: 'r2' } }]);
    expect(body.assignments).toEqual([{ op: 'delete', id: 'a2', stepId: 's2', updatedAt: 'ta', fields: {} }]);
    expect([...body.layout.parked].sort()).toEqual(['s1', 's2']);
  });

  it('never sends a wire open at its head as a next step, and keeps it in the layout (plan 8 Review Focus 5)', async () => {
    const base = await loadedDocument(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
    const draft = withCircuit(EMPTY_DRAFT, base, setEnd(circuitOf(base, EMPTY_DRAFT), 's1->s2', 'head', { on: 'open', x: 904, y: 400 }));

    const body = buildDesignRequest(base, applyDesign(base, draft, EMPTY_EDITS), { draft, edits: EMPTY_EDITS });

    expect(body.steps).toEqual([{ id: 's1', updatedAt: expect.any(String), fields: {}, nextStepIds: [] }]);
    expect(body.workflow.entryStepIds).toBeNull();
    expect(body.layout.wires['s1->s2']).toEqual({ tail: { on: 'step', step: 's1', y: null }, head: { on: 'open', x: 904, y: 400 } });
  });

  it('never sends a wire open at its tail: its step loses it, an entry wire leaves the entry list; the layout keeps both', async () => {
    const base = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1', 's3'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2'), stepDto('s3')],
    }));
    let c = setEnd(circuitOf(base, EMPTY_DRAFT), 's1->s2', 'tail', { on: 'open', x: 304, y: 600 });
    c = setEnd(c, 'wf->s3', 'tail', { on: 'open', x: 64, y: 704 });
    const draft = withCircuit(EMPTY_DRAFT, base, c);

    const body = buildDesignRequest(base, applyDesign(base, draft, EMPTY_EDITS), { draft, edits: EMPTY_EDITS });

    expect(body.steps).toEqual([{ id: 's1', updatedAt: expect.any(String), fields: {}, nextStepIds: [] }]);
    expect(body.workflow.entryStepIds).toEqual(['s1']);
    expect(body.layout.wires['s1->s2']!.tail).toEqual({ on: 'open', x: 304, y: 600 });
    expect(body.layout.wires['wf->s3']!.tail).toEqual({ on: 'open', x: 64, y: 704 });
  });

  it("sends the lists the circuit's current gives: a tail junction fans out; a link made twice is sent once (Review Focus 3)", async () => {
    const base = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2', { nextStepIds: ['s3'] }), stepDto('s3')],
    }));
    let c = setEnd(circuitOf(base, EMPTY_DRAFT), 's2->s3', 'tail', { on: 'wire', host: 's1->s2', at: 40 });
    c = addCircuitWire(c, 'w:d', { tail: { on: 'step', step: 's1', y: null }, head: { on: 'step', step: 's3', y: null } });
    const draft = withCircuit(EMPTY_DRAFT, base, c);

    const body = buildDesignRequest(base, applyDesign(base, draft, EMPTY_EDITS), { draft, edits: EMPTY_EDITS });

    expect(body.steps.map((s) => [s.id, s.nextStepIds])).toEqual([['s1', ['s2', 's3']], ['s2', []]]);
    expect(body.workflow.entryStepIds).toBeNull();
  });

  it('never sends a step as its own next step: a hidden self-loop or one wire on both its sides writes nothing (§2.2-4)', async () => {
    const base = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2'), stepDto('s3')],
    }));
    // s1's output back into s1 through a junction on s1 -> s2, and s3 wired onto itself
    let c = addCircuitWire(circuitOf(base, EMPTY_DRAFT), 'w:a', { tail: { on: 'wire', host: 's1->s2', at: 40 }, head: { on: 'step', step: 's1', y: null } });
    c = addCircuitWire(c, 'w:b', { tail: { on: 'step', step: 's3', y: null }, head: { on: 'step', step: 's3', y: null } });
    const draft = withCircuit(EMPTY_DRAFT, base, c);

    const body = buildDesignRequest(base, applyDesign(base, draft, EMPTY_EDITS), { draft, edits: EMPTY_EDITS });

    for (const s of body.steps) expect(s.nextStepIds ?? []).not.toContain(s.id);
    expect(body.steps).toEqual([]);
    expect(Object.keys(body.layout.wires)).toEqual(expect.arrayContaining(['w:a', 'w:b']));
  });
});

describe('saveDesign (plan 8 §4.1)', () => {
  const NOW = () => new Date('2026-10-07T12:00:00Z');
  async function storeWithChange() {
    const store = createStudioStore();
    store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
    store.dispatch({ type: 'loaded', workflowId: 'wf1', doc: await loadedDocument(graphDto()) });
    store.dispatch({ type: 'design', workflowId: 'wf1', draft: { ...EMPTY_DRAFT, sphere: { x: 400, y: 400 } } });
    return store;
  }
  const apiWith = (answer: unknown, after: WorkflowGraphDto = graphDto()) => ({
    saveDesign: vi.fn().mockResolvedValue(answer),
    getGraph: vi.fn().mockResolvedValue({ ok: true, value: after }),
    getStep: vi.fn().mockResolvedValue(notFound), getProcessor: vi.fn().mockResolvedValue(notFound), getSchema: vi.fn().mockResolvedValue(notFound),
  }) as unknown as StudioApi;

  it('applied: the workflow is read again with GETs, no errors, Output says "Saved and applied"', async () => {
    const store = await storeWithChange();
    const api = apiWith({ ok: true, value: { applied: true, errors: [] } });

    await saveDesign(api, store, 'wf1', NOW);

    expect(api.saveDesign).toHaveBeenCalledTimes(1);
    expect(api.getGraph).toHaveBeenCalledWith('wf1');
    const d = store.getState().docs[0]!;
    expect([d.saving, d.errors, designDirty(d)]).toEqual([false, null, false]);
    expect(store.getState().output).toEqual([{ at: '2026-10-07T12:00:00.000Z', workflowId: 'wf1', name: 'orders', text: 'Saved and applied' }]);
  });

  it('not applied: the stored design stays on the canvas; Problems gets each error, Output the count', async () => {
    const store = await storeWithChange();
    const errors = [{ kind: 'step', id: 's1', stage: 'steps', field: 'version', message: 'bad' }];
    const api = apiWith({ ok: true, value: { applied: false, errors } }, graphDto({ design: { steps: [{ id: 's1', fields: { version: 'abc' } }] } } as never));

    await saveDesign(api, store, 'wf1', NOW);

    const d = store.getState().docs[0]!;
    expect(d.errors).toEqual(errors);
    expect(d.edits.steps['s1']!.fields).toEqual({ version: 'abc' });
    expect(designDirty(d)).toBe(false);
    expect(store.getState().output.at(-1)!.text).toBe('Saved; not applied: 1 error');
  });

  it('a request that never got an answer stores nothing: Output says why, the edits stay, nothing is read', async () => {
    const store = await storeWithChange();
    const api = apiWith({ ok: false, error: { kind: 'network', message: 'down' } });

    await saveDesign(api, store, 'wf1', NOW);

    const d = store.getState().docs[0]!;
    expect(api.getGraph).not.toHaveBeenCalled();
    expect([d.saving, designDirty(d)]).toEqual([false, true]);
    expect(store.getState().output.at(-1)!.text).toBe('Not saved: Network error: down');
  });

  it('sends nothing when there is nothing to save', async () => {
    const store = createStudioStore();
    store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
    store.dispatch({ type: 'loaded', workflowId: 'wf1', doc: await loadedDocument(graphDto()) });
    const api = apiWith({ ok: true, value: { applied: true, errors: [] } });

    await saveDesign(api, store, 'wf1', NOW);

    expect(api.saveDesign).not.toHaveBeenCalled();
  });

  it("a design with a short circuit is not saved: nothing is sent, so BaseApi's links through the net stay; Output says so, the design stays (plan 9 §7)", async () => {
    const graph = graphDto({
      workflow: workflowDto({ entryStepIds: ['s1'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2', 's3'] }), stepDto('s2'), stepDto('s3')],
    });
    const base = await loadedDocument(graph);
    const drawn = createStudioStore();
    drawn.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
    drawn.dispatch({ type: 'loaded', workflowId: 'wf1', doc: base });
    // s1 -> s3 taps s1 -> s2 (one Completed net), then the Inspector makes s3 Failed: the net is short-circuited
    const draft = withCircuit(EMPTY_DRAFT, base, setEnd(circuitOf(base, EMPTY_DRAFT), 's1->s3', 'tail', { on: 'wire', host: 's1->s2', at: 40 }));
    drawn.dispatch({ type: 'design', workflowId: 'wf1', draft });
    const edits = setField(EMPTY_EDITS, { kind: 'step', id: 's3' }, stepDto('s3'), 'entryCondition', 2, () => 'x');
    const store = createStudioStore({ ...drawn.getState(), docs: drawn.getState().docs.map((d) => ({ ...d, edits })) });
    // what the request would carry: the net's links left out, so s1 would lose s2 and s3 if it were applied
    const d0 = store.getState().docs[0]!;
    const shown = applyDesign(base, d0.design.draft, d0.edits);
    expect(buildDesignRequest(base, shown, designOf(d0)).steps.find((s) => s.id === 's1')!.nextStepIds).toEqual([]);
    const api = apiWith({ ok: true, value: { applied: true, errors: [] } }, graph);

    await saveDesign(api, store, 'wf1', NOW);

    expect(api.saveDesign).not.toHaveBeenCalled();
    expect(api.getGraph).not.toHaveBeenCalled();
    const d = store.getState().docs[0]!;
    expect([d.saving, designDirty(d)]).toEqual([false, true]);
    expect(d.status.kind === 'ready' && d.status.doc.graph.steps.get('s1')!.nextStepIds).toEqual(['s2', 's3']);
    expect(store.getState().output.at(-1)!.text).toBe('Not saved: 1 short circuit (see Problems)');
  });

  it('a short circuit drawn into the design is not saved either; once it is undone the Save goes', async () => {
    const graph = graphDto({
      workflow: workflowDto({ entryStepIds: ['s1'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2', 's3'] }), stepDto('s2'), stepDto('s3', { entryCondition: 2 })],
    });
    const base = await loadedDocument(graph);
    const store = createStudioStore();
    store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
    store.dispatch({ type: 'loaded', workflowId: 'wf1', doc: base });
    store.dispatch({ type: 'design', workflowId: 'wf1', draft: withCircuit(EMPTY_DRAFT, base, setEnd(circuitOf(base, EMPTY_DRAFT), 's1->s3', 'tail', { on: 'wire', host: 's1->s2', at: 40 })) });
    const api = apiWith({ ok: true, value: { applied: true, errors: [] } }, graph);

    await saveDesign(api, store, 'wf1', NOW);
    expect(api.saveDesign).not.toHaveBeenCalled();
    expect(store.getState().output.at(-1)!.text).toBe('Not saved: 1 short circuit (see Problems)');

    // the tail back on s1: the net agrees again, only the hub moved
    store.dispatch({ type: 'design', workflowId: 'wf1', draft: { ...EMPTY_DRAFT, sphere: { x: 400, y: 400 } } });
    await saveDesign(api, store, 'wf1', NOW);
    expect(api.saveDesign).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(api.saveDesign).mock.calls[0]![1] as unknown as DesignRequest;
    expect(sent.steps).toEqual([]);
    expect(store.getState().output.at(-1)!.text).toBe('Saved and applied');
  });
});
