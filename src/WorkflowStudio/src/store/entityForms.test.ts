import { describe, expect, it } from 'vitest';
import { stepDto } from '../api/fixtures';
import { FIELDS, fieldValue, jsonProblem, prettyJson, sameJson, savedText, shownText } from './entityForms';

describe('form helpers', () => {
  it('reads saved values as text', () => {
    expect(savedText(stepDto('s1', { description: null }), 'description')).toBe('');
    expect(savedText(stepDto('s1', { entryCondition: 3 }), 'entryCondition')).toBe('3');
    expect(shownText(stepDto('s1'), { name: 'typed' }, 'name')).toBe('typed');
    expect(shownText(stepDto('s1'), {}, 'name')).toBe('step-s1');
  });

  it('marks text that is not JSON', () => {
    expect(jsonProblem('{"a":1}')).toBeNull();
    expect(jsonProblem('[]')).toBeNull();
    expect(jsonProblem('{')).toBe('Not valid JSON');
    expect(jsonProblem('')).toBe('Not valid JSON');
  });

  it('turns typed text into the value the design keeps (plan 8): a number for the entry condition, null for a blank nullable field', () => {
    const spec = (key: string) => FIELDS.step.concat(FIELDS.processor).find((f) => f.key === key)!;
    expect(fieldValue(spec('entryCondition'), '4')).toBe(4);
    expect(fieldValue(spec('description'), '  ')).toBeNull();
    expect(fieldValue(spec('instanceId'), '')).toBeNull();
    expect(fieldValue(spec('name'), '')).toBe('');
    expect(fieldValue(spec('description'), 'typed')).toBe('typed');
  });
});

describe('JSON laid out (the user, 2026-11-01)', () => {
  it('puts one field to a line; text that does not parse stays as it is', () => {
    expect(prettyJson('{"a":1,"b":[2]}')).toBe(['{', '  "a": 1,', '  "b": [', '    2', '  ]', '}'].join('\n'));
    expect(prettyJson('{oops')).toBe('{oops');
  });

  it('tells the same JSON however laid out', () => {
    expect(sameJson('{"a":1}', '{\n  "a": 1\n}')).toBe(true);
    expect(sameJson('{"a":1}', '{"a":2}')).toBe(false);
    expect(sameJson('{oops', '{oops')).toBe(true);
    expect(sameJson('{oops', '{ oops')).toBe(false);
  });
});
