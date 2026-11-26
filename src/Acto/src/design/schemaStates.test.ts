import { describe, expect, it } from 'vitest';
import type { BoardState } from './board';
import { heldBy, orphanCount, schemaRefs, schemaStates, steplessProcessors } from './schemaStates';

type Slots = { i?: string; o?: string; c?: string };
function mk(opts: { steps?: Record<string, string | null>; procs?: Record<string, Slots>; schemas?: string[] }): BoardState {
  const steps = Object.fromEntries(Object.entries(opts.steps ?? {}).map(([id, processorId]) => [id, { id, processorId }]));
  const processors = Object.fromEntries(Object.entries(opts.procs ?? {}).map(([id, s]) => [id,
    { id, inputSchemaId: s.i ?? null, outputSchemaId: s.o ?? null, configSchemaId: s.c ?? null }]));
  const schemas = Object.fromEntries((opts.schemas ?? []).map((id) => [id, { id }]));
  return { workflows: {}, caches: {}, assignments: {}, steps, processors, schemas } as unknown as BoardState;
}

describe('schemaStates', () => {
  it("a schema used by a step's processor is wired", () => {
    const b = mk({ steps: { s1: 'p1' }, procs: { p1: { i: 'x' } }, schemas: ['x'] });
    expect(schemaStates(b)).toEqual({ x: 'wired' });
    expect(steplessProcessors(b)).toEqual([]);
  });
  it('a schema referenced only by a processor no step uses is held, and that processor is stepless', () => {
    const b = mk({ procs: { p1: { o: 'x' } }, schemas: ['x'] });
    expect(schemaStates(b)).toEqual({ x: 'held' });
    expect(steplessProcessors(b)).toEqual(['p1']);
    expect(heldBy(b, 'x')).toEqual(['p1']);
  });
  it('wired wins over held when both reference it', () => {
    const b = mk({ steps: { s1: 'p1' }, procs: { p1: { i: 'x' }, p2: { i: 'x' } }, schemas: ['x'] });
    expect(schemaStates(b)).toEqual({ x: 'wired' });
  });
  it('a schema no processor references is an orphan; orphanCount counts it', () => {
    const b = mk({ procs: { p1: { i: 'x' } }, schemas: ['x', 'y'] });
    expect(schemaStates(b).y).toBe('orphan');
    expect(orphanCount(b)).toBe(1);
  });
  it('a processor no step uses and with no schema is not stepless', () => {
    expect(steplessProcessors(mk({ procs: { p1: {} } }))).toEqual([]);
  });
  it('two steps sharing a processor give one ref each; one processor using a schema in I and C gives two refs from the same step', () => {
    const b = mk({ steps: { a: 'p1', b: 'p1' }, procs: { p1: { i: 'x', c: 'x' } }, schemas: ['x'] });
    expect(schemaRefs(b)).toEqual([
      { owner: { kind: 'step', id: 'a' }, slot: 'input', schemaId: 'x' },
      { owner: { kind: 'step', id: 'a' }, slot: 'config', schemaId: 'x' },
      { owner: { kind: 'step', id: 'b' }, slot: 'input', schemaId: 'x' },
      { owner: { kind: 'step', id: 'b' }, slot: 'config', schemaId: 'x' },
    ]);
  });
  it('steps come before stepless processors in refs', () => {
    const b = mk({ steps: { s: 'p2' }, procs: { p1: { o: 'x' }, p2: { i: 'x' } }, schemas: ['x'] });
    expect(schemaRefs(b).map((r) => r.owner.kind)).toEqual(['step', 'processor']);
  });
  it('a slot naming a schema not on the board gives no ref', () => {
    const b = mk({ steps: { s: 'p1' }, procs: { p1: { i: 'ghost' } } });
    expect(schemaRefs(b)).toEqual([]);
    expect(steplessProcessors(mk({ procs: { p1: { i: 'ghost' } } }))).toEqual([]);
  });
});
