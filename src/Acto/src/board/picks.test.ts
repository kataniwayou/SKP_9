import { describe, expect, it } from 'vitest';
import { board } from '../design/boardFixtures';
import { lastPick, livePicks, pickKey, togglePick } from './picks';
import { selectPick, type Pick } from './selection';

const a: Pick = { kind: 'step', id: 'fetch' };
const b: Pick = { kind: 'step', id: 'expand' };
const daily: Pick = { kind: 'workflow', id: 'daily' };
const hourly: Pick = { kind: 'workflow', id: 'hourly' };
const none = { workflow: null, picks: [] as Pick[] };

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
});

describe('selectPick', () => {
  it('a triangle click sets the workflow and picks only it; Ctrl is ignored', () => {
    expect(selectPick(none, daily, false)).toEqual({ workflow: 'daily', picks: [daily] });
    const prev = { workflow: 'daily', picks: [a, b] };
    expect(selectPick(prev, hourly, true)).toEqual({ workflow: 'hourly', picks: [hourly] });
  });
  it('a step, cache or wire click keeps the workflow and replaces the picks', () => {
    const prev = { workflow: 'daily', picks: [daily] };
    expect(selectPick(prev, a, false)).toEqual({ workflow: 'daily', picks: [a] });
    expect(selectPick({ workflow: 'daily', picks: [a, b] }, { kind: 'cache', id: 'c1' }, false)).toEqual({ workflow: 'daily', picks: [{ kind: 'cache', id: 'c1' }] });
    expect(selectPick(none, a, false)).toEqual({ workflow: null, picks: [a] });
  });
  it('Ctrl toggles a step, cache or wire into the picks and never keeps a triangle among them', () => {
    expect(selectPick({ workflow: 'daily', picks: [a] }, b, true)).toEqual({ workflow: 'daily', picks: [a, b] });
    expect(selectPick({ workflow: 'daily', picks: [a, b] }, a, true)).toEqual({ workflow: 'daily', picks: [b] });
    expect(selectPick({ workflow: 'daily', picks: [daily] }, a, true)).toEqual({ workflow: 'daily', picks: [a] });
  });
  it('an entry or cache-link click sets the workflow to its own', () => {
    const e: Pick = { kind: 'entry', workflowId: 'hourly', stepId: 'fetch' };
    expect(selectPick({ workflow: 'daily', picks: [daily] }, e, false)).toEqual({ workflow: 'hourly', picks: [e] });
    const l: Pick = { kind: 'cacheLink', workflowId: 'daily', cacheId: 'c1' };
    expect(selectPick(none, l, false)).toEqual({ workflow: 'daily', picks: [l] });
  });
  it('the empty board clears both', () => {
    expect(selectPick({ workflow: 'daily', picks: [a] }, null, false)).toEqual(none);
    expect(selectPick({ workflow: 'daily', picks: [a] }, null, true)).toEqual(none);
  });
});
