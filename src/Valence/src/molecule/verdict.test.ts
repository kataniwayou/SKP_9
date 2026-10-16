import { describe, expect, it } from 'vitest';
import { SNAPSHOT } from '../api/fields';
import type { ChangeResult } from '../api/validate';
import type { PlannedChange } from './plan';
import { dryRunLine, verdictOf } from './verdict';

const planned: PlannedChange[] = [
  { op: 'update', table: 'processors', id: 'p1', row: {}, atom: 'proc:p1', why: '' },
  { op: 'update', table: 'schemas', id: 'c1', row: {}, atom: 'schema:c1', why: '' },
  { op: 'update', table: 'steps', id: 's1', row: {}, atom: 'step:s1', why: '' },
  { op: 'delete', table: 'schemas', id: 'c2', atom: 'schema:c2', why: '' },
];
const result = (index: number, ok: boolean, status: number, problem: ChangeResult['problem'] = null): ChangeResult =>
  ({ index, op: planned[index]!.op, table: planned[index]!.table, id: planned[index]!.id, ok, status, problem });

describe("verdictOf: BaseApi's dry-run answers on atoms and fields", () => {
  const state = verdictOf(planned, {
    kind: 'done', ok: false, results: [
      result(0, true, 200),
      result(1, false, 409, { status: 409, title: 'Schema definition is frozen', detail: 'Schema c1 is referenced by a processor.' }),
      result(2, false, 400, { status: 400, title: 'Validation failed', errors: { Version: ["'Version' is not in the correct format."], 'InputSchemaId.Value': ['x'] } }),
      result(3, false, 422, { status: 422, title: 'Unprocessable Entity', detail: 'Foreign key violation', field: 'input_schema_id' }),
    ],
  }, SNAPSHOT);

  it('marks each atom ok or refused, with validator errors under their fields', () => {
    if (state.kind !== 'done') throw new Error(state.kind);
    expect(state.byAtom['proc:p1']).toEqual({ ok: true, fields: {}, other: [] });
    expect(state.byAtom['step:s1']!.fields).toEqual({ version: ["'Version' is not in the correct format."], inputSchemaId: ['x'] });
    expect(state.byAtom['schema:c1']!.other).toEqual(['Schema definition is frozen — Schema c1 is referenced by a processor.']);
    expect(state.byAtom['schema:c2']!.other).toEqual(['Delete: Unprocessable Entity — Foreign key violation']); // the column is no schema field
    expect(state.refused).toBe(3);
  });

  it('says it in one line for the Output pane', () => {
    const line = dryRunLine(state, planned, (a) => a.split(':')[1]!);
    expect(line).toMatch(/^Dry run by BaseApi: 3 of 4 refused — c1 — Schema definition is frozen/);
    expect(line).toContain("s1 — Version: 'Version' is not in the correct format.");
    const ok = verdictOf(planned.slice(0, 1), { kind: 'done', ok: true, results: [result(0, true, 200)] }, SNAPSHOT);
    expect(dryRunLine(ok, planned.slice(0, 1), (a) => a)).toBe('Dry run by BaseApi: 1 change, all pass (nothing was written).');
    expect(dryRunLine(verdictOf(planned, { kind: 'unavailable', reason: 'this BaseApi has no POST /model/validate yet' }, SNAPSHOT), planned, (a) => a))
      .toBe('Dry run: not available (this BaseApi has no POST /model/validate yet); edits are checked by the rules alone.');
  });

  it('puts a key error under its field when the column is one', () => {
    const s = verdictOf([{ op: 'update', table: 'caches', id: 'k', row: {}, atom: 'cache:k', why: '' }],
      { kind: 'done', ok: false, results: [{ index: 0, op: 'update', table: 'caches', id: 'k', ok: false, status: 409, problem: { title: 'Conflict', detail: 'root already exists.', field: 'root' } }] }, SNAPSHOT);
    expect(s.kind === 'done' && s.byAtom['cache:k']!.fields).toEqual({ root: ['Conflict — root already exists.'] });
  });
});
