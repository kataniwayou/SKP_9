import { describe, expect, it } from 'vitest';
import { picksOf, samePicks, togglePick } from './picks';

describe('picks', () => {
  it('follows a selection: the hub, a step, a processor (its step) and a cache', () => {
    expect(picksOf(null)).toEqual([]);
    expect(picksOf({ kind: 'workflow' })).toEqual([{ kind: 'node', id: 'wf' }]);
    expect(picksOf({ kind: 'processor', processorId: 'p', stepId: 's1' })).toEqual([{ kind: 'node', id: 's1' }]);
    expect(picksOf({ kind: 'cache', cacheId: 'c' })).toEqual([{ kind: 'node', id: 'cache:c' }]);
  });

  it('Ctrl+click adds and takes out', () => {
    const a = { kind: 'node', id: 'a' } as const, w = { kind: 'wire', id: 'a->b' } as const;
    expect(togglePick([a], w)).toEqual([a, w]);
    expect(togglePick([a, w], a)).toEqual([w]);
    expect(samePicks([a, w], [a, w])).toBe(true);
  });
});
