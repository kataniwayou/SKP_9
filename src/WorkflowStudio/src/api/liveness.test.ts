import { describe, expect, it } from 'vitest';
import type { ApiResult } from './client';
import { healthOf } from './liveness';

const ok = (value: unknown): ApiResult<unknown> => ({ ok: true, value });

describe('healthOf', () => {
  it('reads live as healthy and not live as unhealthy', () => {
    const health = healthOf(ok([{ processorId: 'p1', live: true }, { processorId: 'p2', live: false }]));
    expect([health('p1'), health('p2')]).toEqual(['healthy', 'unhealthy']);
  });

  it('matches ids without case (review focus 2)', () => {
    const health = healthOf(ok([{ processorId: 'F361E170-C899-43D1-9A0E-4D30FF2CAD87', live: true }]));
    expect(health('f361e170-c899-43d1-9a0e-4d30ff2cad87')).toBe('healthy');
  });

  // Review focus 1: no answer is never a verdict.
  it.each([
    ['no poll yet', null],
    ['a failed poll', { ok: false, error: { kind: 'http', status: 500, detail: 'Redis down' } }],
    ['a body that is not an array', ok({ p1: true })],
  ] as const)('is undetermined for every processor after %s', (_label, result) => {
    expect(healthOf(result as ApiResult<unknown> | null)('p1')).toBe('undetermined');
  });

  it('skips malformed entries and leaves unnamed processors undetermined', () => {
    const health = healthOf(ok([null, 'p1', { processorId: 7, live: true }, { processorId: 'p1', live: 'yes' }, { processorId: 'p2', live: true }]));
    expect([health('p1'), health('p2'), health('p3'), health('')]).toEqual(['undetermined', 'healthy', 'undetermined', 'undetermined']);
  });
});
