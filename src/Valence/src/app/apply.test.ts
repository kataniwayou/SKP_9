import { describe, expect, it, vi } from 'vitest';
import { apply, isStale } from '../api/validate';
import type { ProjectData } from '../api/project';
import { atomKey, buildMolecule } from '../molecule/model';
import { planChanges } from '../molecule/plan';
import { SNAPSHOT } from '../api/fields';
import { appliedLine, summarize } from './changes';
import { createWorkspace } from './workspace';

const H = 'a'.repeat(64);
const b = { version: '1.0.0', description: null, updatedAt: '2026-10-17T09:30:00.123456Z' };
const data = {
  workflows: [{ id: 'w1', name: 'flow', ...b, entryStepIds: ['s1'], assignmentIds: [], cacheIds: [], cronExpression: null }],
  steps: [
    { id: 's1', name: 'first', ...b, processorId: 'p1', nextStepIds: ['s2'], entryCondition: 1 },
    { id: 's2', name: 'second', ...b, processorId: 'p1', nextStepIds: [], entryCondition: 1 },
  ],
  processors: [{ id: 'p1', name: 'proc', ...b, sourceHash: H, instanceId: null, inputSchemaId: 'c1', outputSchemaId: null, configSchemaId: null }],
  schemas: [{ id: 'c1', name: 'in', ...b, definition: '{}' }, { id: 'c2', name: 'spare', ...b, definition: '{}' }],
  assignments: [], caches: [],
} as unknown as ProjectData;
const P = atomKey('proc', 'p1'), S1 = atomKey('step', 's1'), S2 = atomKey('step', 's2'), C2 = atomKey('schema', 'c2');
const ws = () => { const w = createWorkspace(); w.loaded(data, buildMolecule(data)); return w; };

describe('the apply (approved 2026-10-17)', () => {
  it('an update or a delete of a row BaseApi holds says when it was read; a create does not', () => {
    const w = ws();
    w.edit(P, 'version', '1.1.0', '1.0.0');
    w.remove(C2);
    const made = w.create('schema', null, [0, 0, 0])!;
    const s = w.get();
    const plan = planChanges(s.data!, s.molecule!, s.edits, s.removed, SNAPSHOT, new Set(s.created.map((c) => c.key)), s.added);
    expect(plan.find((c) => c.op === 'update')).toMatchObject({ atom: P, updatedAt: b.updatedAt });
    expect(plan.find((c) => c.op === 'delete')).toMatchObject({ atom: C2, updatedAt: b.updatedAt });
    expect(plan.find((c) => c.atom === made)!.updatedAt).toBeUndefined();
  });

  it('two deleted steps, one naming the other: every next-step row cleared first, keeping the row as BaseApi holds it', () => {
    const w = ws();
    expect(w.remove(atomKey('wf', 'w1'))).toBe(true);
    expect(w.remove(S2)).toBe(true);
    expect(w.remove(S1)).toBe(true);
    const s = w.get();
    const plan = planChanges(s.data!, s.molecule!, s.edits, s.removed, SNAPSHOT, new Set(), s.added);
    expect(plan.map((c) => `${c.op} ${c.table} ${c.id}`)).toEqual(['delete workflows w1', 'update steps s1', 'delete steps s2', 'delete steps s1']);
    expect(plan[1]!.row).toMatchObject({ processorId: 'p1', nextStepIds: [], name: 'first' });
  });

  it('summarizes every changed atom as the canvas shows it, with what changes and the workflows it affects', () => {
    const w = ws();
    w.edit(P, 'version', '1.1.0', '1.0.0');
    const proc = w.create('proc', null, [0, 0, 0])!;
    const step = w.create('step', P, [0, 0, 0])!;
    w.draw('next', S2, step);
    w.remove(C2);
    const sum = summarize(w.get())!;
    const row = (k: string) => sum.rows.find((r) => r.key === k)!;
    expect(sum.rows.map((r) => r.mode)).toEqual(['new', 'new', 'updated', 'updated', 'deleted']);
    expect(row(proc)).toMatchObject({ mode: 'new', affects: [] });
    expect(row(step).what).toEqual(['made in Valence', 'on proc', 'next of second']);
    expect(row(step).affects).toEqual(['flow']);
    expect(row(P).what).toEqual(['Version 1.0.0 → 1.1.0']);
    expect(row(P).affects).toEqual(['flow']);
    expect(row(S2).what).toEqual([`arrow drawn: next ${'new step'}`]);
    expect(row(C2)).toMatchObject({ mode: 'deleted', what: ['deleted'], affects: [] });
    expect(sum.affects).toEqual(['flow']);
    expect(appliedLine(sum.rows)).toBe('Applied 5 changes to BaseApi (2 created, 2 updated, 1 deleted).');
  });

  it('a deleted atom says what goes with it; an arrow deleted alone is an update of its tail', () => {
    const w = ws();
    w.remove(`next|${S1}|${S2}`);
    const sum = summarize(w.get())!;
    expect(sum.rows).toEqual([expect.objectContaining({ key: S1, mode: 'updated', what: ['arrow deleted: next second'], affects: ['flow'] })]);
    const w2 = ws();
    w2.remove(`input|${P}|${atomKey('schema', 'c1')}`);
    w2.remove(atomKey('schema', 'c1'));
    expect(summarize(w2.get())!.rows.find((r) => r.key === P)!.what).toEqual(['input schema in cleared (deleted)']);
  });

  it('after an apply nothing is virtual: the changes and their history go, the pin follows a made atom to its real key', () => {
    const w = ws();
    const made = w.create('schema', null, [0, 0, 0])!;
    w.edit(P, 'version', '1.1.0', '1.0.0');
    const real = { ...data, schemas: [...data.schemas, { id: 'r9', name: 'real', ...b, definition: '{}' }] } as ProjectData;
    w.applied(real, buildMolecule(real), new Map([[made, atomKey('schema', 'r9')]]), 'Applied 2 changes to BaseApi (1 created, 1 updated).');
    const s = w.get();
    expect([s.created, s.added, s.edits, s.removed.atoms, s.history.past]).toEqual([[], [], {}, [], []]);
    expect(s.pinned).toBe(atomKey('schema', 'r9'));
    expect(s.molecule!.atoms.has(atomKey('schema', 'r9'))).toBe(true);
    expect(s.messages.at(-1)!.text).toMatch(/^Applied 2 changes/);
  });
});

describe('POST /model/apply', () => {
  const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  const planned = [{ op: 'update' as const, table: 'steps', id: 's1', row: { name: 'x' }, atom: S1, why: '', updatedAt: b.updatedAt }];

  it('sends each change with when its row was read, and reads applied, refused and stale answers', async () => {
    const f = answer(200, { ok: true, applied: true, results: [], made: { c: 'r' } });
    expect(await apply(planned, f)).toEqual({ kind: 'applied', results: [], made: { c: 'r' } });
    const sent = JSON.parse((f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1].body as string);
    expect(sent.changes[0]).toEqual({ op: 'update', table: 'steps', id: 's1', row: { name: 'x' }, updatedAt: b.updatedAt });
    const stale = { index: 0, op: 'update', table: 'steps', id: 's1', ok: false, status: 409, problem: { code: 'stale', title: 'Changed since it was read' } };
    const refused = await apply(planned, answer(200, { ok: false, applied: false, results: [stale], made: {} }));
    expect(refused).toEqual({ kind: 'refused', results: [stale] });
    expect(isStale(stale)).toBe(true);
    expect(await apply(planned, answer(404, {}))).toMatchObject({ kind: 'unavailable', reason: 'this BaseApi has no POST /model/apply yet' });
  });
});
