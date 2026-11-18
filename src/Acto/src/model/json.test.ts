import { describe, expect, it } from 'vitest';
import { prettyJson, sameJson } from './json';

describe('prettyJson', () => {
  it('lays JSON out two-space, one field to a line', () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyJson('{"a":{"b":[1,2]}}')).toBe('{\n  "a": {\n    "b": [\n      1,\n      2\n    ]\n  }\n}');
  });
  it('shows text that does not parse as it is', () => {
    expect(prettyJson('not json')).toBe('not json');
    expect(prettyJson('')).toBe('');
  });
});

describe('sameJson', () => {
  it('is the same JSON however laid out', () => {
    expect(sameJson('{"a":1}', '{ "a" : 1 }')).toBe(true);
    expect(sameJson('{"a":1}', '{\n  "a": 1\n}')).toBe(true);
  });
  it('differs on a different value or key order', () => {
    expect(sameJson('{"a":1}', '{"a":2}')).toBe(false);
    expect(sameJson('{"a":1,"b":2}', '{"b":2,"a":1}')).toBe(false);
  });
  it('text that does not parse is the same only to itself', () => {
    expect(sameJson('nope', 'nope')).toBe(true);
    expect(sameJson('nope', 'nope ')).toBe(false);
  });
});
