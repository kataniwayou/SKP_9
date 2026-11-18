import { describe, expect, it } from 'vitest';
import { board } from '../design/boardFixtures';
import { deletePicks, lastPick, livePicks, pickKey, togglePick } from './picks';
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
