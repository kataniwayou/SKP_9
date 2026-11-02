import { describe, expect, it } from 'vitest';
import { checkPayload } from './payloadCheck';

// as file-fetcher-config is in BaseApi
const FETCHER = JSON.stringify({
  type: 'object', $schema: 'https://json-schema.org/draft/2020-12/schema', required: ['minimumSizeBytes', 'maximumSizeBytes'],
  properties: {
    maximumSizeBytes: { type: 'integer', minimum: 1 }, minimumSizeBytes: { type: 'integer', minimum: 0 },
    allowedExtensions: { type: ['array', 'null'], items: { type: 'string', minLength: 1 } },
  },
  additionalProperties: false,
});

describe('checkPayload (the user, 2026-11-02)', () => {
  it('names each value still a placeholder, once, and not its type error too', () => {
    expect(checkPayload(FETCHER, '{"maximumSizeBytes":"<integer>","minimumSizeBytes":"<integer>","allowedExtensions":[]}')).toEqual({
      problems: ['/maximumSizeBytes: still a placeholder: fill in an integer', '/minimumSizeBytes: still a placeholder: fill in an integer'],
    });
  });

  it('names a placeholder the schema lets through: a "<string>" is a string', () => {
    const schema = JSON.stringify({ required: ['topic'], properties: { topic: { type: 'string', minLength: 1 } } });
    expect(checkPayload(schema, '{"topic":"<string>"}')).toEqual({ problems: ['/topic: still a placeholder: fill in a string'] });
  });

  it('has no problems once filled in', () => {
    expect(checkPayload(FETCHER, '{"maximumSizeBytes":100,"minimumSizeBytes":0,"allowedExtensions":null}')).toEqual({ problems: [] });
  });

  it('names a wrong type, a value under its minimum, a missing required field and a field the schema does not have', () => {
    const r = checkPayload(FETCHER, '{"maximumSizeBytes":"abc","minimumSizeBytes":-1,"extra":true}');
    expect(r).toEqual({ problems: expect.arrayContaining([
      '/maximumSizeBytes: must be integer', '/minimumSizeBytes: must be >= 0', '/: "extra" is not in the schema',
    ]) });
    expect(checkPayload(FETCHER, '{"maximumSizeBytes":1}')).toEqual({ problems: ['/: missing required "minimumSizeBytes"'] });
  });

  it('names an enum\'s values', () => {
    expect(checkPayload('{"properties":{"mode":{"enum":["a","b"]}}}', '{"mode":"c"}')).toEqual({ problems: ['/mode: must be one of "a", "b"'] });
  });

  it('does not assert format, as BaseApi does not', () => {
    expect(checkPayload('{"properties":{"at":{"type":"string","format":"date-time"}}}', '{"at":"not a date"}')).toEqual({ problems: [] });
  });

  it('leaves a payload that is not JSON to the field\'s own note', () => {
    expect(checkPayload(FETCHER, '{')).toEqual({ problems: [] });
  });

  it('says when the schema cannot be checked here: not JSON, or a $ref the browser cannot follow', () => {
    expect(checkPayload('{', '{}')).toHaveProperty('unchecked');
    expect(checkPayload('{"$ref":"https://example.com/x.json"}', '{}')).toHaveProperty('unchecked');
  });
});
