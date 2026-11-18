import { describe, expect, it } from 'vitest';
import type { BoardState } from './board';
import { board } from './boardFixtures';
import { affectedWorkflows, boardChanges, changedKeys } from './changes';
import { addCache, addStep, addWire, deleteCaches, deleteSteps, moveItems } from './edits';

const b = board();
const proc = b.processors.p1;
const names = (cs: ReturnType<typeof boardChanges>) => cs.map((c) => `${c.op} ${c.table} ${c.id}`);
const withStep = (s: BoardState, id: string) => addStep(s, proc, { x: 1, y: 2 }, id);
const wire = (s: BoardState, from: string, to: string) => (addWire(s, from, to) as { state: BoardState }).state;

describe('boardChanges', () => {
  it('nothing changed, nothing sent', () => expect(boardChanges(b, b)).toEqual([]));

  it('a stamp-only difference is not a change', () => {
    const cur = { ...b, steps: { ...b.steps, fetch: { ...b.steps.fetch, updatedAt: 'old' } } };
    expect(boardChanges(b, cur)).toEqual([]);
  });

  it('a moved step is one update carrying its location and read stamp', () => {
    expect(boardChanges(b, moveItems(b, [{ ref: { kind: 'step', id: 'fetch' }, at: { x: 5, y: 6 } }]))).toEqual([
      { op: 'update', table: 'steps', id: 'fetch', updatedAt: b.steps.fetch.updatedAt!,
        row: expect.objectContaining({ boardX: 5, boardY: 6, entryCondition: 1, nextStepIds: ['expand'], processorId: 'p1' }) }]);
  });

  it('a null location is sent as null', () => {
    const cur = { ...b, caches: { ...b.caches, c1: { ...b.caches.c1, at: null } } };
    expect(boardChanges(b, cur)[0]!.row).toEqual(expect.objectContaining({ boardX: null, boardY: null }));
  });

  it('updates carry the stamp the board read, not the base one', () => {
    const base = { ...b, steps: { ...b.steps, lonely: { ...b.steps.lonely, updatedAt: 'new' } } };
    const cur = { ...b, steps: { ...b.steps, lonely: { ...b.steps.lonely, updatedAt: 'old', name: 'renamed' } } };
    expect(boardChanges(base, cur)).toEqual([expect.objectContaining({ op: 'update', id: 'lonely', updatedAt: 'old' })]);
  });

  it('a stamped row missing from base is an update, never a create', () => {
    const base = { ...b, steps: { fetch: b.steps.fetch, expand: b.steps.expand } };
    expect(boardChanges(base, b)).toEqual([expect.objectContaining({ op: 'update', table: 'steps', id: 'lonely', updatedAt: b.steps.lonely.updatedAt })]);
  });

  it('orders deletes after the updates that free them', () => {
    const cs = boardChanges(b, deleteSteps(b, ['fetch']));
    const ops = names(cs);
    for (const wf of ['daily', 'hourly']) expect(ops.indexOf(`update workflows ${wf}`)).toBeGreaterThanOrEqual(0);
    for (const x of ['update workflows daily', 'update workflows hourly', 'delete assignments a-daily-fetch', 'delete assignments a-hourly-fetch']) {
      expect(ops.indexOf(x)).toBeGreaterThanOrEqual(0);
      expect(ops.indexOf(x)).toBeLessThan(ops.indexOf('delete steps fetch'));
    }
    expect(cs.find((c) => c.op === 'delete' && c.table === 'steps')!.updatedAt).toBe(b.steps.fetch.updatedAt);
  });

  it('deleting a cache updates the workflows first', () => {
    const ops = names(boardChanges(b, deleteCaches(b, ['c1'])));
    expect(ops.indexOf('update workflows daily')).toBeGreaterThanOrEqual(0);
    expect(ops.indexOf('update workflows daily')).toBeLessThan(ops.indexOf('delete caches c1'));
  });

  it('a new assignment on a new step: step, assignment, then workflow', () => {
    const s = withStep(b, 'n1');
    const cur: BoardState = {
      ...s,
      assignments: { ...s.assignments, an: { id: 'an', stepId: 'n1', name: 'x', version: '1.0.0', description: null, payload: '{}', updatedAt: null } },
      workflows: { ...s.workflows, daily: { ...s.workflows.daily, assignmentIds: ['a-daily-fetch', 'an'] } },
    };
    const cs = boardChanges(b, cur);
    expect(names(cs)).toEqual(['create steps n1', 'create assignments an', 'update workflows daily']);
    expect(cs[1]!.updatedAt).toBeUndefined();
    expect(cs[1]!.row).toEqual({ name: 'x', version: '1.0.0', description: null, stepId: 'n1', payload: '{}' });
  });

  it('two new steps wired to each other: create both bare, then update the wires', () => {
    let s = withStep(withStep(b, 'n1'), 'n2');
    s = wire(wire(wire(s, 'n1', 'n2'), 'n2', 'n1'), 'fetch', 'n1');
    const cs = boardChanges(b, s);
    expect(names(cs)).toEqual(['create steps n1', 'create steps n2', 'update steps fetch', 'update steps n1', 'update steps n2']);
    expect((cs[0]!.row as { nextStepIds: string[] }).nextStepIds).toEqual([]);
    expect(cs[3]!.updatedAt).toBeUndefined();
    expect((cs[3]!.row as { nextStepIds: string[] }).nextStepIds).toEqual(['n2']);
  });

  it('a chain of new steps keeps persisted next ids on create', () => {
    let s = withStep(withStep(b, 'n1'), 'n2');
    s = wire(wire(s, 'n1', 'n2'), 'n1', 'lonely');
    const cs = boardChanges(b, s);
    expect((cs[0]!.row as { nextStepIds: string[] }).nextStepIds).toEqual(['lonely']);
    expect(cs.find((c) => c.op === 'update' && c.id === 'n1')!.row).toEqual(expect.objectContaining({ nextStepIds: ['n2', 'lonely'] }));
  });

  it('a schema copy is created before the processor update pointing at it', () => {
    const cur: BoardState = {
      ...b,
      schemas: { s9: { id: 's9', name: 's', version: '1.0.0', description: null, definition: '{}', audit: proc.audit, updatedAt: null } },
      processors: { p1: { ...proc, configSchemaId: 's9' } },
    };
    const cs = boardChanges(b, cur);
    expect(names(cs)).toEqual(['create schemas s9', 'update processors p1']);
    expect(cs[0]!.row).toEqual({ name: 's', version: '1.0.0', description: null, definition: '{}' });
    expect(cs[1]!.row).toEqual(expect.objectContaining({ configSchemaId: 's9', sourceHash: 'a'.repeat(64) }));
  });

  it('creates a cache with its location', () => {
    expect(boardChanges(b, addCache(b, { x: 3, y: 4 }, 'k1'))).toEqual([
      { op: 'create', table: 'caches', id: 'k1', row: expect.objectContaining({ boardX: 3, boardY: 4, items: '{}' }) }]);
  });

  it('deleted steps go source before target', () => {
    const ops = names(boardChanges(b, deleteSteps(b, ['expand', 'fetch'])));
    expect(ops.indexOf('delete steps fetch')).toBeLessThan(ops.indexOf('delete steps expand'));
  });
});

describe('affectedWorkflows and changedKeys', () => {
  const editExpand = { ...b, steps: { ...b.steps, expand: { ...b.steps.expand, name: 'e2' } } };

  it('every workflow reaching a changed shared step', () => {
    expect(affectedWorkflows(b, editExpand).sort()).toEqual(['daily', 'hourly']);
  });
  it('a change nobody reaches affects nothing', () => {
    expect(affectedWorkflows(b, { ...b, steps: { ...b.steps, lonely: { ...b.steps.lonely, name: 'z' } } })).toEqual([]);
  });
  it('a workflow that stopped reaching a deleted step', () => {
    expect(affectedWorkflows(b, deleteSteps(b, ['expand'])).sort()).toEqual(['daily', 'hourly']);
    const cur = { ...b, workflows: { ...b.workflows, hourly: { ...b.workflows.hourly, entryStepIds: [] } } };
    const unwired = { ...cur, steps: { ...cur.steps, expand: { ...cur.steps.expand, name: 'e2' } } };
    expect(affectedWorkflows(b, unwired).sort()).toEqual(['daily', 'hourly']);
  });
  it('an assignment edited in place affects the workflows linking it, and only them', () => {
    const cur = { ...b, assignments: { ...b.assignments, 'a-daily-fetch': { ...b.assignments['a-daily-fetch'], payload: '{"x":1}' } } };
    expect(affectedWorkflows(b, cur)).toEqual(['daily']);
  });
  it('a workflow row change affects that workflow', () => {
    const cur = { ...b, workflows: { ...b.workflows, hourly: { ...b.workflows.hourly, name: 'h2' } } };
    expect(affectedWorkflows(b, cur)).toEqual(['hourly']);
  });
  it('a changed, created or deleted linked cache affects its workflows only', () => {
    const edited = { ...b, caches: { ...b.caches, c1: { ...b.caches.c1, root: 'z' } } };
    expect(affectedWorkflows(b, edited)).toEqual(['daily']);
    expect(affectedWorkflows(b, deleteCaches(b, ['c1']))).toEqual(['daily']);
    const added = { ...b, caches: { ...b.caches, k: { ...b.caches.c1, id: 'k', updatedAt: null } } };
    expect(affectedWorkflows(b, added)).toEqual([]);
  });
  it('a changed processor affects workflows reaching its steps', () => {
    const cur = { ...b, processors: { p1: { ...proc, description: 'd' } } };
    expect(affectedWorkflows(b, cur).sort()).toEqual(['daily', 'hourly']);
  });
  it('a created or changed schema a processor points at affects workflows reaching its steps', () => {
    const s1 = { id: 's1', name: 's', version: '1.0.0', description: null, definition: '{}', audit: proc.audit, updatedAt: 'T' };
    const withSchema = { ...b, processors: { p1: { ...proc, inputSchemaId: 's1' } }, schemas: { s1 } };
    const edited = { ...withSchema, schemas: { s1: { ...s1, definition: '{"a":1}' } } };
    expect(affectedWorkflows(withSchema, edited).sort()).toEqual(['daily', 'hourly']);
    const created = { ...b, schemas: { s2: { ...s1, id: 's2', updatedAt: null } }, processors: { p1: { ...proc, outputSchemaId: 's2' } } };
    expect(affectedWorkflows(b, created).sort()).toEqual(['daily', 'hourly']);
    const orphan = { ...b, schemas: { s3: { ...s1, id: 's3', updatedAt: null } } };
    expect(affectedWorkflows(b, orphan)).toEqual([]);
  });
  it('changedKeys counts rows, not changes', () => {
    expect([...changedKeys(b, deleteSteps(b, ['fetch']))].sort()).toEqual([
      'assignment:a-daily-fetch', 'assignment:a-hourly-fetch', 'step:fetch', 'workflow:daily', 'workflow:hourly']);
    expect(changedKeys(b, b).size).toBe(0);
  });
});
