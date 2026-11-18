import { describe, expect, it } from 'vitest';
import { barOf, type Bar } from './selectionBar';
import type { Pick } from './picks';

const st = (id: string): Pick => ({ kind: 'step', id });
const ca = (id: string): Pick => ({ kind: 'cache', id });
const gh = (key: string): Pick => ({ kind: 'ghost', key });
const wf = (id: string): Pick => ({ kind: 'workflow', id });
const bar = (count: number, over: Partial<Bar> = {}): Bar => ({ count, copy: false, del: false, restore: false, remove: false, run: false, ...over });

describe('barOf', () => {
  it('is null for fewer than two picks', () => {
    expect(barOf([])).toBeNull();
    expect(barOf([st('a')])).toBeNull();
  });
  it('steps alone: Copy and Delete', () => {
    expect(barOf([st('a'), st('b')])).toEqual(bar(2, { copy: true, del: true }));
  });
  it('a step and a cache: only Delete is common', () => {
    expect(barOf([st('a'), ca('c')])).toEqual(bar(2, { del: true }));
  });
  it('wires, entry arrows and cache lines: Delete', () => {
    const picks: Pick[] = [{ kind: 'wire', from: 'a', to: 'b' }, { kind: 'entry', workflowId: 'w', stepId: 'a' }, { kind: 'cacheLink', workflowId: 'w', cacheId: 'c' }];
    expect(barOf(picks)).toEqual(bar(3, { del: true }));
  });
  it('ghosts alone: Restore and Remove, no Delete', () => {
    expect(barOf([gh('step:a'), gh('wire:a:b')])).toEqual(bar(2, { restore: true, remove: true }));
  });
  it('a ghost and a step: nothing common', () => {
    expect(barOf([gh('step:a'), st('b')])).toEqual(bar(2));
  });
  it('triangles alone: Start · Stop and Delete, no Copy', () => {
    expect(barOf([wf('a'), wf('b')])).toEqual(bar(2, { run: true, del: true }));
  });
  it('a triangle and a step: nothing common', () => {
    expect(barOf([wf('w'), st('a')])).toEqual(bar(2));
  });
});
