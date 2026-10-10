import { describe, expect, it, vi } from 'vitest';
import type { StudioApi } from '../api/client';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { applyDesign } from '../design/apply';
import { EMPTY_EDITS, setField } from '../design/design';
import { keyCommand } from '../dock/keys';
import { SPHERE_R } from '../layout/geometry';
import { NOT_SAVED_YET, runBlocked } from '../store/run';
import { canSave, designDirty, designOf } from '../store/studioState';
import { createStudioStore } from '../store/studioStore';
import { newWorkflowDocument, untitledName } from './newWorkflow';
import { buildDesignRequest, saveDesign } from './saveDesign';
import { readSession, restoredState, sessionOf, writeSession } from './session';

const ID = '9b0c7a52-1d2e-4c8f-9a51-0f6f3c1e2a77';
const NOW = () => new Date('2026-10-10T12:00:00Z');

async function storeWithNew(name = 'untitled') {
  const store = createStudioStore();
  store.dispatch({ type: 'new', workflowId: ID, doc: await newWorkflowDocument(ID, name) });
  return store;
}

describe('Workspace › New workflow (2026-10-10)', () => {
  it('names it untitled, or the first untitled-N no listed or open workflow has', () => {
    expect(untitledName([])).toBe('untitled');
    expect(untitledName(['orders', 'untitled'])).toBe('untitled-2');
    expect(untitledName(['untitled', 'untitled-2', 'untitled-4'])).toBe('untitled-3');
  });

  it('a blank document: only the hub, on the left; version 1.0.0; nothing read from BaseApi', async () => {
    const doc = await newWorkflowDocument(ID, 'untitled');
    expect(doc.graph.workflow).toMatchObject({ id: ID, name: 'untitled', version: '1.0.0', entryStepIds: [] });
    expect([doc.graph.steps.size, doc.graph.caches.size, doc.wires.length, doc.parkedIds]).toEqual([0, 0, 0, []]);
    // the hub's usual spot: its left edge one margin in
    expect(doc.placement.sphere.cx - SPHERE_R).toBeLessThanOrEqual(64);
  });

  it('opens ready and active, unsaved (Save offered, closing asks); Start, Stop and Delete wait for its first Save', async () => {
    const store = await storeWithNew();
    const d = store.getState().docs[0]!;
    expect([store.getState().activeId, d.status.kind, d.virtual]).toEqual([ID, 'ready', true]);
    expect([designDirty(d), canSave(d)]).toEqual([true, true]);
    expect(runBlocked(d)).toBe(NOT_SAVED_YET);
  });

  it('Save sends newWorkflow with its fields as the design shows them, and no stamp', async () => {
    const store = await storeWithNew();
    const d = store.getState().docs[0]!;
    if (d.status.kind !== 'ready') throw new Error('not ready');
    const base = d.status.doc;
    const edits = setField(EMPTY_EDITS, { kind: 'workflow' }, { id: ID, name: 'untitled', version: '1.0.0', updatedAt: '' } as never, 'name', 'e2e-fresh', () => 'x');
    const design = { ...designOf(d), edits };
    const body = buildDesignRequest(base, applyDesign(base, design.draft, edits), design, true);
    expect(body.newWorkflow).toEqual({ fields: { name: 'e2e-fresh', version: '1.0.0', description: null, cronExpression: null } });
    expect(body.workflow.updatedAt).toBeNull();
    // an ordinary workflow sends no newWorkflow
    expect(buildDesignRequest(base, base, designOf(d)).newWorkflow).toBeUndefined();
  });

  it('a Save BaseApi refuses keeps it new and unsaved, with nothing read back; one it applies makes it an ordinary workflow', async () => {
    const store = await storeWithNew();
    const refused = {
      saveDesign: vi.fn().mockResolvedValue({ ok: true, value: { applied: false, errors: [{ kind: 'workflow', id: ID, stage: 'create', field: 'name', message: 'taken' }] } }),
      getGraph: vi.fn(),
    } as unknown as StudioApi;
    await saveDesign(refused, store, ID, NOW);
    expect(refused.getGraph).not.toHaveBeenCalled();
    let d = store.getState().docs[0]!;
    expect([d.virtual, d.saving, designDirty(d), d.errors?.length]).toEqual([true, false, true, 1]);
    expect((refused.saveDesign as ReturnType<typeof vi.fn>).mock.calls[0]![1].newWorkflow.fields.name).toBe('untitled');
    expect(store.getState().output.map((l) => l.text)).toContain('the new workflow was not created: nothing is stored in BaseApi; its design stays in the studio, unsaved');

    const after = graphDto({ workflow: workflowDto({ id: ID, name: 'untitled', entryStepIds: ['s1'] }), steps: [stepDto('s1')] });
    const applied = {
      saveDesign: vi.fn().mockResolvedValue({ ok: true, value: { applied: true, errors: [] } }),
      getGraph: vi.fn().mockResolvedValue({ ok: true, value: after }),
      getStep: vi.fn(), getProcessor: vi.fn(), getSchema: vi.fn(),
    } as unknown as StudioApi;
    await saveDesign(applied, store, ID, NOW);
    d = store.getState().docs[0]!;
    expect([d.virtual, designDirty(d), runBlocked(d)]).toEqual([false, false, null]);
  });

  it('a refresh keeps it: the session marks it new, and the restored document is built again, its draft kept', async () => {
    const store = await storeWithNew();
    const storage = new Map<string, string>();
    const fake = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) } as unknown as Storage;
    expect(writeSession(fake, sessionOf(store.getState(), new Map(), null))).toBe(true);
    const session = readSession(fake)!;
    expect(session.docs[0]).toMatchObject({ workflowId: ID, name: 'untitled', virtual: true });
    const restored = restoredState(session).docs[0]!;
    expect([restored.virtual, restored.status.kind, designDirty(restored)]).toEqual([true, 'loading', true]);
  });

  it('Ctrl+N is the studio\'s New workflow where the browser lets the page have it', () => {
    expect(keyCommand({ key: 'n', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe('new');
    expect(keyCommand({ key: 'N', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true })).toBeNull();
  });
});
