import { describe, expect, it } from 'vitest';
import { barOf } from './selectionBar';
import type { Pick } from './picks';

const st = (id: string): Pick => ({ kind: 'step', id });
const ca = (id: string): Pick => ({ kind: 'cache', id });

describe('barOf', () => {
  it('is null for fewer than two picks', () => {
    expect(barOf([])).toBeNull();
    expect(barOf([st('a')])).toBeNull();
  });
  it('steps alone: Copy and Delete', () => {
    expect(barOf([st('a'), st('b')])).toEqual({ count: 2, copy: true, del: true });
  });
  it('a step and a cache: only Delete is common', () => {
    expect(barOf([st('a'), ca('c')])).toEqual({ count: 2, copy: false, del: true });
  });
  it('wires, entry arrows and cache lines: Delete', () => {
    const picks: Pick[] = [{ kind: 'wire', from: 'a', to: 'b' }, { kind: 'entry', workflowId: 'w', stepId: 'a' }, { kind: 'cacheLink', workflowId: 'w', cacheId: 'c' }];
    expect(barOf(picks)).toEqual({ count: 3, copy: false, del: true });
  });
  it('a triangle never shares an action', () => {
    expect(barOf([{ kind: 'workflow', id: 'w' }, st('a')])).toEqual({ count: 2, copy: false, del: false });
  });
});
