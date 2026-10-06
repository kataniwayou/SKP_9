import { describe, expect, it } from 'vitest';
import { assignmentByStep, payloadKeyCount } from './assignments';

describe('assignmentByStep', () => {
  it('keeps one assignment per step: the smallest id, as the graph saver does', () => {
    const map = assignmentByStep([
      { id: 'bbbb', stepId: 's1', payload: '{}' },
      { id: 'aaaa', stepId: 's1', payload: '{"k":1}' },
      { id: 'cccc', stepId: 's2', payload: '{}' },
    ]);
    expect(map.get('s1')!.id).toBe('aaaa');
    expect(map.get('s2')!.id).toBe('cccc');
  });

  it('compares ids case-insensitively, as Postgres compares uuids', () => {
    const map = assignmentByStep([
      { id: 'B000', stepId: 's1', payload: '{}' },
      { id: 'a000', stepId: 's1', payload: '{}' },
    ]);
    expect(map.get('s1')!.id).toBe('a000');
  });
});

describe('payloadKeyCount', () => {
  it('counts the top-level keys of an object payload', () => {
    expect(payloadKeyCount('{"a":1,"b":{"c":2}}')).toBe(2);
    expect(payloadKeyCount('{}')).toBe(0);
  });

  it('returns null for invalid JSON or a payload that is not an object', () => {
    expect(payloadKeyCount('{nope')).toBeNull();
    expect(payloadKeyCount('[1,2]')).toBeNull();
    expect(payloadKeyCount('')).toBeNull();
  });
});
