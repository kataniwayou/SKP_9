import { describe, expect, it } from 'vitest';
import { barOf, type Bar } from './selectionBar';
import type { Pick } from './picks';
import type { BoardState } from '../design/board';

const sc = (id: string): Pick => ({ kind: 'schema', id });
const pr = (id: string): Pick => ({ kind: 'processor', id });
/** o1, o2 orphans; w wired (processor pw used by step s1); h held (processor ph, no step). */
const sb = {
  workflows: {}, caches: {}, assignments: {},
  steps: { s1: { id: 's1', processorId: 'pw' } },
  processors: { pw: { id: 'pw', inputSchemaId: 'w', outputSchemaId: null, configSchemaId: null }, ph: { id: 'ph', inputSchemaId: 'h', outputSchemaId: null, configSchemaId: null } },
  schemas: { o1: { id: 'o1' }, o2: { id: 'o2' }, w: { id: 'w' }, h: { id: 'h' } },
} as unknown as BoardState;

const st = (id: string): Pick => ({ kind: 'step', id });
const ca = (id: string): Pick => ({ kind: 'cache', id });
const gh = (key: string): Pick => ({ kind: 'ghost', key });
const wf = (id: string): Pick => ({ kind: 'workflow', id });
const bar = (count: number, over: Partial<Bar> = {}): Bar => ({ count, copy: false, del: false, restore: false, remove: false, run: false, ...over });

describe('barOf', () => {
  it('is null for fewer than two picks', () => {
    expect(barOf([], sb)).toBeNull();
    expect(barOf([st('a')], sb)).toBeNull();
  });
  it('steps alone: Copy and Delete', () => {
    expect(barOf([st('a'), st('b')], sb)).toEqual(bar(2, { copy: true, del: true }));
  });
  it('a step and a cache: Copy and Delete [user, 2026-11-19]', () => {
    expect(barOf([st('a'), ca('c')], sb)).toEqual(bar(2, { copy: true, del: true }));
  });
  it('wires, entry arrows and cache lines: Delete', () => {
    const picks: Pick[] = [{ kind: 'wire', from: 'a', to: 'b' }, { kind: 'entry', workflowId: 'w', stepId: 'a' }, { kind: 'cacheLink', workflowId: 'w', cacheId: 'c' }];
    expect(barOf(picks, sb)).toEqual(bar(3, { del: true }));
  });
  it('ghosts alone: Restore and Remove, no Delete', () => {
    expect(barOf([gh('step:a'), gh('wire:a:b')], sb)).toEqual(bar(2, { restore: true, remove: true }));
  });
  it('a ghost and a step: nothing common', () => {
    expect(barOf([gh('step:a'), st('b')], sb)).toEqual(bar(2));
  });
  it('triangles alone: Start · Stop, Copy and Delete', () => {
    expect(barOf([wf('a'), wf('b')], sb)).toEqual(bar(2, { run: true, copy: true, del: true }));
  });
  it('a triangle with steps and caches: Copy and Delete (every delete is a ghost) [user, 2026-11-23]', () => {
    expect(barOf([wf('w'), st('a'), ca('c')], sb)).toEqual(bar(3, { copy: true, del: true }));
  });
  it('a triangle and a wire: Delete; a triangle and a ghost: nothing common', () => {
    expect(barOf([wf('w'), { kind: 'wire', from: 'a', to: 'b' }], sb)).toEqual(bar(2, { del: true }));
    expect(barOf([wf('w'), gh('step:a')], sb)).toEqual(bar(2));
  });
  it('two orphans give Delete 2; an orphan and a wired schema give no action; a schema and a step give no action', () => {
    expect(barOf([sc('o1'), sc('o2')], sb)).toEqual(bar(2, { del: true }));
    expect(barOf([sc('o1'), sc('w')], sb)).toEqual(bar(2));
    expect(barOf([sc('o1'), sc('h')], sb)).toEqual(bar(2));
    expect(barOf([sc('o1'), st('s1')], sb)).toEqual(bar(2));
    expect(barOf([sc('o1'), pr('pw')], sb)).toEqual(bar(2));
    expect(barOf([sc('o1'), gh('schema:x')], sb)).toEqual(bar(2));
  });
});
