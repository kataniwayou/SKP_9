import { describe, expect, it } from 'vitest';
import { bw } from '../board/fixtures';
import { AUDIT } from '../model/fixtures';
import { bwFull, proc } from './fixtures';
import { changedEntities, entityLabel, holders, stepSharing } from './shared';
import { addCache, addStep, addWire, linkCache, moveStep, newWorkflowState, removeStepHere, setCacheField, setProcessorField, setStepField, stateOf, swapProcessor, unlinkCache } from './state';

const base = () => stateOf(bwFull());

describe('changedEntities', () => {
  it('a moved step is no change', () => {
    expect([...changedEntities(base(), moveStep(base(), 'a', { x: 500, y: 500 }))]).toEqual([]);
  });
  it('a renamed step is a step change', () => {
    expect([...changedEntities(base(), setStepField(base(), 'a', 'name', 'x'))]).toEqual(['step:a']);
  });
  it('a new wire out of a step changes that step', () => {
    const b = base();
    const r = addWire(b, 'b', 'a');
    if (!('state' in r)) throw new Error('refused');
    expect([...changedEntities(b, r.state)]).toEqual(['step:b']);
  });
  it('a deleted step is a change, its position is not', () => {
    const b = base();
    const { a: _gone, ...steps } = b.steps;
    expect(changedEntities(b, { ...b, steps, deletedSteps: { a: null } })).toContain('step:a');
  });
  it('a step that only left this workflow (not deleted) is no change to it', () => {
    const b = base();
    const r = removeStepHere(b, 'b', new Set(['b']));
    if (!('state' in r)) throw new Error(r.refused);
    expect([...changedEntities(b, r.state)]).toEqual(['step:a']);
  });
  it('a processor edit is a processor change', () => {
    const b = base();
    expect([...changedEntities(b, setProcessorField(b, proc('p1', 'Analyst'), 'name', 'Other'))]).toEqual(['processor:p1']);
  });
  it('linking or unlinking a cache is no change; editing one is', () => {
    const b = base();
    const c = { id: 'c2', name: 'rates', version: '1', description: null, root: 'r', items: '{}', audit: AUDIT };
    expect([...changedEntities(b, linkCache(b, c))]).toEqual([]);
    expect([...changedEntities(b, unlinkCache(b, 'c1'))]).toEqual([]);
    expect([...changedEntities(b, setCacheField(b, 'c1', 'name', 'x'))]).toEqual(['cache:c1']);
    const linked = linkCache(b, c);
    expect([...changedEntities(b, setCacheField(linked, 'c2', 'root', 'z'))]).toEqual(['cache:c2']);
  });
  it('a new workflow changes only what it holds', () => {
    const s = newWorkflowState('w9', 'fresh', { x: 0, y: 0 });
    expect([...changedEntities(null, s)]).toEqual([]);
    const withStep = addStep(s, proc('p1', 'Analyst'), { x: 46, y: 46 }, 'n1');
    expect([...changedEntities(null, withStep)]).toEqual(['step:n1']);
  });
  it('a step given another processor changes the step', () => {
    const b = base();
    expect([...changedEntities(b, swapProcessor(b, 'a', proc('p2', 'Other')))]).toEqual(['step:a']);
  });
  it('a new unsaved cache is a cache change', () => {
    const b = base();
    const c = { id: 'c9', name: 'fresh', version: '1.0.0', description: null, root: '', items: '{}', isNew: true };
    expect([...changedEntities(b, addCache(b, c))]).toEqual(['cache:c9']);
  });
});

describe('holders and labels', () => {
  const boards = [bw('w1', ['s1', 'a']), bw('w2', ['s1'])];
  it('lists the workflows showing each step, processor and cache', () => {
    const h = holders(boards);
    expect(h.get('step:s1')).toEqual(['w1', 'w2']);
    expect(h.get('step:a')).toEqual(['w1']);
    expect(h.get('processor:p-s1')).toEqual(['w1', 'w2']);
  });
  it('names an entity by kind and name', () => {
    expect(entityLabel('step:s1', boards)).toBe('step s1-name');
    expect(entityLabel('processor:p-s1', boards)).toBe('processor s1-proc');
    expect(entityLabel('cache:c1', [bwFull()])).toBe('cache c1-name');
  });
  it('stepSharing: the steps of a workflow others show too, and the names of those others', () => {
    const three = [...boards, bw('w3', ['s1'])];
    const { shared, others } = stepSharing(three, 'w1');
    expect([...shared]).toEqual(['s1']);
    expect(others('s1')).toEqual(['w2-name', 'w3-name']);
    expect(others('a')).toEqual([]);
  });
});
