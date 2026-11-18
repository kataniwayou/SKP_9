import { describe, expect, it } from 'vitest';
import { memoryStorage } from '../test/memoryStorage';
import { readView, writeView } from './view';

describe('view', () => {
  it('round-trips the view and the selection, and survives broken storage', () => {
    const st = memoryStorage();
    const selection = { workflow: 'w1', picks: [{ kind: 'step' as const, id: 's1' }, { kind: 'wire' as const, from: 'a', to: 'b' }] };
    writeView(st, { x: 1, y: 2, zoom: 0.8, selection });
    expect(readView(st)).toEqual({ x: 1, y: 2, zoom: 0.8, selection });
    const throwing = { getItem: () => { throw new Error('blocked'); } } as unknown as Storage;
    expect(readView(throwing)).toBeNull();
    expect(() => writeView({ setItem: () => { throw new Error('full'); } } as unknown as Storage, { x: 0, y: 0, zoom: 1, selection: null })).not.toThrow();
  });
  it('ignores junk', () => {
    expect(readView(memoryStorage({ 'acto.view': 'not json' }))).toBeNull();
    expect(readView(memoryStorage({ 'acto.view': '{"x":"a"}' }))).toBeNull();
    expect(readView(null)).toBeNull();
  });
  it('drops picks it cannot read (an old frame-era selection reads as none)', () => {
    const old = JSON.stringify({ x: 0, y: 0, zoom: 1, selection: { kind: 'step', workflowId: 'w1', stepId: 'a' } });
    expect(readView(memoryStorage({ 'acto.view': old }))!.selection).toBeNull();
    const mixed = JSON.stringify({ x: 0, y: 0, zoom: 1, selection: { workflow: null, picks: [{ kind: 'cache', id: 'c' }, { kind: 'nope' }] } });
    expect(readView(memoryStorage({ 'acto.view': mixed }))!.selection).toEqual({ workflow: null, picks: [{ kind: 'cache', id: 'c' }] });
  });
});
