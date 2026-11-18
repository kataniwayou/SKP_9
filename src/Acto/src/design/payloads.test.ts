import { describe, expect, it } from 'vitest';
import { board, shared } from './boardFixtures';
import { clearSlot, removeWires, setProcessorField, setSlotSchema, withoutWorkflow } from './edits';
import { assignmentOf, assignmentsOf, linkedBy, removeAssignment, setPayload } from './payloads';

describe('payloads', () => {
  it('edits a payload in place when only this workflow links the row', () => {
    const before = board();
    const s = setPayload(before, 'daily', 'fetch', '{"a":1}', () => 'nope');
    expect(s.assignments['a-daily-fetch'].payload).toBe('{"a":1}');
    expect(Object.keys(s.assignments)).toHaveLength(2);
    expect(before).toEqual(board());
  });
  it('copy-on-write: a row another workflow links is copied for this one', () => {
    const s = setPayload(shared(), 'daily', 'fetch', '{"path":"/x"}', () => 'new1');
    expect(s.assignments.new1).toMatchObject({ stepId: 'fetch', payload: '{"path":"/x"}', updatedAt: null });
    expect(s.workflows.daily.assignmentIds).toContain('new1');
    expect(s.workflows.daily.assignmentIds).not.toContain('a-shared');
    expect(s.workflows.hourly.assignmentIds).toContain('a-shared');
    expect(s.assignments['a-shared'].payload).toBe(shared().assignments['a-shared'].payload);
  });
  it('creates a row when the workflow has none for that step', () => {
    const s = setPayload(board(), 'daily', 'expand', '{"k":2}', () => 'n2');
    expect(s.assignments.n2).toMatchObject({
      stepId: 'expand', name: 'daily-expand', version: '1.0.0', description: null, payload: '{"k":2}', updatedAt: null,
    });
    expect(assignmentOf(s, 'daily', 'expand')?.id).toBe('n2');
    expect(assignmentsOf(s, 'daily').map((a) => a.id)).toEqual(['a-daily-fetch', 'n2']);
  });
  it('removing unlinks, and deletes the row only when nobody links it', () => {
    const s1 = removeAssignment(shared(), 'daily', 'a-shared');
    expect(s1.workflows.daily.assignmentIds).toEqual([]);
    expect(s1.assignments['a-shared']).toBeDefined();
    expect(linkedBy(s1, 'a-shared')).toEqual(['hourly']);
    const s2 = removeAssignment(s1, 'hourly', 'a-shared');
    expect(s2.assignments['a-shared']).toBeUndefined();
  });
  it('a payload on a step the workflow no longer reaches stays listed', () => {
    let b = setPayload(board(), 'daily', 'expand', '{}', () => 'n2');
    b = removeWires(b, [['fetch', 'expand']]);
    expect(assignmentsOf(b, 'daily').map((a) => a.stepId)).toContain('expand');
  });
  it('withoutWorkflow drops the row and its unshared assignments, keeps steps, wires and caches', () => {
    const b = board();
    const s = withoutWorkflow(b, 'daily');
    expect(s.workflows.daily).toBeUndefined();
    expect(s.assignments['a-daily-fetch']).toBeUndefined();
    expect(s.assignments['a-hourly-fetch']).toBeDefined();
    expect(s.steps).toEqual(b.steps);
    expect(s.caches).toEqual(b.caches);
    const t = withoutWorkflow(shared(), 'daily');
    expect(t.assignments['a-shared']).toBeDefined();
    expect(b).toEqual(board());
  });
});

describe('processor and schema edits', () => {
  it('sets a processor field without touching the input', () => {
    const b = board();
    const s = setProcessorField(b, 'p1', 'name', 'renamed');
    expect(s.processors.p1.name).toBe('renamed');
    expect(b.processors.p1.name).toBe('proc');
  });
  it('a slot edit makes a new unsaved schema row and points the slot at it', () => {
    const copy = { id: 'x', name: 'in', version: '1.0.0', description: null, definition: '{}' };
    const s = setSlotSchema(board(), 'p1', 'input', copy, () => 's1');
    expect(s.schemas.s1).toMatchObject({ name: 'in', definition: '{}', updatedAt: null });
    expect(s.processors.p1.inputSchemaId).toBe('s1');
    const t = setSlotSchema(s, 'p1', 'input', { ...copy, name: 'in2' }, () => 's2');
    expect(t.processors.p1.inputSchemaId).toBe('s1');
    expect(t.schemas.s1.name).toBe('in2');
    expect(Object.keys(t.schemas)).toEqual(['s1']);
  });
  it('clears a slot', () => {
    const copy = { id: 'x', name: 'in', version: '1.0.0', description: null, definition: '{}' };
    const s = clearSlot(setSlotSchema(board(), 'p1', 'output', copy, () => 's1'), 'p1', 'output');
    expect(s.processors.p1.outputSchemaId).toBeNull();
  });
});
