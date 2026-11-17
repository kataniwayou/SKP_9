import { describe, expect, it } from 'vitest';
import { bw } from '../board/fixtures';
import { frameSizeOf } from '../board/placement';
import { AUDIT } from '../model/fixtures';
import { bwFull, proc, procs } from './fixtures';
import {
  addCache, addStep, addWire, boardWorkflowOf, deleteParts, linkCache, moveFrame, moveStep, newWorkflowState, removeAssignment,
  removeStep, removeStepHere, removeWire, resizeFrame, sameState, setCacheField, setPayload, setStepField, setWorkflowField,
  clearSlot, setProcessorField, setSlotField, stateOf, swapProcessor, unlinkCache,
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
    const out = deleteParts(s, ['b'], [], new Set());
    expect(out).toEqual({ state: removeStep(s, 'b'), refused: [] });
    const w = deleteParts(s, [], [['a', 'b']], new Set());
    expect(w.state).toEqual(removeWire(s, 'a', 'b'));
    expect(deleteParts(s, ['b'], [['a', 'b']], new Set()).state.steps.a!.nextStepIds).not.toContain('b');
  });
  describe('removing a shared step from one workflow (removeStepHere)', () => {
    // x → s → t, and y → s2 with y shared: x, s, t, y, s2
    const wired = () => stateOf(bw('w1', ['x', 's', 't', 'y', 's2'], [
      { id: 'x>s', from: 'x', to: 's', condition: 4 }, { id: 's>t', from: 's', to: 't', condition: 4 },
      { id: 'y>s2', from: 'y', to: 's2', condition: 4 },
    ]));
    const billing = () => ['billing'];
    it('a step no other workflow holds is deleted as removeStep deletes it', () => {
      const s = wired();
      expect(removeStepHere(s, 's', new Set(['s2']), billing)).toEqual({ state: removeStep(s, 's') });
    });
    it('a shared step reached from a non-shared source leaves this workflow only: no deletedSteps', () => {
      const s = setPayload(wired(), 's', '{"k":1}', () => 'as9');
      const res = removeStepHere(s, 's', new Set(['s']), billing);
      if (!('state' in res)) throw new Error(res.refused);
      expect(res.state.steps.s).toBeUndefined();
      expect(res.state.steps.x!.nextStepIds).toEqual([]);
      expect(res.state.steps.t).toBeDefined();
      expect(res.state.assignments.s).toBeUndefined();
      expect(res.state.deletedSteps).toEqual({});
    });
    it('a shared first step leaves this workflow with no wire to drop', () => {
      const s = wired();
      const res = removeStepHere(s, 'x', new Set(['x']), billing);
      if (!('state' in res)) throw new Error(res.refused);
      expect(Object.keys(res.state.steps)).toEqual(['s', 't', 'y', 's2']);
      expect(res.state.deletedSteps).toEqual({});
    });
    it('refuses a shared step a shared step of this workflow wires to', () => {
      const s = wired();
      expect(removeStepHere(s, 's2', new Set(['y', 's2']), billing)).toEqual({
        refused: 's2-name is reached from y-name, which billing share too — deleting it here would change them',
      });
    });
    it('deleteParts keeps a refused step and reports why, and still deletes the rest', () => {
      const s = wired();
      const out = deleteParts(s, ['s2', 't'], [], new Set(['y', 's2']), billing);
      expect(out.state.steps.s2).toBeDefined();
      expect(out.state.steps.t).toBeUndefined();
      expect(out.refused).toEqual(['s2-name is reached from y-name, which billing share too — deleting it here would change them']);
    });
    it('deleteParts takes a shared step and the shared step reaching it together, in either pick order', () => {
      const s = wired();
      for (const order of [['s2', 'y'], ['y', 's2']]) {
        const out = deleteParts(s, order, [], new Set(['y', 's2']), billing);
        expect([order, out.refused, out.state.steps.y, out.state.steps.s2]).toEqual([order, [], undefined, undefined]);
      }
    });
  });
const P = { ...proc('p1', 'Analyst'), configSchemaId: 'sc1', inputSchemaId: null };
const SC = { id: 'sc1', name: 'cfg', version: '1', description: null, audit: AUDIT, definition: '{"type":"object"}' };
  describe('processor edits', () => {
    const ids = () => { let n = 0; return () => `copy${++n}`; };
    it('the first definition edit makes one copy with the original name and version; the next edits the same copy', () => {
      const base = stateOf(bwFull());
      const a = setSlotField(base, P, 'config', SC, 'definition', '{', ids());
      const b = setSlotField(a, P, 'config', SC, 'definition', '{}', ids());
      expect(b.processors!.p1!.slots.config).toEqual({ copy: { id: 'copy1', name: 'cfg', version: '1', description: null, definition: '{}' } });
      expect(Object.keys(b.processors!.p1!.slots)).toEqual(['config']);
    });
    it('a copy typed back to the original is removed, and so is a field typed back', () => {
      const base = stateOf(bwFull());
      const a = setSlotField(base, P, 'config', SC, 'definition', 'x', ids());
      expect(sameState(setSlotField(a, P, 'config', SC, 'definition', SC.definition, ids()), base)).toBe(true);
      const f = setProcessorField(base, P, 'name', 'N');
      expect(f.processors!.p1!.fields).toEqual({ name: 'N' });
      expect(sameState(setProcessorField(f, P, 'name', 'Analyst'), base)).toBe(true);
    });
    it('drops a processor edit when no remaining step uses the processor, and keeps it while one does', () => {
      const base = stateOf(bwFull());
      const edited = setProcessorField(base, P, 'name', 'N');
      const one = removeStep(edited, 'a');
      expect(one.processors!.p1).toBeDefined();
      const none = removeStep(one, 'b');
      expect(none.processors).toEqual({});
      expect(deleteParts(edited, ['a', 'b'], [], new Set()).state.processors).toEqual({});
      const swapped = swapProcessor(edited, 'a', proc('p2', 'Other'));
      expect(swapped.processors!.p1).toBeDefined();
      expect(swapProcessor(swapped, 'b', proc('p2', 'Other')).processors).toEqual({});
    });
    it('treats an absent map and an empty one as the same state', () => {
      const base = stateOf(bwFull());
      expect(sameState(base, { ...base, processors: {} })).toBe(true);
    });
    it('clearSlot marks the slot cleared (a slot with none is left alone)', () => {
      const base = stateOf(bwFull());
      expect(clearSlot(base, P, 'config').processors!.p1!.slots.config).toEqual({ cleared: true });
      expect(clearSlot(base, P, 'input')).toBe(base);
    });
    it('shows the edited fields and the copy as the processor schema', () => {
      const b = bwFull();
      const s = setSlotField(setProcessorField(stateOf(b), P, 'name', 'N'), P, 'config', SC, 'definition', 'x', ids());
      const shown = boardWorkflowOf(s, b, new Map([['p1', P]]));
      expect(shown.graph.processors.get('p1')!.name).toBe('N');
      expect(shown.graph.processors.get('p1')!.configSchemaId).toBe('copy1');
      expect(shown.graph.schemas.get('copy1')!.definition).toBe('x');
      expect(boardWorkflowOf(clearSlot(stateOf(b), P, 'config'), b, new Map([['p1', P]])).graph.processors.get('p1')!.configSchemaId).toBeNull();
    });
  });
});
