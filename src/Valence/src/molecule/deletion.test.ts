import { describe, expect, it } from 'vitest';
import type { ProjectData } from '../api/project';
import { canDeleteArrow, canDeleteAtom, goneArrows, NOTHING_REMOVED, type Removed } from './deletion';
import { arrowKey, atomKey, buildMolecule } from './model';

// W1 enters at s1 and s2, binds a1 and caches k1; W2 enters only at s3. s1 and s2 point at each other (a loop) and run
// on p1, which reads c1 and is configured by c2; s3 runs on p2; a1 belongs to s1.
const row = (id: string, name: string) => ({ id, name, version: '1.0.0', description: null });
const data: ProjectData = {
  workflows: [
    { ...row('w1', 'W1'), cronExpression: null, entryStepIds: ['s1', 's2'], assignmentIds: ['a1'], cacheIds: ['k1'] },
    { ...row('w2', 'W2'), cronExpression: null, entryStepIds: ['s3'], assignmentIds: [], cacheIds: [] },
  ],
  steps: [
    { ...row('s1', 's1'), processorId: 'p1', nextStepIds: ['s2'], entryCondition: 1 },
    { ...row('s2', 's2'), processorId: 'p1', nextStepIds: ['s1'], entryCondition: 1 },
    { ...row('s3', 's3'), processorId: 'p2', nextStepIds: [], entryCondition: 1 },
  ],
  processors: [
    { ...row('p1', 'p1'), sourceHash: 'a'.repeat(64), instanceId: null, inputSchemaId: 'c1', outputSchemaId: null, configSchemaId: 'c2' },
    { ...row('p2', 'p2'), sourceHash: 'b'.repeat(64), instanceId: null, inputSchemaId: null, outputSchemaId: null, configSchemaId: null },
  ],
  schemas: [{ ...row('c1', 'c1'), definition: '{}' }, { ...row('c2', 'c2'), definition: '{}' }],
  assignments: [{ ...row('a1', 'a1'), stepId: 's1', payload: '{}' }],
  caches: [{ ...row('k1', 'k1'), root: 'k1', items: '{}' }],
} as unknown as ProjectData;
const m = buildMolecule(data);
const A = (type: Parameters<typeof atomKey>[0], id: string) => atomKey(type, id);
const arrow = (kind: Parameters<typeof arrowKey>[0]['kind'], from: string, to: string) => arrowKey({ kind, from, to });
const atoms = (...keys: string[]): Removed => ({ atoms: keys, arrows: [] });

describe('atom deletion: rule #1, relaxed (spec §6)', () => {
  it('keeps an atom an arrow that can only be re-pointed points at', () => {
    const p1 = canDeleteAtom(m, NOTHING_REMOVED, A('proc', 'p1'));
    expect(p1.ok).toBe(false);
    if (!p1.ok) expect(p1.reason).toMatch(/2 arrows that can only be re-pointed.*s1 → p1.*s2 → p1/);
    // a1 → s1 is an assignment's NOT NULL step: s1 stays until a1 goes
    expect(canDeleteAtom(m, NOTHING_REMOVED, A('step', 's1')).ok).toBe(false);
    expect(canDeleteAtom(m, atoms(A('asg', 'a1')), A('step', 's1')).ok).toBe(true);
  });

  it("keeps a workflow's only entry step", () => {
    const s3 = canDeleteAtom(m, NOTHING_REMOVED, A('step', 's3'));
    expect(s3.ok).toBe(false);
    if (!s3.ok) expect(s3.reason).toMatch(/only entry step of W2/);
    // once the workflow is gone, so is its entry arrow
    expect(canDeleteAtom(m, atoms(A('wf', 'w2')), A('step', 's3')).ok).toBe(true);
  });

  it('lets the deletable arrows pointing at an atom go with it, which opens a loop', () => {
    const s2 = canDeleteAtom(m, NOTHING_REMOVED, A('step', 's2'));
    expect(s2.ok && s2.taking.map(arrowKey).sort()).toEqual([arrow('entry', A('wf', 'w1'), A('step', 's2')), arrow('next', A('step', 's1'), A('step', 's2'))].sort());
    const c1 = canDeleteAtom(m, NOTHING_REMOVED, A('schema', 'c1'));
    expect(c1.ok && c1.taking.map((x) => x.kind)).toEqual(['input']);
    expect(canDeleteAtom(m, NOTHING_REMOVED, A('wf', 'w1')).ok).toBe(true);
    expect(canDeleteAtom(m, NOTHING_REMOVED, A('cache', 'k1')).ok).toBe(true);
  });

  it('refuses an atom already deleted, and counts every arrow touching a deleted atom as gone', () => {
    expect(canDeleteAtom(m, atoms(A('wf', 'w1')), A('wf', 'w1')).ok).toBe(false);
    const gone = goneArrows(m, atoms(A('step', 's2')));
    expect([...gone].sort()).toEqual([
      arrow('entry', A('wf', 'w1'), A('step', 's2')), arrow('next', A('step', 's1'), A('step', 's2')),
      arrow('next', A('step', 's2'), A('step', 's1')), arrow('uses', A('step', 's2'), A('proc', 'p1')),
    ].sort());
  });
});

describe('arrow deletion (spec §6b)', () => {
  it('refuses the two arrows that can only be re-pointed', () => {
    const uses = canDeleteArrow(m, NOTHING_REMOVED, arrow('uses', A('step', 's1'), A('proc', 'p1')));
    expect(uses.ok).toBe(false);
    if (!uses.ok) expect(uses.reason).toMatch(/can only be re-pointed.*steps\.processor_id is NOT NULL/);
    expect(canDeleteArrow(m, NOTHING_REMOVED, arrow('asg', A('asg', 'a1'), A('step', 's1'))).ok).toBe(false);
  });

  it("deletes a workflow's entry arrows down to the last one", () => {
    const first = arrow('entry', A('wf', 'w1'), A('step', 's1'));
    expect(canDeleteArrow(m, NOTHING_REMOVED, first).ok).toBe(true);
    expect(canDeleteArrow(m, { atoms: [], arrows: [first] }, arrow('entry', A('wf', 'w1'), A('step', 's2'))).ok).toBe(false);
    expect(canDeleteArrow(m, NOTHING_REMOVED, arrow('entry', A('wf', 'w2'), A('step', 's3'))).ok).toBe(false);
  });

  it('deletes next-step, assignment, cache and schema arrows', () => {
    for (const k of [
      arrow('next', A('step', 's2'), A('step', 's1')), arrow('wfAsg', A('wf', 'w1'), A('asg', 'a1')),
      arrow('wfCache', A('wf', 'w1'), A('cache', 'k1')), arrow('config', A('proc', 'p1'), A('schema', 'c2')),
    ]) expect(canDeleteArrow(m, NOTHING_REMOVED, k).ok).toBe(true);
  });

  it('refuses an arrow already gone, deleted on its own or with an atom', () => {
    const next = arrow('next', A('step', 's2'), A('step', 's1'));
    expect(canDeleteArrow(m, { atoms: [], arrows: [next] }, next).ok).toBe(false);
    expect(canDeleteArrow(m, atoms(A('step', 's2')), next).ok).toBe(false);
  });
});
