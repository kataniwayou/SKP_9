import { describe, expect, it } from 'vitest';
import { bwFull, proc } from './fixtures';
import { applyStored, designRequest } from './request';
import { addStep, addWire, moveStep, newWorkflowState, removeWire, setStepField, stateOf } from './state';

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
});
