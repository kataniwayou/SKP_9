import { describe, expect, it } from 'vitest';
import { stepDto } from '../api/fixtures';
import { FIELDS, fieldValue, jsonProblem, savedText, shownText } from './entityForms';

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
