import { describe, expect, it } from 'vitest';
import { board } from '../design/boardFixtures';
import { deletePicks, deleteRefusal, lastPick, livePicks, pickKey, togglePick } from './picks';
import { shared } from '../design/boardFixtures';
import type { LiveStatus } from '../api/liveStatus';
import type { Pick } from './selection';

const a: Pick = { kind: 'step', id: 'fetch' };
const b: Pick = { kind: 'step', id: 'expand' };
const daily: Pick = { kind: 'workflow', id: 'daily' };

describe('picks', () => {
  it('toggles: appends a new pick, removes a present one', () => {
    expect(togglePick([], a)).toEqual([a]);
    expect(togglePick([a, b], a)).toEqual([b]);
    expect(togglePick([a], b)).toEqual([a, b]);
  });
  it('keys every kind', () => {
    expect(pickKey(a)).toBe('st:fetch');
    expect(pickKey(daily)).toBe('wf:daily');
    expect(pickKey({ kind: 'wire', from: 'a', to: 'b' })).toBe('wi:a>b');
    expect(pickKey({ kind: 'cache', id: 'c1' })).toBe('ca:c1');
    expect(pickKey({ kind: 'entry', workflowId: 'daily', stepId: 'fetch' })).toBe('en:daily:fetch');
    expect(pickKey({ kind: 'cacheLink', workflowId: 'daily', cacheId: 'c1' })).toBe('cl:daily:c1');
  });
  it('lastPick is the newest, or null', () => {
    expect(lastPick([a, b])).toBe(b);
    expect(lastPick([])).toBeNull();
  });
  it('livePicks drops picks whose thing is gone, keeping order', () => {
    const picks: Pick[] = [
      { kind: 'workflow', id: 'gone' }, b, { kind: 'wire', from: 'fetch', to: 'lonely' }, { kind: 'wire', from: 'fetch', to: 'expand' },
      { kind: 'cache', id: 'zz' }, { kind: 'entry', workflowId: 'daily', stepId: 'expand' }, { kind: 'entry', workflowId: 'daily', stepId: 'fetch' },
      { kind: 'cacheLink', workflowId: 'hourly', cacheId: 'c1' }, { kind: 'cacheLink', workflowId: 'daily', cacheId: 'c1' }, daily,
    ];
    expect(livePicks(picks, board())).toEqual([
      b, { kind: 'wire', from: 'fetch', to: 'expand' }, { kind: 'entry', workflowId: 'daily', stepId: 'fetch' },
      { kind: 'cacheLink', workflowId: 'daily', cacheId: 'c1' }, daily,
    ]);
  });
  it('pickKey, livePicks and deletePicks handle ghosts', () => {
    const g: Pick = { kind: 'ghost', key: 'k' };
    expect(pickKey(g)).toBe('gh:k');
    expect(livePicks([g], board())).toEqual([g]);
    const b0 = board();
    expect(deletePicks(b0, [g])).toBe(b0);
  });
});

describe('deletePicks', () => {
  it('deletes a step, a cache, a wire, an entry arrow and a cache line in one state', () => {
    const s = deletePicks(board(), [
      { kind: 'step', id: 'lonely' }, { kind: 'cache', id: 'c1' }, { kind: 'wire', from: 'fetch', to: 'expand' },
      { kind: 'entry', workflowId: 'hourly', stepId: 'fetch' },
    ]);
    expect(s.steps.lonely).toBeUndefined();
    expect(s.caches.c1).toBeUndefined();
    expect(s.workflows.daily!.cacheIds).toEqual([]);
    expect(s.steps.fetch!.nextStepIds).toEqual([]);
    expect(s.workflows.hourly!.entryStepIds).toEqual([]);
    expect(s.workflows.daily!.entryStepIds).toEqual(['fetch']);
  });
  it('a cache line alone unlinks only that workflow; a step takes its payloads with it', () => {
    expect(deletePicks(board(), [{ kind: 'cacheLink', workflowId: 'daily', cacheId: 'c1' }]).caches.c1).toBeDefined();
    const s = deletePicks(board(), [{ kind: 'step', id: 'fetch' }]);
    expect(Object.keys(s.assignments)).toEqual([]);
    expect(s.workflows.daily!.entryStepIds).toEqual([]);
  });
  it('removes a picked workflow and the assignments only it links; a shared assignment stays [user, 2026-11-23]', () => {
    const own = deletePicks(board(), [{ kind: 'workflow', id: 'daily' }]);
    expect(own.workflows.daily).toBeUndefined();
    expect(own.assignments['a-daily-fetch']).toBeUndefined();
    expect(own.assignments['a-hourly-fetch']).toBeDefined();
    expect(own.steps.fetch).toBeDefined();
    const both = deletePicks(shared(), [{ kind: 'workflow', id: 'daily' }]);
    expect(both.assignments['a-shared']).toBeDefined();
  });
  it('deletes a workflow and a step together as one state', () => {
    const s = deletePicks(board(), [{ kind: 'workflow', id: 'daily' }, { kind: 'step', id: 'lonely' }]);
    expect(s.workflows.daily).toBeUndefined();
    expect(s.steps.lonely).toBeUndefined();
  });
});

describe('deleteRefusal', () => {
  const b = board();
  const status = (m: Record<string, LiveStatus>) => (wf: string): LiveStatus => m[wf] ?? 'stopped';
  it('names each running, checking or unknown picked workflow [user, 2026-11-23]', () => {
    const picks: Pick[] = [{ kind: 'workflow', id: 'daily' }, { kind: 'workflow', id: 'hourly' }, { kind: 'step', id: 'lonely' }];
    expect(deleteRefusal(picks, b, b, status({ daily: 'running', hourly: 'unknown' }))).toEqual([
      'daily is running — stop it first',
      "can't tell whether hourly is running — try again",
    ]);
    expect(deleteRefusal([{ kind: 'workflow', id: 'daily' }], b, b, status({ daily: 'checking' }))).toEqual(["can't tell whether daily is running — try again"]);
  });
  it('stopped workflows, never-saved workflows and other kinds pass', () => {
    expect(deleteRefusal([{ kind: 'workflow', id: 'daily' }, a], b, b, status({}))).toEqual([]);
    const base = { ...b, workflows: { hourly: b.workflows.hourly } };
    expect(deleteRefusal([{ kind: 'workflow', id: 'daily' }], b, base, status({ daily: 'unknown' }))).toEqual([]);
  });
});
