import { describe, expect, it, vi } from 'vitest';
import type { StudioApi } from '../api/client';
import { assignmentDto, cacheDto, graphDto, processorDto, schemaDto, stepDto, workflowDto } from '../api/fixtures';
import type { WorkflowGraphDto } from '../api/types';
import { applyDesign, applyEdits } from '../design/apply';
import { EMPTY_EDITS, removeAssignment, setField } from '../design/design';
import { addCircuitWire, moveWire, setEnd } from '../circuit/circuit';
import { circuitOf, EMPTY_DRAFT, moveBlocks, removeWires, setShape, withCircuit } from '../design/draft';
import { designDirty } from '../store/studioState';
import { createStudioStore } from '../store/studioStore';
import { loadedDocument } from './fixtures';
import { loadDocument } from './loadDocument';
import { buildDesignRequest, saveDesign, type DesignRequest } from './saveDesign';
import { setBends, type Circuit } from '../circuit/circuit';
import { shapeFromPoints } from '../layout/shape';
import type { Pt } from '../layout/router';

const setShapeOf = (c: Circuit, id: string, core: Pt[]): Circuit => setBends(c, id, shapeFromPoints(core));

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

  it('keeps a self-link the workflow already has: a block nudge sends no step change (final review I1)', async () => {
    const base = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1'] }),
      steps: [stepDto('s1', { nextStepIds: ['s1', 's2'] }), stepDto('s2')],
    }));
    const s2 = base.placement.steps.get('s2')!;
    const draft = moveBlocks(EMPTY_DRAFT, base, new Map([['s2', { x: s2.x + 16, y: s2.y }]]));

    const body = buildDesignRequest(base, applyDesign(base, draft, EMPTY_EDITS), { draft, edits: EMPTY_EDITS });
    expect(body.steps).toEqual([]);

    // a circuit of the draft's own (a tail moved round the hub) still keeps it
    const angled = withCircuit(draft, base, setEnd(circuitOf(base, draft), 'wf->s1', 'tail', { on: 'hub', angle: 90 }));
    expect(angled.next).toEqual({});
    expect(buildDesignRequest(base, applyDesign(base, angled, EMPTY_EDITS), { draft: angled, edits: EMPTY_EDITS }).steps).toEqual([]);
  });

  it('a head junction fans in: a new wire from s3 poured into s1 -> s2 sends s3 -> s2', async () => {
    const base = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1', 's3'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2'), stepDto('s3')],
    }));
    const draft = withCircuit(EMPTY_DRAFT, base, addCircuitWire(circuitOf(base, EMPTY_DRAFT), 'w:f', { tail: { on: 'step', step: 's3', y: null }, head: { on: 'wire', host: 's1->s2', at: 40 } }));

    const body = buildDesignRequest(base, applyDesign(base, draft, EMPTY_EDITS), { draft, edits: EMPTY_EDITS });

    expect(body.steps.map((s) => [s.id, s.nextStepIds])).toEqual([['s3', ['s2']]]);
    expect(body.workflow.entryStepIds).toBeNull();
  });

  it('a tail on an entry wire fans out: the new step joins the entry list', async () => {
    const base = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')],
    }));
    const draft = withCircuit(EMPTY_DRAFT, base, addCircuitWire(circuitOf(base, EMPTY_DRAFT), 'w:t', { tail: { on: 'wire', host: 'wf->s1', at: 40 }, head: { on: 'step', step: 's2', y: null } }));

    const body = buildDesignRequest(base, applyDesign(base, draft, EMPTY_EDITS), { draft, edits: EMPTY_EDITS });

    expect(body.workflow.entryStepIds).toEqual(['s1', 's2']);
    expect(body.steps).toEqual([]);
  });

  it('a design that only shapes wires sends no list', async () => {
    const base = await loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: ['s1'] }), steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
    const draft = setShape(EMPTY_DRAFT, base, 's1->s2', { bends: { xs: [600], ys: [] }, landing: 80 });
    expect(draft.wires).not.toBeNull();

    const body = buildDesignRequest(base, applyDesign(base, draft, EMPTY_EDITS), { draft, edits: EMPTY_EDITS });

    expect([body.steps, body.workflow.entryStepIds]).toEqual([[], null]);
  });

  it('a rewired list keeps an id the workflow lacks where the saved one has it, as the canvas does', async () => {
    const base = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1', 'ghost'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2', 'ghost'] }), stepDto('s2'), stepDto('s3')],
    }));
    let c = addCircuitWire(circuitOf(base, EMPTY_DRAFT), 'w:g', { tail: { on: 'step', step: 's1', y: null }, head: { on: 'step', step: 's3', y: null } });
    c = addCircuitWire(c, 'w:h', { tail: { on: 'hub', angle: null }, head: { on: 'step', step: 's2', y: null } });
    const draft = withCircuit(EMPTY_DRAFT, base, c);

    const body = buildDesignRequest(base, applyDesign(base, draft, EMPTY_EDITS), { draft, edits: EMPTY_EDITS });

    expect(body.steps.map((s) => [s.id, s.nextStepIds])).toEqual([['s1', ['s2', 'ghost', 's3']]]);
    expect(body.workflow.entryStepIds).toEqual(['s1', 'ghost', 's2']);
  });
});

/** The Save's one-line verdict among Output's lines. */
const verdict = (store: ReturnType<typeof createStudioStore>) => {
  const line = store.getState().output.find((l) => /^(Saved|Not saved)/.test(l.text));
  return line && { text: line.text, level: line.level };
};

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

  it('applied: the workflow is read again with GETs, no errors; Output logs the save from start to alignment', async () => {
    const store = await storeWithChange();
    const log = [
      { stage: 'store', level: 'info', kind: 'workflow', id: null, message: 'design stored on the workflow (the design and its layout), whatever the dry run finds' },
      { stage: 'outcome', level: 'info', kind: 'outcome', id: null, message: 'committed: the entities hold the design; the stored design is emptied' },
    ];
    const api = apiWith({ ok: true, value: { applied: true, errors: [], log } });

    await saveDesign(api, store, 'wf1', NOW);

    expect(api.saveDesign).toHaveBeenCalledTimes(1);
    expect(api.getGraph).toHaveBeenCalledWith('wf1');
    const d = store.getState().docs[0]!;
    expect([d.saving, d.errors, designDirty(d)]).toEqual([false, null, false]);
    expect(store.getState().output.map((l) => l.text)).toEqual([
      'Save started: sending the layout only',
      'BaseApi · design stored on the workflow (the design and its layout), whatever the dry run finds',
      'BaseApi · committed: the entities hold the design; the stored design is emptied',
      'Saved and applied',
      'graph re-read: 1 step, 1 link',
      'drawing: the workflow\'s own wires, nothing to settle',
      'nothing left stored: the entities hold the design, the layout is kept',
    ]);
    expect(store.getState().output[0]).toEqual({ at: '2026-10-07T12:00:00.000Z', workflowId: 'wf1', name: 'orders', text: 'Save started: sending the layout only', level: 'info' });
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
    expect(verdict(store)).toEqual({ text: 'Saved; not applied: 1 error', level: 'error' });
  });

  it('a request that never got an answer stores nothing: Output says why, the edits stay, nothing is read', async () => {
    const store = await storeWithChange();
    const api = apiWith({ ok: false, error: { kind: 'network', message: 'down' } });

    await saveDesign(api, store, 'wf1', NOW);

    const d = store.getState().docs[0]!;
    expect(api.getGraph).not.toHaveBeenCalled();
    expect([d.saving, designDirty(d)]).toEqual([false, true]);
    expect(store.getState().output.map((l) => [l.level, l.text])).toEqual([['info', 'Save started: sending the layout only'], ['error', 'Not saved: Network error: down']]);
  });

  it('sends nothing when there is nothing to save', async () => {
    const store = createStudioStore();
    store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
    store.dispatch({ type: 'loaded', workflowId: 'wf1', doc: await loadedDocument(graphDto()) });
    const api = apiWith({ ok: true, value: { applied: true, errors: [] } });

    await saveDesign(api, store, 'wf1', NOW);

    expect(api.saveDesign).not.toHaveBeenCalled();
  });

  // an api whose GETs read back what the last Save sent: BaseApi applied it and kept its layout
  const appliedApi = (after: (sent: DesignRequest) => WorkflowGraphDto) => {
    const api = apiWith({ ok: true, value: { applied: true, errors: [] } });
    vi.mocked(api.getGraph).mockImplementation(async () => ({ ok: true, value: after(vi.mocked(api.saveDesign).mock.calls.at(-1)![1] as unknown as DesignRequest) }));
    return api;
  };

  it("a short-circuited design is sent and stored as drawn: the net's sources keep their loaded lists, their other changes wait, an untouched step's change is applied (plan 9 §7)", async () => {
    const steps = (s3: 1 | 2, s4: string[]) => [
      stepDto('s1', { nextStepIds: ['s2', 's3', 's7'] }), stepDto('s2'), stepDto('s3', { entryCondition: s3 }),
      stepDto('s4', { nextStepIds: s4 }), stepDto('s5'), stepDto('s6'), stepDto('s7'),
    ];
    const workflow = workflowDto({ entryStepIds: ['s1', 's4'] });
    const base = await loadedDocument(graphDto({ workflow, steps: steps(1, ['s5', 's6', 's7']) }));
    const drawn = createStudioStore();
    drawn.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
    drawn.dispatch({ type: 'loaded', workflowId: 'wf1', doc: base });
    // s1 -> s3 taps s1 -> s2 (one Completed net); s1 also gains a plain wire into s6 and loses s1 -> s7; s4 -> s5 goes
    let c = setEnd(circuitOf(base, EMPTY_DRAFT), 's1->s3', 'tail', { on: 'wire', host: 's1->s2', at: 40 });
    c = addCircuitWire(c, 'w:n', { tail: { on: 'step', step: 's1', y: null }, head: { on: 'step', step: 's6', y: null } });
    drawn.dispatch({ type: 'design', workflowId: 'wf1', draft: removeWires(withCircuit(EMPTY_DRAFT, base, c), base, ['s1->s7', 's4->s5'], () => null) });
    // then the Inspector makes s3 Failed: the net is short-circuited
    const edits = setField(EMPTY_EDITS, { kind: 'step', id: 's3' }, stepDto('s3'), 'entryCondition', 2, () => 'x');
    const store = createStudioStore({ ...drawn.getState(), docs: drawn.getState().docs.map((d) => ({ ...d, edits })) });
    const api = appliedApi((sent) => graphDto({ workflow, steps: steps(2, ['s6', 's7']), layout: sent.layout as never }));

    await saveDesign(api, store, 'wf1', NOW);

    expect(api.saveDesign).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(api.saveDesign).mock.calls[0]![1] as unknown as DesignRequest;
    // s1 has wires in the shorted net: its loaded list stays (null: unchanged), so nothing through the net is dropped or added
    expect(sent.steps.map((s) => [s.id, s.nextStepIds])).toEqual([['s3', null], ['s4', ['s6', 's7']]]);
    expect(sent.workflow.entryStepIds).toBeNull();
    expect(sent.layout.wires['s1->s3']!.tail).toEqual({ on: 'wire', host: 's1->s2', at: 40 });
    const short = { kind: 'step', id: 's3', stage: 'wires', field: null, message: 'short circuit: Completed meets Failed' };
    expect(store.getState().docs[0]!.errors).toEqual([short]);
    expect(verdict(store)?.text).toBe('Saved and applied; 1 short circuit not written; 2 links held back until fixed');

    // the drawing waits, after the answer and after a reload: w:n stays, s1 -> s7 does not come back
    const wiresOf = (d: { design: { draft: { wires: unknown } } }) => Object.keys(d.design.draft.wires ?? {}).sort();
    const expected = ['s1->s2', 's1->s3', 's4->s6', 's4->s7', 'w:n', 'wf->s1', 'wf->s4'];
    const after = store.getState().docs[0]!;
    expect([wiresOf(after), designDirty(after)]).toEqual([expected, false]);
    const reopened = createStudioStore();
    reopened.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
    const reread = await loadDocument(api, 'wf1');
    expect(reread.ok).toBe(true);
    reopened.dispatch({ type: 'loaded', workflowId: 'wf1', doc: reread.ok ? reread.value : base });
    expect(wiresOf(reopened.getState().docs[0]!)).toEqual(expected);
  });

  it("a short circuit on the hub's net keeps the loaded entry list; a new entry wire waits and stays drawn (plan 9 §7)", async () => {
    const workflow = workflowDto({ entryStepIds: ['s1', 's2'] });
    const graph = graphDto({ workflow, steps: [stepDto('s1', { nextStepIds: ['s3'] }), stepDto('s2', { entryCondition: 2 }), stepDto('s3')] });
    const base = await loadedDocument(graph);
    const store = createStudioStore();
    store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
    store.dispatch({ type: 'loaded', workflowId: 'wf1', doc: base });
    // wf -> s2 taps wf -> s1: Completed meets Failed on the hub's own net; a new wire from the hub into s3
    let c = setEnd(circuitOf(base, EMPTY_DRAFT), 'wf->s2', 'tail', { on: 'wire', host: 'wf->s1', at: 40 });
    c = addCircuitWire(c, 'w:e', { tail: { on: 'hub', angle: null }, head: { on: 'step', step: 's3', y: null } });
    store.dispatch({ type: 'design', workflowId: 'wf1', draft: withCircuit(EMPTY_DRAFT, base, c) });
    const api = appliedApi((sent) => ({ ...graph, layout: sent.layout as never }));

    await saveDesign(api, store, 'wf1', NOW);

    const sent = vi.mocked(api.saveDesign).mock.calls[0]![1] as unknown as DesignRequest;
    expect([sent.workflow.entryStepIds, sent.steps]).toEqual([null, []]);
    expect(verdict(store)?.text).toBe('Saved and applied; 1 short circuit not written; 1 link held back until fixed');
    expect(Object.keys(store.getState().docs[0]!.design.draft.wires ?? {})).toContain('w:e');
  });

  it("a wire lying on another net's wire is a short circuit: its source keeps its loaded list, the drawing waits and survives a reload (the user's rule 2, 2026-10-09)", async () => {
    const workflow = workflowDto({ entryStepIds: ['s1', 's3'] });
    const graph = graphDto({ workflow, steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2'), stepDto('s3')] });
    const base = await loadedDocument(graph);
    const store = createStudioStore();
    store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
    store.dispatch({ type: 'loaded', workflowId: 'wf1', doc: base });
    // a new wire s1 -> s3 shaped by hand, and a both-open wire laid exactly on it
    let c = addCircuitWire(circuitOf(base, EMPTY_DRAFT), 'w:n', { tail: { on: 'step', step: 's1', y: null }, head: { on: 'step', step: 's3', y: null } });
    const drawn = applyDesign(base, withCircuit(EMPTY_DRAFT, base, c), EMPTY_EDITS).wires.find((w) => w.id === 'w:n')!;
    c = setShapeOf(c, 'w:n', drawn.core.points);
    c = moveWire(addCircuitWire(c, 'w:f', { tail: { on: 'open', x: 0, y: 0 }, head: { on: 'open', x: 0, y: 0 } }), 'w:f', drawn.points, () => null);
    store.dispatch({ type: 'design', workflowId: 'wf1', draft: withCircuit(EMPTY_DRAFT, base, c) });
    const api = appliedApi((sent) => ({ ...graph, layout: sent.layout as never }));

    await saveDesign(api, store, 'wf1', NOW);

    const sent = vi.mocked(api.saveDesign).mock.calls[0]![1] as unknown as DesignRequest;
    // nothing written for s1: its list stays as BaseApi has it
    expect([sent.workflow.entryStepIds, sent.steps]).toEqual([null, []]);
    expect(Object.keys(sent.layout.wires).sort()).toEqual(['s1->s2', 'w:f', 'w:n', 'wf->s1', 'wf->s3']);
    expect(store.getState().docs[0]!.errors).toEqual([{
      kind: 'wire', id: 'w:n', other: 'w:f', stage: 'wires', field: null, message: 'short circuit: step-s1_1.0.0-s1 → step-s3_1.0.0-s3 overlaps an open end → an open end',
    }]);
    // s1 -> s3 runs only through the shorted net: it is the short circuit's own link, not one held back beside it
    expect(verdict(store)?.text).toBe('Saved and applied; 1 short circuit not written');
    expect(Object.keys(store.getState().docs[0]!.design.draft.wires ?? {}).sort()).toEqual(['s1->s2', 'w:f', 'w:n', 'wf->s1', 'wf->s3']);
    // a fresh read draws it the same
    const reopened = createStudioStore();
    reopened.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
    const reread = await loadDocument(api, 'wf1');
    reopened.dispatch({ type: 'loaded', workflowId: 'wf1', doc: reread.ok ? reread.value : base });
    expect(Object.keys(reopened.getState().docs[0]!.design.draft.wires ?? {}).sort()).toEqual(['s1->s2', 'w:f', 'w:n', 'wf->s1', 'wf->s3']);
  });

  it('a short circuit on an entry wire keeps the loaded entry list; a BaseApi error with it is not applied (plan 9 §7)', async () => {
    const graph = graphDto({
      workflow: workflowDto({ entryStepIds: ['s1', 's2'] }),
      steps: [stepDto('s1'), stepDto('s2', { entryCondition: 2 })],
    });
    const base = await loadedDocument(graph);
    const store = createStudioStore();
    store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
    store.dispatch({ type: 'loaded', workflowId: 'wf1', doc: base });
    // wf -> s2 taps wf -> s1: Completed meets Failed on the hub's own net
    store.dispatch({ type: 'design', workflowId: 'wf1', draft: withCircuit(EMPTY_DRAFT, base, setEnd(circuitOf(base, EMPTY_DRAFT), 'wf->s2', 'tail', { on: 'wire', host: 'wf->s1', at: 40 })) });
    const bad = { kind: 'step', id: 's1', stage: 'steps', field: 'version', message: 'bad' };
    const api = apiWith({ ok: true, value: { applied: false, errors: [bad] } }, graph);

    await saveDesign(api, store, 'wf1', NOW);

    const sent = vi.mocked(api.saveDesign).mock.calls[0]![1] as unknown as DesignRequest;
    expect(sent.workflow.entryStepIds).toBeNull();
    expect(sent.steps).toEqual([]);
    expect(store.getState().docs[0]!.errors).toEqual([{ kind: 'step', id: 's2', stage: 'wires', field: null, message: 'short circuit: Completed meets Failed' }, bad]);
    expect(verdict(store)?.text).toBe('Saved; not applied: 2 errors');
  });
});
