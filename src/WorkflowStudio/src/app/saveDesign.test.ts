import { describe, expect, it, vi } from 'vitest';
import type { StudioApi } from '../api/client';
import { assignmentDto, cacheDto, graphDto, processorDto, schemaDto, stepDto, workflowDto } from '../api/fixtures';
import type { WorkflowGraphDto } from '../api/types';
import { applyDesign } from '../design/apply';
import { EMPTY_EDITS, removeAssignment, setField } from '../design/design';
import { EMPTY_DRAFT, loosen, loosenHead, loosenStart } from '../design/draft';
import { designDirty } from '../store/studioState';
import { createStudioStore } from '../store/studioStore';
import { loadedDocument } from './fixtures';
import { buildDesignRequest, saveDesign } from './saveDesign';

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
    const draft = { ...EMPTY_DRAFT, next: { s1: [] } };

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

  it('never sends a loose wire as a next step, and keeps it in the layout (Review Focus 5)', async () => {
    const base = await loadedDocument(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
    const draft = loosen(EMPTY_DRAFT, base, 's1->s2', 'l1', { x: 904, y: 400 });

    const body = buildDesignRequest(base, applyDesign(base, draft, EMPTY_EDITS), { draft, edits: EMPTY_EDITS });

    expect(body.steps).toEqual([{ id: 's1', updatedAt: expect.any(String), fields: {}, nextStepIds: [] }]);
    expect(body.workflow.entryStepIds).toBeNull();
    expect(body.layout.loose).toEqual({ l1: { source: 's1', end: { x: 904, y: 400 } } });
  });

  it('never sends a wire loose at its start: its target loses it, an entry wire leaves the entry list; the layout keeps it', async () => {
    const base = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1', 's3'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2'), stepDto('s3')],
    }));
    let draft = loosenStart(EMPTY_DRAFT, base, 's1->s2', 't1', { x: 304, y: 600 }, 96);
    draft = loosenStart(draft, base, 'wf->s3', 't2', { x: 40, y: 600 }, 80);

    const body = buildDesignRequest(base, applyDesign(base, draft, EMPTY_EDITS), { draft, edits: EMPTY_EDITS });

    expect(body.steps).toEqual([{ id: 's1', updatedAt: expect.any(String), fields: {}, nextStepIds: [] }]);
    expect(body.workflow.entryStepIds).toEqual(['s1']);
    expect(JSON.stringify(body.steps)).not.toContain('s2');
    expect(body.layout.loose).toEqual({
      t1: { open: 'start', target: 's2', start: { x: 304, y: 600 }, landing: 96, contact: null, was: 's1->s2' },
      t2: { open: 'start', target: 's3', start: { x: 40, y: 600 }, landing: 80, contact: null, was: 'wf->s3' },
    });
  });

  it('never sends a wire open at both ends; the layout keeps it', async () => {
    const base = await loadedDocument(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
    const draft = loosenHead(loosenStart(EMPTY_DRAFT, base, 's1->s2', 'b1', { x: 304, y: 600 }, null), 'b1', { x: 904, y: 600 });
    const body = buildDesignRequest(base, applyDesign(base, draft, EMPTY_EDITS), { draft, edits: EMPTY_EDITS });
    expect(body.steps).toEqual([{ id: 's1', updatedAt: expect.any(String), fields: {}, nextStepIds: [] }]);
    expect(body.workflow.entryStepIds).toBeNull();
    expect(body.layout.loose).toEqual({ b1: { open: 'both', start: { x: 304, y: 600 }, end: { x: 904, y: 600 }, was: 's1->s2' } });
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
});
