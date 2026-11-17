import { describe, expect, it } from 'vitest';
import { bw } from '../board/fixtures';
import { frameSizeOf } from '../board/placement';
import { bwFull, proc, procs } from './fixtures';
import {
  addCache, addStep, addWire, boardWorkflowOf, deleteParts, linkCache, moveFrame, moveStep, newWorkflowState, removeAssignment,
  removeStep, removeWire, resizeFrame, sameState, setCacheField, setPayload, setStepField, setWorkflowField,
  stateOf, swapProcessor, unlinkCache,
} from './state';

describe('workflow edit model', () => {
  it('round-trips a loaded workflow', () => {
    const base = bwFull();
    const out = boardWorkflowOf(stateOf(base), base, procs());
    expect(out.wires).toEqual(base.wires);
    expect(out.stepIds).toEqual(base.stepIds);
    expect(out.entryDiff).toEqual({ stops: [], starts: [] });
    expect(out.graph.workflow.name).toBe('orders');
    expect(out.graph.assignments).toHaveLength(1);
    expect([...out.graph.caches.keys()]).toEqual(['c1']);
    expect(sameState(stateOf(base), stateOf(base))).toBe(true);
  });
  it('adds a step with its processor and a unique name', () => {
    const s = addStep(addStep(stateOf(bw('w1', [])), proc('p1', 'Analyst'), { x: 40, y: 40 }, 'n1'), proc('p1', 'Analyst'), { x: 300, y: 40 }, 'n2');
    expect([s.steps.n1!.name, s.steps.n2!.name]).toEqual(['Analyst', 'Analyst-2']);
    expect(s.steps.n2).toMatchObject({ processorId: 'p1', version: '1.0.0', entryCondition: 1, isNew: true });
  });
  it('refuses self, duplicate and unknown wires', () => {
    const s = stateOf(bwFull());
    expect(addWire(s, 'a', 'a')).toEqual({ refused: 'A step cannot wire to itself' });
    expect(addWire(s, 'a', 'b')).toEqual({ refused: 'That wire already exists' });
    expect(addWire(s, 'a', 'zz')).toEqual({ refused: 'A wire stays inside its workflow' });
  });
  it('removes a wire and adds one back', () => {
    const base = bwFull();
    const cut = removeWire(stateOf(base), 'a', 'b');
    expect(boardWorkflowOf(cut, base, procs()).wires).toEqual([]);
    const back = addWire(cut, 'a', 'b');
    expect('state' in back && boardWorkflowOf(back.state, base, procs()).wires).toEqual(base.wires);
  });
  it('removing a step drops its wires and assignment and remembers the deletion', () => {
    const s = removeStep(stateOf(bwFull()), 'a');
    expect(s.steps.a).toBeUndefined(); expect(s.assignments.a).toBeUndefined();
    expect(s.deletedSteps).toEqual({ a: '2026-01-01T00:00:00Z' });
    const t = removeStep(stateOf(bwFull()), 'b');
    expect(t.steps.a!.nextStepIds).toEqual([]);
  });
  it('does not remember the deletion of a new step', () => {
    const s = removeStep(addStep(stateOf(bw('w1', [])), proc('p1', 'A'), { x: 0, y: 0 }, 'n1'), 'n1');
    expect(s.deletedSteps).toEqual({});
  });
  it('clamps a frame resize to its content', () => {
    const s = resizeFrame(stateOf(bwFull()), { w: 10, h: 10 });
    expect(s.frame.w).toBeGreaterThanOrEqual(420); expect(s.frame.h).toBeGreaterThanOrEqual(196);
    expect(s.frame.w).toBeGreaterThanOrEqual(frameSizeOf(new Map([['a', s.steps.a!.at], ['b', s.steps.b!.at]])).w);
  });
  it('keeps room for the cache chip row when resizing a frame with a cache', () => {
    const s = stateOf(bwFull());
    const min = frameSizeOf(new Map([['a', s.steps.a!.at], ['b', s.steps.b!.at]]));
    const fitted = { ...s, frame: { ...s.frame, w: Math.max(min.w, 2 * 28 + 140), h: min.h + 44 } };
    expect(resizeFrame(fitted, { w: fitted.frame.w, h: min.h })).toBe(fitted);
  });
  it('creates an assignment on first payload edit', () => {
    const s = setPayload(stateOf(bw('w1', ['b'])), 'b', '{"x":1}', () => 'as1');
    expect(s.assignments.b).toMatchObject({ id: 'as1', name: 'b-name-assignment', version: '1.0.0', payload: '{"x":1}', isNew: true });
    expect(removeAssignment(s, 'b').assignments.b).toBeUndefined();
  });
  it('returns the same object when nothing changes', () => {
    const s = stateOf(bwFull());
    expect(moveStep(s, 'a', s.steps.a!.at)).toBe(s);
    expect(moveFrame(s, s.frame)).toBe(s);
    expect(setWorkflowField(s, 'name', 'orders')).toBe(s);
    expect(setStepField(s, 'a', 'name', 'a-name')).toBe(s);
    expect(removeWire(s, 'b', 'a')).toBe(s);
    expect(removeStep(s, 'zz')).toBe(s);
    expect(swapProcessor(s, 'a', proc('p1', 'Analyst'))).toBe(s);
  });
  it('swaps a processor and renders the swapped one', () => {
    const base = bwFull();
    const procMap = new Map([...procs(), ['p2', proc('p2', 'Other')]]);
    const s = swapProcessor(stateOf(base), 'a', proc('p2', 'Other'));
    const out = boardWorkflowOf(s, base, procMap);
    expect(out.graph.steps.get('a')!.processorId).toBe('p2');
    expect(out.graph.processors.get('p2')!.name).toBe('Other');
  });
  it('edits fields and caches', () => {
    let s = stateOf(bwFull());
    s = setWorkflowField(s, 'cronExpression', '0 * * * *');
    s = setStepField(s, 'b', 'entryCondition', 2);
    s = setCacheField(s, 'c1', 'root', 'x');
    expect(s.fields.cronExpression).toBe('0 * * * *');
    expect(s.steps.b!.entryCondition).toBe(2);
    expect(s.caches.c1!.root).toBe('x');
    s = unlinkCache(s, 'c1');
    expect(s.caches.c1).toBeUndefined();
    s = linkCache(s, { id: 'c9', name: 'n', version: '1', description: null, root: 'r', items: '{}', audit: { createdAt: '', createdBy: null, updatedAt: '', updatedBy: null } });
    s = addCache(s, { id: 'c8', name: 'n', version: '1.0.0', description: null, root: '', items: '{}', isNew: true });
    expect(Object.keys(s.caches)).toEqual(['c9', 'c8']);
  });
  it('builds a new workflow with no entry diff and keeps the frame at least its content size', () => {
    let s = newWorkflowState('w9', 'fresh', { x: 5, y: 6 });
    s = addStep(s, proc('p1', 'Analyst'), { x: 28, y: 28 }, 'n1');
    const out = boardWorkflowOf(s, null, procs());
    expect(out.entryDiff).toEqual({ stops: [], starts: [] });
    expect(out.graph.workflow).toMatchObject({ id: 'w9', name: 'fresh', version: '1.0.0' });
    expect(out.frame).toMatchObject({ x: 5, y: 6 });
    expect(out.frame.w).toBeGreaterThanOrEqual(420);
    expect(out.graph.processors.get('p1')!.name).toBe('Analyst');
  });
  it('deleteParts removes steps like removeStep, and wires', () => {
    const s = stateOf(bwFull());
    const out = deleteParts(s, ['b'], []);
    expect(out).toEqual(removeStep(s, 'b'));
    const w = deleteParts(s, [], [['a', 'b']]);
    expect(w).toEqual(removeWire(s, 'a', 'b'));
    expect(deleteParts(s, ['b'], [['a', 'b']]).steps.a!.nextStepIds).not.toContain('b');
  });
});
