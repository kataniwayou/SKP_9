import { describe, expect, it } from 'vitest';
import type { LiveStatus } from '../api/liveStatus';
import { barOf } from './selectionBar';
import type { Pick } from './picks';

const wfp = (id: string): Pick => ({ kind: 'workflow', workflowId: id });
const st = (w: string, s: string): Pick => ({ kind: 'step', workflowId: w, stepId: s });
const status = (m: Record<string, { run: LiveStatus; unsaved: boolean }>) => (id: string) => m[id] ?? { run: 'stopped' as LiveStatus, unsaved: false };

describe('barOf', () => {
  it('is null for fewer than two picks', () => {
    expect(barOf([], status({}))).toBeNull();
    expect(barOf([st('w1', 'a')], status({}))).toBeNull();
  });
  it('steps, wires and caches from several workflows are parts', () => {
    const picks: Pick[] = [st('w1', 'a'), { kind: 'wire', workflowId: 'w2', wireId: 'x>y' }, { kind: 'cache', workflowId: 'w2', cacheId: 'c' }];
    expect(barOf(picks, status({}))).toEqual({ kind: 'parts', count: 3 });
  });
  it('workflows split into start, stop and save lists', () => {
    const s = status({ w1: { run: 'running', unsaved: false }, w2: { run: 'stopped', unsaved: false }, w3: { run: 'stopped', unsaved: true } });
    expect(barOf([wfp('w1'), wfp('w2'), wfp('w3')], s)).toEqual({ kind: 'workflows', count: 3, start: ['w2', 'w3'], stop: ['w1'], save: ['w3'] });
  });
  it('a workflow with a step is mixed', () => {
    expect(barOf([wfp('w1'), st('w1', 'a')], status({}))).toEqual({ kind: 'mixed', count: 2 });
  });
});
