import { describe, expect, it } from 'vitest';
import { memoryStorage } from '../test/memoryStorage';
import { bw } from '../board/fixtures';
import { keepExistingSelection, readView, writeView } from './view';

describe('view', () => {
  it('round-trips the view and survives broken storage', () => {
    const st = memoryStorage(); writeView(st, { x: 1, y: 2, zoom: 0.8, selection: { kind: 'workflow', workflowId: 'w1' } });
    expect(readView(st)).toEqual({ x: 1, y: 2, zoom: 0.8, selection: { kind: 'workflow', workflowId: 'w1' } });
    const throwing = { getItem: () => { throw new Error('blocked'); } } as unknown as Storage;
    expect(readView(throwing)).toBeNull();
    expect(() => writeView({ setItem: () => { throw new Error('full'); } } as unknown as Storage, { x: 0, y: 0, zoom: 1, selection: null })).not.toThrow();
  });
  it('ignores junk', () => {
    expect(readView(memoryStorage({ 'acto.view': 'not json' }))).toBeNull();
    expect(readView(memoryStorage({ 'acto.view': '{"x":"a"}' }))).toBeNull();
    expect(readView(null)).toBeNull();
  });
  it('drops a saved selection whose target no longer exists', () => {
    const ws = [bw('w1', ['a', 'b'], [{ id: 'a>b', from: 'a', to: 'b', condition: 1 }])];
    expect(keepExistingSelection({ kind: 'step', workflowId: 'w1', stepId: 'a' }, ws)).not.toBeNull();
    expect(keepExistingSelection({ kind: 'step', workflowId: 'w1', stepId: 'zz' }, ws)).toBeNull();
    expect(keepExistingSelection({ kind: 'wire', workflowId: 'w1', wireId: 'a>b' }, ws)).not.toBeNull();
    expect(keepExistingSelection({ kind: 'wire', workflowId: 'w9', wireId: 'a>b' }, ws)).toBeNull();
    expect(keepExistingSelection({ kind: 'workflow', workflowId: 'w9' }, ws)).toBeNull();
    expect(keepExistingSelection(null, ws)).toBeNull();
  });
});
