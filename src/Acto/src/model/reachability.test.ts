import { describe, expect, it } from 'vitest';
import { reachableStepIds } from './reachability';

const steps = (edges: Record<string, string[]>) =>
  new Map(Object.entries(edges).map(([id, next]) => [id, { nextStepIds: next }]));

describe('reachableStepIds (WorkflowGraphLoader BFS)', () => {
  it('walks breadth first from the entry steps', () => {
    expect(reachableStepIds(['a'], steps({ a: ['b', 'c'], b: ['d'], c: [], d: [] }))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('visits a step reached twice once (diamond, fan-in)', () => {
    expect(reachableStepIds(['a'], steps({ a: ['b', 'c'], b: ['d'], c: ['d'], d: [] }))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('terminates on a cycle and includes the steps on it', () => {
    expect(reachableStepIds(['a'], steps({ a: ['b'], b: ['a'] }))).toEqual(['a', 'b']);
  });

  it('skips ids that name no step, and leaves out steps nothing reaches', () => {
    expect(reachableStepIds(['a', 'ghost'], steps({ a: ['missing'], parked: [] }))).toEqual(['a']);
  });

  it('dedupes repeated entry ids', () => {
    expect(reachableStepIds(['a', 'a'], steps({ a: [] }))).toEqual(['a']);
  });
});
