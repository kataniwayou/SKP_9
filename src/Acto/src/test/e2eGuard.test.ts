import { describe, expect, it } from 'vitest';
import { refusal, sameDefinition } from '../../e2e/refusal';
import type { Row } from '../../e2e/stack';

const schema: Row = { id: 's1', name: 'real-in', version: '1.0.0', description: null, definition: '{"b":1,"a":{"y":2,"x":1}}', boardX: 1, boardY: 2 };
const proc: Row = { id: 'p1', name: 'real-proc', version: '1.0.0', sourceHash: 'abc', instanceId: null, inputSchemaId: 's1', boardX: 1, boardY: 2 };
const real = new Map<string, Row>([['s1', schema], ['p1', proc]]);

describe('write guard refusal: schemas and processors', () => {
  it('lets a location-only update of a real schema or processor through', () => {
    expect(refusal({ op: 'update', table: 'schemas', id: 's1', row: { ...schema, boardX: 50, boardY: 60 } }, real)).toBeNull();
    expect(refusal({ op: 'update', table: 'processors', id: 'p1', row: { ...proc, boardX: 50, boardY: 60 } }, real)).toBeNull();
  });
  it('accepts a canonically equal definition and refuses a different one', () => {
    expect(refusal({ op: 'update', table: 'schemas', id: 's1', row: { ...schema, definition: '{ "a": {"x":1,"y":2}, "b": 1 }' } }, real)).toBeNull();
    expect(refusal({ op: 'update', table: 'schemas', id: 's1', row: { ...schema, definition: '{"a":1}' } }, real)).toMatch(/definition/);
  });
  it('a non-JSON definition must be byte-identical', () => {
    expect(sameDefinition('not json', 'not json')).toBe(true);
    expect(sameDefinition('not json', 'not  json')).toBe(false);
    expect(sameDefinition('{}', 'nope')).toBe(false);
  });
  it('refuses a name change of a real schema or processor', () => {
    expect(refusal({ op: 'update', table: 'schemas', id: 's1', row: { ...schema, name: 'renamed' } }, real)).toMatch(/name/);
    expect(refusal({ op: 'update', table: 'processors', id: 'p1', row: { ...proc, sourceHash: 'zzz' } }, real)).toMatch(/sourceHash/);
  });
  it('refuses any processor create or delete', () => {
    expect(refusal({ op: 'create', table: 'processors', id: 'n', row: { name: 'e2e-p' } }, real)).toMatch(/processor/);
    expect(refusal({ op: 'delete', table: 'processors', id: 'n' }, real)).toMatch(/processor/);
    expect(refusal({ op: 'delete', table: 'processors', id: 'p1' }, real)).toMatch(/processor/);
  });
  it('creates only e2e- schemas, and deletes only the run own', () => {
    expect(refusal({ op: 'create', table: 'schemas', id: 'n', row: { name: 'e2e-in' } }, real)).toBeNull();
    expect(refusal({ op: 'create', table: 'schemas', id: 'n', row: { name: 'in' } }, real)).toMatch(/e2e-/);
    expect(refusal({ op: 'delete', table: 'schemas', id: 'made' }, real)).toBeNull();
    expect(refusal({ op: 'delete', table: 'schemas', id: 's1' }, real)).toMatch(/real/);
  });
  it('still refuses tables outside the list', () => {
    expect(refusal({ op: 'update', table: 'users', id: 'x', row: {} }, real)).toMatch(/users/);
  });
});
