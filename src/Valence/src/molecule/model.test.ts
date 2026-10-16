import { describe, expect, it } from 'vitest';
import type { ProjectData } from '../api/project';
import project from '../test/fixtures/project.json';
import { atomKey, buildMolecule, reachOf } from './model';

const data = project as ProjectData;

describe('buildMolecule (the cluster data of 2026-10-15)', () => {
  const m = buildMolecule(data);

  it('has one atom per row of the six tables', () => {
    const rows = data.workflows.length + data.steps.length + data.processors.length + data.schemas.length + data.assignments.length + data.caches.length;
    expect(m.atoms.size).toBe(rows);
  });

  it('has one arrow per key column value and per link-table row', () => {
    const links = data.workflows.reduce((n, w) => n + (w.entryStepIds?.length ?? 0) + (w.assignmentIds?.length ?? 0) + (w.cacheIds?.length ?? 0), 0)
      + data.steps.reduce((n, s) => n + (s.nextStepIds?.length ?? 0), 0);
    const columns = data.steps.length + data.assignments.length
      + data.processors.reduce((n, p) => n + [p.inputSchemaId, p.outputSchemaId, p.configSchemaId].filter(Boolean).length, 0);
    expect(m.arrows).toHaveLength(links + columns);
  });

  it('points each arrow from the row that holds the reference', () => {
    const s = data.steps[0]!;
    expect(m.arrows).toContainEqual(expect.objectContaining({ from: atomKey('step', s.id), to: atomKey('proc', s.processorId), kind: 'uses' }));
    const a = data.assignments[0]!;
    expect(m.arrows).toContainEqual(expect.objectContaining({ from: atomKey('asg', a.id), to: atomKey('step', a.stepId), kind: 'asg' }));
  });

  it('fans apart two arrows between the same pair', () => {
    const p = data.processors.find((x) => x.inputSchemaId && x.inputSchemaId === x.outputSchemaId);
    if (!p) return;
    const pair = m.arrows.filter((x) => x.from === atomKey('proc', p.id) && x.to === atomKey('schema', p.inputSchemaId!));
    expect(pair.map((x) => [x.lane, x.lanes])).toEqual([[0, 2], [1, 2]]);
  });

  it('leaves out an arrow to a row BaseApi did not return', () => {
    const broken = { ...data, steps: [{ ...data.steps[0]!, processorId: 'missing' }, ...data.steps.slice(1)] };
    expect(buildMolecule(broken).arrows.filter((x) => x.to === 'proc:missing')).toEqual([]);
  });
});

describe('reachOf', () => {
  it("holds a workflow's steps, their processors and schemas, its assignments and caches", () => {
    const m = buildMolecule(data);
    const w = data.workflows.find((x) => x.name === 'filefetcher-archiveexpander-chain')!;
    const reach = reachOf(m, atomKey('wf', w.id));
    for (const id of w.entryStepIds ?? []) expect(reach.has(atomKey('step', id))).toBe(true);
    for (const id of w.assignmentIds ?? []) expect(reach.has(atomKey('asg', id))).toBe(true);
    for (const id of w.cacheIds ?? []) expect(reach.has(atomKey('cache', id))).toBe(true);
    const steps = [...reach].filter((k) => k.startsWith('step:'));
    for (const k of steps) {
      const s = data.steps.find((x) => atomKey('step', x.id) === k)!;
      expect(reach.has(atomKey('proc', s.processorId))).toBe(true);
      for (const n of s.nextStepIds ?? []) expect(reach.has(atomKey('step', n))).toBe(true);
    }
    // another workflow's hub is not part of it
    expect([...reach].filter((k) => k.startsWith('wf:'))).toEqual([atomKey('wf', w.id)]);
  });
});
