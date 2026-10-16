import { describe, expect, it } from 'vitest';
import { SNAPSHOT } from '../api/fields';
import type { ProjectData } from '../api/project';
import { NOTHING_REMOVED, type Removed } from './deletion';
import { arrowKey, atomKey, buildMolecule } from './model';
import { atomOfChange, planChanges } from './plan';

const H = 'a'.repeat(64);
const base = { version: '1.0.0', description: null };
const data = {
  workflows: [{ id: 'w1', name: 'w1', ...base, entryStepIds: ['s1', 's2'], assignmentIds: ['a1'], cacheIds: ['k1'], cronExpression: null }],
  steps: [
    { id: 's1', name: 's1', ...base, processorId: 'p1', nextStepIds: ['s2'], entryCondition: 1 },
    { id: 's2', name: 's2', ...base, processorId: 'p1', nextStepIds: [], entryCondition: 4 },
  ],
  processors: [{ id: 'p1', name: 'p1', ...base, sourceHash: H, instanceId: null, inputSchemaId: 'c1', outputSchemaId: null, configSchemaId: null }],
  schemas: [{ id: 'c1', name: 'c1', ...base, definition: '{"type":"object"}' }],
  assignments: [{ id: 'a1', name: 'a1', ...base, stepId: 's1', payload: '{}' }],
  caches: [{ id: 'k1', name: 'k1', ...base, root: 'r', items: '{}' }],
} as unknown as ProjectData;
const m = buildMolecule(data);
const arrow = (kind: string, from: string, to: string) => arrowKey(m.arrows.find((x) => x.kind === kind && x.from === from && x.to === to)!);
const W = atomKey('wf', 'w1'), S1 = atomKey('step', 's1'), S2 = atomKey('step', 's2'), P = atomKey('proc', 'p1'), C = atomKey('schema', 'c1'), K = atomKey('cache', 'k1');
const plan = (edits: Record<string, Record<string, string>>, removed: Removed = NOTHING_REMOVED) => planChanges(data, m, edits, removed, SNAPSHOT);
const brief = (p: ReturnType<typeof plan>) => p.map((c) => `${c.op} ${c.table}/${c.id}`);

describe('planChanges: the virtual state as the changes BaseApi would apply', () => {
  it('plans nothing when nothing changed', () => {
    expect(plan({})).toEqual([]);
  });

  it("sends an edited row's whole PUT body: the stored row, the edits typed as the fields are", () => {
    const [c] = plan({ [S2]: { name: 'renamed', entryCondition: '5', description: '' } });
    expect(c).toMatchObject({ op: 'update', table: 'steps', id: 's2', atom: S2 });
    expect(c!.row).toEqual({ name: 'renamed', version: '1.0.0', description: null, processorId: 'p1', nextStepIds: [], entryCondition: 5 });
  });

  it("clears a processor's slot before its schema's new definition (the freeze)", () => {
    const p = plan({ [C]: { definition: '{"type":"array"}' } }, { atoms: [], arrows: [arrow('input', P, C)] });
    expect(brief(p)).toEqual(['update processors/p1', 'update schemas/c1']);
    expect(p[0]!.row).toMatchObject({ inputSchemaId: null, sourceHash: H });
    expect(p[1]!.row).toMatchObject({ definition: '{"type":"array"}' });
  });

  it('drops a deleted arrow from its list', () => {
    expect(plan({}, { atoms: [], arrows: [arrow('next', S1, S2)] })[0]!.row).toMatchObject({ nextStepIds: [] });
    expect(plan({}, { atoms: [], arrows: [arrow('entry', W, S2)] })[0]!.row).toMatchObject({ entryStepIds: ['s1'], assignmentIds: ['a1'], cacheIds: ['k1'] });
  });

  it('deletes an atom after the rows pointing at it drop it', () => {
    expect(brief(plan({}, { atoms: [K], arrows: [] }))).toEqual(['update workflows/w1', 'delete caches/k1']);
    const p = plan({}, { atoms: [S2], arrows: [] });
    expect(brief(p)).toEqual(['update workflows/w1', 'update steps/s1', 'delete steps/s2']);
    expect(p[0]!.row).toMatchObject({ entryStepIds: ['s1'] });
    expect(p[1]!.row).toMatchObject({ nextStepIds: [] });
  });

  it("drops a deleted step's own next-step rows first (a RESTRICT key), and skips the edits of a deleted atom", () => {
    const p = plan({ [S1]: { name: 'x' } }, { atoms: [S1, atomKey('asg', 'a1')], arrows: [] });
    expect(brief(p)).toEqual(['update workflows/w1', 'delete assignments/a1', 'update steps/s1', 'delete steps/s1']);
    expect(p[2]!.row).toMatchObject({ name: 's1', nextStepIds: [] });
  });

  it('maps a change back to its atom', () => {
    expect(atomOfChange('schemas', 'c1')).toBe(C);
    expect(atomOfChange('nope', 'x')).toBeNull();
  });
});
