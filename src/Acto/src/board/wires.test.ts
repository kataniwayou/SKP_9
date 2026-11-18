import { describe, expect, it } from 'vitest';
import { conditionStyle } from './wires';

describe('conditionStyle', () => {
  it('colours a wire by the entry condition of its target', () => {
    expect(conditionStyle(2)).toEqual({ letter: 'F', colour: '#E0482F', name: 'Failed' });
    expect(conditionStyle(0)).toEqual({ letter: '?', colour: '#64748B', name: 'Invalid' });
  });
});
