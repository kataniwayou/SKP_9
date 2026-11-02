import { describe, expect, it } from 'vitest';
import { entityNamesOf, namedText } from './output';
import type { Graph } from '../model/graph';

const P = '463fa2a4-ca2a-459a-b405-badc06d95fba';
const S = '501821d4-c10f-4d57-9240-3ab019c79610';

describe('ids in Output named as the Inspector names them (the user, 2026-11-01)', () => {
  const graph = {
    workflow: { id: 'w', name: 'wf', version: '1.0.0' },
    steps: new Map(), caches: new Map(), schemas: new Map(),
    processors: new Map([[P, { id: P, name: 'file-fetcher', version: '1.0.0' }]]),
  } as unknown as Graph;

  it('gives a known id its unique name, in any case, and leaves an unknown one', () => {
    const names = entityNamesOf([graph], [{ id: S, name: 'locator', version: '2.0.0' }]);
    expect(namedText(`processor ${P.toUpperCase()}: input schema: ${S}; ${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`, names))
      .toBe('processor file-fetcher_1.0.0-b405-badc06d95fba: input schema: locator_2.0.0-9240-3ab019c79610; 00000000-0000-0000-0000-000000000000');
  });
});
