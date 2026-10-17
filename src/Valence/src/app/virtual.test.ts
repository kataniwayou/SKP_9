import { describe, expect, it } from 'vitest';
import { SNAPSHOT } from '../api/fields';
import type { ProjectData } from '../api/project';
import { atomKey, buildMolecule } from '../molecule/model';
import { planChanges } from '../molecule/plan';
import { newCreated, virtualData } from './virtual';
import { createWorkspace } from './workspace';

const H = 'a'.repeat(64);
const b = { version: '1.0.0', description: null };
const data = {
  workflows: [{ id: 'w1', name: 'w1', ...b, entryStepIds: ['s1'], assignmentIds: [], cacheIds: [], cronExpression: null }],
  steps: [{ id: 's1', name: 's1', ...b, processorId: 'p1', nextStepIds: [], entryCondition: 1 }],
  processors: [{ id: 'p1', name: 'p1', ...b, sourceHash: H, instanceId: null, inputSchemaId: null, outputSchemaId: null, configSchemaId: null }],
  schemas: [{ id: 'c1', name: 'c1', ...b, definition: '{}' }],
  assignments: [], caches: [],
} as unknown as ProjectData;
const P = atomKey('proc', 'p1'), S = atomKey('step', 's1'), W = atomKey('wf', 'w1'), C = atomKey('schema', 'c1');
const ws = () => { const w = createWorkspace(); w.loaded(data, buildMolecule(data)); return w; };

describe('virtualData: BaseApi rows with what the Toolbox made', () => {
  it('adds made rows and writes drawn arrows into their tail rows', () => {
    const step = newCreated('step', 'p1', [0, 0, 0], 'n1');
    const v = virtualData(data, [step], ['next|step:s1|step:n1', 'input|proc:p1|schema:c1']);
    expect(v.steps.map((s) => s.id)).toEqual(['s1', 'n1']);
    expect(v.steps[0]!.nextStepIds).toEqual(['n1']);
    expect(v.processors[0]!.inputSchemaId).toBe('c1');
    expect(data.steps[0]!.nextStepIds).toEqual([]); // the rows BaseApi gave stay as they were
    expect(buildMolecule(v).atoms.get(atomKey('step', 'n1'))!.name).toBe('new step');
  });
});

describe('the workspace makes atoms and draws arrows (approved 2026-10-17)', () => {
  it('makes an atom only on its mandatory target, pinned, and undo takes it back', () => {
    const w = ws();
    expect(w.create('step', null, [0, 0, 0])).toBeNull();
    expect(w.get().messages.at(-1)!.text).toMatch(/dropped on a processor/);
    const key = w.create('step', P, [1, 2, 3])!;
    expect(w.get().pinned).toBe(key);
    expect(w.get().molecule!.arrows.some((x) => x.from === key && x.to === P && x.kind === 'uses')).toBe(true);
    w.undo();
    expect(w.get().molecule!.atoms.has(key)).toBe(false);
    w.redo();
    expect(w.get().molecule!.atoms.has(key)).toBe(true);
  });

  it('draws an arrow tail first then head, refusing the wrong kinds, itself, a duplicate and a taken slot', () => {
    const w = ws();
    const n = w.create('step', P, [0, 0, 0])!;
    expect(w.draw('next', S, S)).toBe(false);
    expect(w.draw('next', W, S)).toBe(false);
    expect(w.draw('next', S, n)).toBe(true);
    expect(w.draw('next', S, n)).toBe(false);
    expect(w.draw('input', P, C)).toBe(true);
    const c2 = w.create('schema', null, [0, 0, 0])!;
    expect(w.draw('input', P, c2)).toBe(false);
    expect(w.get().messages.at(-1)!.text).toMatch(/already has a processor → input schema/i);
  });

  it('takes back a made atom with the drawn arrows touching it; a deleted arrow drawn again takes its delete back', () => {
    const w = ws();
    const n = w.create('step', P, [0, 0, 0])!;
    w.draw('next', S, n);
    expect(w.remove(n)).toBe(true);
    expect(w.get().created).toEqual([]);
    expect(w.get().added).toEqual([]);
    const entry = `entry|${W}|${S}`;
    const n2 = w.create('step', P, [0, 0, 0])!;
    w.draw('entry', W, n2);
    expect(w.remove(entry)).toBe(true);
    expect(w.get().removed.arrows).toEqual([entry]);
    expect(w.draw('entry', W, S)).toBe(true);
    expect(w.get().removed.arrows).toEqual([]);
    w.undo();
    expect(w.get().removed.arrows).toEqual([entry]);
  });

  it('plans creates first, in dependency order, then the drawn arrows as updates of their tails', () => {
    const w = ws();
    const n = w.create('step', P, [0, 0, 0])!;
    const a = w.create('asg', n, [0, 0, 0])!;
    w.draw('next', S, n);
    const s = w.get();
    const plan = planChanges(s.data!, s.molecule!, s.edits, s.removed, SNAPSHOT, new Set(s.created.map((c) => c.key)), s.added);
    expect(plan.map((c) => `${c.op} ${c.table}`)).toEqual(['create steps', 'create assignments', 'update steps']);
    expect(plan[1]!.row).toMatchObject({ stepId: n.split(':')[1] });
    expect(plan[2]!.row).toMatchObject({ nextStepIds: [n.split(':')[1]] });
    expect(a).toBeTruthy();
  });

  it('a next step between two made steps: created without it, then an update adds it once both exist', () => {
    const w = ws();
    const a = w.create('step', P, [0, 0, 0])!, b = w.create('step', P, [1, 0, 0])!;
    w.draw('next', a, b);
    const s = w.get();
    const plan = planChanges(s.data!, s.molecule!, s.edits, s.removed, SNAPSHOT, new Set(s.created.map((c) => c.key)), s.added);
    expect(plan.map((c) => `${c.op} ${c.id.slice(0, 4)} ${JSON.stringify(c.row?.nextStepIds)}`)).toEqual([
      `create ${a.split(':')[1]!.slice(0, 4)} []`, `create ${b.split(':')[1]!.slice(0, 4)} []`, `update ${a.split(':')[1]!.slice(0, 4)} ${JSON.stringify([b.split(':')[1]])}`,
    ]);
  });
});

describe('copy/paste (the user, 2026-10-17): the Toolbox atom drop with the copied values', () => {
  it('copies only an atom that is neither deleted nor updated, and never an arrow', () => {
    const w = ws();
    expect(w.copy(null)).toBe(false);
    expect(w.copy(`uses|${S}|${P}`)).toBe(false);
    expect(w.get().messages.at(-1)!.text).toMatch(/arrow cannot be copied/);
    w.edit(S, 'description', 'changed', '');
    expect(w.copy(S)).toBe(false);
    expect(w.get().messages.at(-1)!.text).toMatch(/updated atom cannot be copied/);
    w.undo();
    w.draw('input', P, C);
    expect(w.copy(P)).toBe(false); // a drawn arrow updates its tail
    w.undo();
    expect(w.remove(C)).toBe(true);
    expect(w.copy(C)).toBe(false);
    expect(w.get().messages.at(-1)!.text).toMatch(/deleted atom cannot be copied/);
    w.undo();
    expect(w.copy(P)).toBe(true);
    expect(w.get().clipboard).toMatchObject({ type: 'proc', name: 'p1', values: { name: 'p1', version: '1.0.0', instanceId: null } });
    expect(w.get().clipboard!.values).not.toHaveProperty('sourceHash'); // unique: pastes empty
    expect(w.get().clipboard!.values).not.toHaveProperty('inputSchemaId'); // an arrow
  });

  it('pastes under the tile rules, with the values but only the mandatory arrow; one step to undo', () => {
    const w = ws();
    expect(w.copy(S)).toBe(true);
    const copy = w.get().clipboard!;
    expect(w.create('step', null, [0, 0, 0], copy)).toBeNull(); // a step lands on a processor
    const k = w.create('step', P, [0, 0, 0], copy)!;
    const made = w.get().created.find((c) => c.key === k)!;
    expect(made.row).toMatchObject({ name: 's1', version: '1.0.0', entryCondition: 1, processorId: 'p1', nextStepIds: [] });
    expect(w.get().messages.at(-1)!.text).toMatch(/^Pasted a copy of s1 on p1/);
    w.create('step', P, [0, 0, 0], copy); // one copy, many pastes
    expect(w.get().created).toHaveLength(2);
    w.undo(); w.undo();
    expect(w.get().created).toEqual([]);
  });

  it('a made atom copies with its typed texts, which the paste carries as its own edits', () => {
    const w = ws();
    const n = w.create('schema', null, [0, 0, 0])!;
    w.edit(n, 'name', 'typed', '');
    expect(w.copy(n)).toBe(true);
    const k = w.create('schema', null, [1, 1, 1], w.get().clipboard!)!;
    expect(w.get().edits[k]).toEqual({ name: 'typed' });
    expect(w.get().created.find((c) => c.key === k)!.row).toMatchObject({ definition: '{"type":"object"}' });
    w.undo();
    expect(w.get().edits[k]).toBeUndefined();
  });
});
