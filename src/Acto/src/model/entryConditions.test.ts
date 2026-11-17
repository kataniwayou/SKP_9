import { describe, expect, it } from 'vitest';
import { CONDITIONS, conditionInfo } from './entryConditions';

describe('entry conditions', () => {
  it.each([
    [1, 'Completed', 'C', '#2DD4BF'],
    [2, 'Failed', 'F', '#FF7A66'],
    [3, 'Cancelled', 'X', '#F5B841'],
    [4, 'Always', 'A', '#B392F0'],
    [5, 'Never', 'N', '#F472B6'],
  ])('%i is %s, letter %s, colour %s', (value, name, letter, colour) => {
    expect(conditionInfo(value)).toEqual({ name, letter, colour });
  });

  it('shows 0 (rejected by the validators) and unknown values as invalid rather than throwing', () => {
    expect(conditionInfo(0).name).toBe('Invalid');
    expect(conditionInfo(99).letter).toBe('?');
  });

  it('lists the five valid conditions in wire order for the legend', () => {
    expect(CONDITIONS.map((c) => c.value)).toEqual([1, 2, 3, 4, 5]);
  });
});
