import { describe, expect, it } from 'vitest';
import { liveStatusOf } from './liveStatus';

const W = '1A56B3CA-E276-4815-87FA-5C2F48AB6DAD';
const ok = (value: unknown) => ({ ok: true as const, value });

describe('liveStatusOf (review focus 3: a failing or odd live poll)', () => {
  it('is running when the live set holds the id, whatever its case', () => {
    expect(liveStatusOf(ok(['1a56b3ca-e276-4815-87fa-5c2f48ab6dad']), W)).toBe('running');
    expect(liveStatusOf(ok([W]), W.toLowerCase())).toBe('running');
  });

  it('is stopped when the set does not hold it', () => {
    expect(liveStatusOf(ok([]), W)).toBe('stopped');
    expect(liveStatusOf(ok(['4cd8af45-1295-43db-ab2e-e955dd82b5c5']), W)).toBe('stopped');
  });

  it('skips entries that are not strings or not GUIDs, and still finds the id', () => {
    expect(liveStatusOf(ok([null, 7, { id: W }, 'not-a-guid', W]), W)).toBe('running');
    expect(liveStatusOf(ok([null, 7, 'not-a-guid']), W)).toBe('stopped');
  });

  it('is unknown when the poll fails or the body is not a list, never stopped', () => {
    expect(liveStatusOf({ ok: false, error: { kind: 'http', status: 500, detail: 'Redis down' } }, W)).toBe('unknown');
    expect(liveStatusOf({ ok: false, error: { kind: 'network', message: 'Failed to fetch' } }, W)).toBe('unknown');
    expect(liveStatusOf(ok({ live: [W] }), W)).toBe('unknown');
    expect(liveStatusOf(ok(null), W)).toBe('unknown');
    expect(liveStatusOf(ok('1a56b3ca-e276-4815-87fa-5c2f48ab6dad'), W)).toBe('unknown');
  });
});
