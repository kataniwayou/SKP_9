import { describe, expect, it } from 'vitest';
import { derivedEntrySteps, entryDiff, stepRoles } from './roles';

const L = (pairs: string[]) => pairs.map((p) => ({ from: p[0]!, to: p[1]! }));

describe('roles', () => {
  it('marks first, parked and reached', () => {
    expect(Object.fromEntries(stepRoles(['a', 'b', 'c', 'p'], L(['ab', 'bc'])))).toEqual({ a: 'first', b: 'reached', c: 'reached', p: 'parked' });
  });
  it('runs a lone step as first', () => expect(stepRoles(['a'], [])).toEqual(new Map([['a', 'first']])));
  it('terminates on a cycle and gives no first step', () => {
    expect([...stepRoles(['a', 'b'], L(['ab', 'ba'])).values()]).toEqual(['reached', 'reached']);
  });
  it('lists derived entry steps in order', () => {
    expect(derivedEntrySteps(stepRoles(['z', 'a', 'b'], L(['zb', 'ab'])))).toEqual(['z', 'a']);
  });
  it('reports entry differences', () => expect(entryDiff(['a', 'x'], ['a', 'b'])).toEqual({ stops: ['x'], starts: ['b'] }));
});
