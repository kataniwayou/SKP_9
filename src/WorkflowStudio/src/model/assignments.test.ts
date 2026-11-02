import { describe, expect, it } from 'vitest';
import { assignmentByStep, payloadKeyCount, payloadSkeleton } from './assignments';

describe('assignmentByStep', () => {
  it('keeps one assignment per step: the smallest id, as the graph saver does', () => {
    const map = assignmentByStep([
      { id: 'bbbb', stepId: 's1', payload: '{}', updatedAt: '' },
      { id: 'aaaa', stepId: 's1', payload: '{"k":1}', updatedAt: '' },
      { id: 'cccc', stepId: 's2', payload: '{}', updatedAt: '' },
    ]);
    expect(map.get('s1')!.id).toBe('aaaa');
    expect(map.get('s2')!.id).toBe('cccc');
  });

  it('compares ids case-insensitively, as Postgres compares uuids', () => {
    const map = assignmentByStep([
      { id: 'B000', stepId: 's1', payload: '{}', updatedAt: '' },
      { id: 'a000', stepId: 's1', payload: '{}', updatedAt: '' },
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

describe('payloadSkeleton (the user, 2026-11-02)', () => {
  it('lays out every top-level property, one to a line: a required one as a marker, an optional one empty or its default', () => {
    const schema = JSON.stringify({
      type: 'object', required: ['bucket', 'retries', 'tags'],
      properties: {
        bucket: { type: 'string' }, retries: { type: 'integer' }, tags: { type: 'array' },
        prefix: { type: ['string', 'null'] }, overwrite: { type: 'boolean' }, limit: { type: 'number', default: 10 },
        options: { type: 'object', properties: { deep: { type: 'string' } } }, anything: {},
      },
    });
    expect(payloadSkeleton(schema)).toBe(JSON.stringify({
      bucket: '<string>', retries: '<integer>', tags: '<array>', prefix: '', overwrite: false, limit: 10, options: {}, anything: null,
    }, null, 2));
  });

  it('marks a required property with no type as <value>', () => {
    expect(JSON.parse(payloadSkeleton('{"required":["x"],"properties":{"x":{}}}'))).toEqual({ x: '<value>' });
  });

  it('is {} with no schema, one that does not parse, or one with no properties', () => {
    for (const d of [null, undefined, '', 'not json', '{}', '[]', '{"properties":[]}', '{"properties":{}}']) expect(payloadSkeleton(d)).toBe('{}');
  });
});
