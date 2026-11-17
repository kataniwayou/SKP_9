import { describe, expect, it } from 'vitest';
import { AUDIT } from '../model/fixtures';
import { bwFull, proc } from './fixtures';
import { applyStored, designRequest } from './request';
import {
  addCache, addStep, addWire, linkCache, moveStep, newWorkflowState, removeAssignment, removeStep, removeWire, setCacheField,
  setPayload, setStepField, stateOf, swapProcessor, unlinkCache,
} from './state';

describe('design request', () => {
  it('sends only what changed', () => {
    const base = stateOf(bwFull()); const cur = setStepField(moveStep(base, 'b', { x: 500, y: 40 }), 'b', 'name', 'renamed');
    const r = designRequest(base, cur, null);
    expect(r.steps).toEqual([{ id: 'b', updatedAt: '2026-01-01T00:00:00Z', fields: { name: 'renamed' }, nextStepIds: null }]);
    expect(r.newSteps).toBeUndefined(); expect(r.assignments).toEqual([]);
    expect((r.layout as any).steps.b).toEqual({ x: 500, y: 40 });
  });
  it('writes derived first steps and a plain circuit WorkflowStudio reads', () => {
    const cur = removeWire(stateOf(bwFull()), 'a', 'b');
    const r = designRequest(stateOf(bwFull()), (addWire(cur, 'b', 'a') as any).state, null);
    expect(r.workflow!.entryStepIds).toEqual(['b']);
    expect((r.layout as any).wires).toEqual({
      'wf->b': { tail: { on: 'hub', angle: null }, head: { on: 'step', step: 'b', y: null } },
      'b->a': { tail: { on: 'step', step: 'b', y: null }, head: { on: 'step', step: 'a', y: null } } });
    expect((r.layout as any).parked).toEqual(['a', 'b']);
  });
  it('creates a new workflow with its steps', () => {
    const cur = addStep(newWorkflowState('nw', 'new-workflow-1', { x: 0, y: 0 }), proc('p1', 'Analyst'), { x: 28, y: 28 }, 's1');
    const r = designRequest(null, cur, null);
    expect(r.newWorkflow).toEqual({ fields: { name: 'new-workflow-1', version: '1.0.0', description: null, cronExpression: null } });
    expect(r.newSteps).toEqual([{ id: 's1', copyOf: null, processorId: 'p1', fields: { name: 'Analyst', version: '1.0.0', description: null, entryCondition: 1 }, nextStepIds: [] }]);
    expect(r.workflow!.entryStepIds).toEqual(['s1']);
  });
  it('reapplies a stored design as unsaved work', () => {
    const base = stateOf(bwFull());
    const stored = JSON.parse(JSON.stringify({ ...designRequest(base, setStepField(base, 'a', 'name', 'x'), null), layout: undefined }));
    expect(applyStored(base, stored).steps.a!.name).toBe('x');
    expect(applyStored(base, 'garbage')).toBe(base);
  });
  it('round-trips new steps and wires through the stored design', () => {
    const base = stateOf(bwFull());
    let cur = addStep(base, proc('p1', 'Analyst'), { x: 300, y: 28 }, 'n1');
    cur = (addWire(cur, 'b', 'n1') as any).state;
    const back = applyStored(base, JSON.parse(JSON.stringify(designRequest(base, cur, null))));
    expect(back.steps.n1).toMatchObject({ isNew: true, processorId: 'p1' });
    expect(back.steps.b!.nextStepIds).toEqual(['n1']);
  });
  it('deletes then creates when an assignment is removed and re-added, and round-trips it', () => {
    const base = stateOf(bwFull());
    const cur = setPayload(removeAssignment(base, 'a'), 'a', '{"x":1}', () => 'new-as');
    const r = designRequest(base, cur, null);
    expect(r.assignments!.map((a) => [a.op, a.id])).toEqual([['delete', 'as0'], ['create', 'new-as']]);
    const back = applyStored(base, JSON.parse(JSON.stringify(r)));
    expect(back.assignments.a).toMatchObject({ id: 'new-as', payload: '{"x":1}', isNew: true });
  });
  it('uses stored positions for new steps and stacks otherwise', () => {
    const base = stateOf(bwFull());
    const stored = JSON.parse(JSON.stringify(designRequest(base, addStep(base, proc('p1', 'Analyst'), { x: 9, y: 9 }, 'n1'), null)));
    expect(applyStored(base, stored, { steps: { n1: { x: 321, y: 123 } } }).steps.n1!.at).toEqual({ x: 321, y: 123 });
    expect(applyStored(base, stored, { steps: { n1: 'bad' } }).steps.n1!.at.x).toBe(28);
  });
  it('sends assignment create and update', () => {
    const base = stateOf(bwFull());
    const upd = designRequest(base, setPayload(base, 'a', '{"y":2}', () => 'zz'), null);
    expect(upd.assignments).toEqual([{ op: 'update', id: 'as0', stepId: 'a', updatedAt: '2026-01-01T00:00:00Z', fields: { payload: '{"y":2}' } }]);
    const cre = designRequest(base, setPayload(base, 'b', '{}', () => 'nb'), null);
    expect(cre.assignments).toEqual([{ op: 'create', id: 'nb', stepId: 'b', updatedAt: null,
      fields: { name: 'b-name-assignment', version: '1.0.0', description: null, payload: '{}' } }]);
  });
  it('sends deleted steps with their stamp and drops their assignment op', () => {
    const base = stateOf(bwFull());
    const r = designRequest(base, removeStep(base, 'a'), null);
    expect(r.deletedSteps).toEqual([{ id: 'a', updatedAt: '2026-01-01T00:00:00Z' }]);
    expect(r.assignments).toEqual([]);
  });
  it('sends new caches and cacheIds when a cache is added or unlinked', () => {
    const base = stateOf(bwFull());
    const added = designRequest(base, addCache(base, { id: 'c2', name: 'n', version: '1.0.0', description: null, root: 'r', items: '{}', isNew: true }), null);
    expect(added.newCaches).toEqual([{ id: 'c2', copyOf: null, fields: { name: 'n', version: '1.0.0', description: null, root: 'r', items: '{}' } }]);
    expect([...added.workflow!.cacheIds!].sort()).toEqual(['c1', 'c2']);
    expect(designRequest(base, unlinkCache(base, 'c1'), null).workflow!.cacheIds).toEqual([]);
    expect(designRequest(base, base, null).workflow!.cacheIds).toBeUndefined();
  });
  it('sends an edit to an existing cache linked here, before the link is saved', () => {
    const base = stateOf(bwFull());
    const shared = { id: 'c9', name: 'shared', version: '2.0.0', description: null, root: 'real-root', items: '{"k":1}', audit: AUDIT };
    const cur = setCacheField(linkCache(base, shared), 'c9', 'root', 'new-root');
    const r = designRequest(base, cur, null);
    expect(r.caches).toEqual([{ id: 'c9', fields: { root: 'new-root' } }]);
    expect(r.newCaches).toBeUndefined();
    expect(designRequest(base, linkCache(base, shared), null).caches).toEqual([]);
  });
  it('restores an existing cache linked by a stored design with its real fields and the edit', () => {
    const base = stateOf(bwFull());
    const shared = { id: 'c9', name: 'shared', version: '2.0.0', description: null, root: 'real-root', items: '{"k":1}', audit: AUDIT };
    const stored = JSON.parse(JSON.stringify(designRequest(base, setCacheField(linkCache(base, shared), 'c9', 'name', 'renamed'), null)));
    const back = applyStored(base, stored, null, new Map([['c9', shared]]));
    expect(back.caches.c9).toMatchObject({ name: 'renamed', root: 'real-root', items: '{"k":1}', isNew: false });
    expect(designRequest(base, back, null).caches).toEqual([{ id: 'c9', fields: { name: 'renamed' } }]);
    const plain = applyStored(base, JSON.parse(JSON.stringify(designRequest(base, linkCache(base, shared), null))), null, new Map([['c9', shared]]));
    expect(plain.caches.c9).toMatchObject({ name: 'shared', root: 'real-root' });
  });
  it('sends a processor swap as a step field', () => {
    const base = stateOf(bwFull());
    const r = designRequest(base, swapProcessor(base, 'a', proc('p2', 'Other')), null);
    expect(r.steps).toEqual([{ id: 'a', updatedAt: '2026-01-01T00:00:00Z', fields: { processorId: 'p2' }, nextStepIds: null }]);
  });
  it('sends entryStepIds when the stored list differs from the derived one', () => {
    const base = { ...stateOf(bwFull()), storedEntry: ['b'] };
    expect(designRequest(base, base, null).workflow!.entryStepIds).toEqual(['a']);
    expect(designRequest(stateOf(bwFull()), stateOf(bwFull()), null).workflow!.entryStepIds).toBeUndefined();
  });
});
