import { describe, expect, it } from 'vitest';
import { deepEqual, reachOf } from './board';
import { board } from './boardFixtures';
import {
  addCache, addEntry, addStep, addWire, addWorkflow, deleteCaches, deleteSteps, linkCache, moveItems,
  removeEntries, removeWires, setCacheField, setStepField, setWorkflowField, unlinkCaches,
} from './edits';

describe('edits', () => {
  it('adds a wire once; the same wire again is refused', () => {
    const r = addWire(board(), 'fetch', 'lonely');
    expect('state' in r && r.state.steps.fetch.nextStepIds).toEqual(['expand', 'lonely']);
    expect(addWire(board(), 'fetch', 'expand')).toEqual({ refused: 'That wire already exists' });
  });
  it('allows a wire from a step to itself', () => {
    expect('state' in addWire(board(), 'fetch', 'fetch')).toBe(true);
  });
  it('adds an entry arrow once', () => {
    expect(addEntry(board(), 'daily', 'fetch')).toEqual({ refused: 'daily already starts at fetch-orders' });
    const r = addEntry(board(), 'daily', 'lonely');
    expect('state' in r && r.state.workflows.daily.entryStepIds).toEqual(['fetch', 'lonely']);
  });
  it('links a cache once', () => {
    expect(linkCache(board(), 'daily', 'c1')).toEqual({ refused: 'daily already uses c1' });
    const r = linkCache(board(), 'hourly', 'c1');
    expect('state' in r && r.state.workflows.hourly.cacheIds).toEqual(['c1']);
  });
  it('removes wires, entries and cache links', () => {
    expect(removeWires(board(), [['fetch', 'expand']]).steps.fetch.nextStepIds).toEqual([]);
    expect(removeEntries(board(), [['daily', 'fetch']]).workflows.daily.entryStepIds).toEqual([]);
    expect(unlinkCaches(board(), [['daily', 'c1']]).workflows.daily.cacheIds).toEqual([]);
  });
  it('deleting a step removes its wires, the entry arrows into it and every payload on it', () => {
    const s = deleteSteps(board(), ['fetch']);
    expect(s.steps.fetch).toBeUndefined();
    expect(s.workflows.daily.entryStepIds).toEqual([]);
    expect(Object.values(s.assignments).some((a) => a.stepId === 'fetch')).toBe(false);
    expect(s.workflows.daily.assignmentIds.every((id) => s.assignments[id])).toBe(true);
    expect(s.workflows.hourly.assignmentIds).toEqual([]);
    const t = deleteSteps(board(), ['expand']);
    expect(t.steps.fetch.nextStepIds).toEqual([]);
  });
  it('deleting a cache unlinks it from every workflow', () => {
    const s = deleteCaches(board(), ['c1']);
    expect(s.caches.c1).toBeUndefined();
    expect(s.workflows.daily.cacheIds).toEqual([]);
  });
  it('moving changes only the location, and never mutates the input', () => {
    const b = board();
    const before = structuredClone(b);
    const m = moveItems(b, [
      { ref: { kind: 'step', id: 'fetch' }, at: { x: 9, y: 9 } },
      { ref: { kind: 'workflow', id: 'daily' }, at: { x: 1, y: 1 } },
    ]);
    expect(m.steps.fetch.at).toEqual({ x: 9, y: 9 });
    expect(m.workflows.daily.at).toEqual({ x: 1, y: 1 });
    expect(deepEqual({ ...m.steps.fetch, at: null }, { ...before.steps.fetch, at: null })).toBe(true);
    expect(b).toEqual(before);
  });
  it("new names are Studio's: untitled, untitled-2, …; cache, cache-2, … [user, 2026-11-19]", () => {
    let b = addWorkflow(board(), { x: 0, y: 0 }, 'w1');
    expect(b.workflows.w1.name).toBe('untitled');
    expect(b.workflows.w1.version).toBe('1.0.0');
    b = addWorkflow(b, { x: 0, y: 0 }, 'w2');
    expect(b.workflows.w2.name).toBe('untitled-2');
    b = addCache(b, { x: 0, y: 0 }, 'k1');
    expect(b.caches.k1.name).toBe('cache');
    b = addCache(b, { x: 0, y: 0 }, 'k2');
    expect(b.caches.k2.name).toBe('cache-2');
    expect(b.caches.k1.updatedAt).toBeNull();
  });
  it('a new step takes the processor name, made unique board-wide', () => {
    const p = board().processors.p1;
    let b = addStep(board(), { ...p, name: 'expand' }, { x: 1, y: 2 }, 's9');
    expect(b.steps.s9).toMatchObject({
      name: 'expand-2', entryCondition: 1, nextStepIds: [], updatedAt: null, processorId: 'p1', version: '1.0.0',
    });
    b = addStep(b, { ...p, name: 'expand' }, { x: 1, y: 2 }, 's10');
    expect(b.steps.s10.name).toBe('expand-3');
  });
  it('field setters change one field', () => {
    expect(setWorkflowField(board(), 'daily', 'cronExpression', '* * * * *').workflows.daily.cronExpression).toBe('* * * * *');
    expect(setStepField(board(), 'fetch', 'name', 'x').steps.fetch.name).toBe('x');
    expect(setCacheField(board(), 'c1', 'root', 'z').caches.c1.root).toBe('z');
  });
  it('reachOf follows wires from the entry steps only', () => {
    expect(reachOf(board(), 'daily')).toEqual(new Set(['fetch', 'expand']));
  });
});
