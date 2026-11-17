import { describe, expect, it } from 'vitest';
import { bw } from './fixtures';
import { lastPick, livePicks, pickKey, togglePick, type Pick } from './picks';

const a: Pick = { kind: 'step', workflowId: 'w1', stepId: 'a' };
const b: Pick = { kind: 'step', workflowId: 'w1', stepId: 'b' };

describe('picks', () => {
  it('toggles: appends a new pick, removes a present one', () => {
    expect(togglePick([], a)).toEqual([a]);
    expect(togglePick([a, b], a)).toEqual([b]);
    expect(togglePick([a], b)).toEqual([a, b]);
  });
  it('keys every kind', () => {
    expect(pickKey(a)).toBe('st:w1:a');
    expect(pickKey({ kind: 'workflow', workflowId: 'w1' })).toBe('wf:w1');
    expect(pickKey({ kind: 'wire', workflowId: 'w1', wireId: 'a>b' })).toBe('wi:w1:a>b');
    expect(pickKey({ kind: 'cache', workflowId: 'w1', cacheId: 'c' })).toBe('ca:w1:c');
  });
  it('lastPick is the newest, or null', () => {
    expect(lastPick([a, b])).toBe(b);
    expect(lastPick([])).toBeNull();
  });
  it('livePicks drops picks whose thing is gone, keeping order', () => {
    const w = bw('w1', ['a']);
    const gone: Pick[] = [{ kind: 'workflow', workflowId: 'w9' }, b, { kind: 'wire', workflowId: 'w1', wireId: 'x' }, { kind: 'cache', workflowId: 'w1', cacheId: 'c' }];
    expect(livePicks([...gone, a, { kind: 'workflow', workflowId: 'w1' }], [w])).toEqual([a, { kind: 'workflow', workflowId: 'w1' }]);
  });
});
