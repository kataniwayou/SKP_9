import { describe, expect, it } from 'vitest';
import { hueOf } from './hues';
import { selectPick, type Pick, type SelectionState } from './selection';

const wf = (id: string): Pick => ({ kind: 'workflow', id });
const st = (id: string): Pick => ({ kind: 'step', id });
const ghost = (key: string): Pick => ({ kind: 'ghost', key });
const none: SelectionState = { workflows: [], picks: [] };

describe('selectPick', () => {
  it('a plain triangle click selects it alone', () => {
    expect(selectPick({ workflows: ['x'], picks: [st('s')] }, wf('a'), false)).toEqual({ workflows: ['a'], picks: [wf('a')] });
  });
  it('ctrl+click adds and removes triangles', () => {
    const one = selectPick(none, wf('a'), false);
    const two = selectPick(one, wf('b'), true);
    expect(two).toEqual({ workflows: ['a', 'b'], picks: [wf('a'), wf('b')] });
    expect(selectPick(two, wf('a'), true)).toEqual({ workflows: ['b'], picks: [wf('b')] });
  });
  it('ctrl+click on a triangle decides by workflows, so the lists cannot diverge', () => {
    const removed = selectPick({ workflows: ['a'], picks: [st('s')] }, wf('a'), true);
    expect(removed).toEqual({ workflows: [], picks: [st('s')] });
    expect(selectPick(removed, wf('a'), true)).toEqual({ workflows: ['a'], picks: [st('s'), wf('a')] });
    expect(selectPick({ workflows: ['a'], picks: [st('s'), wf('a')] }, wf('a'), true)).toEqual({ workflows: [], picks: [st('s')] });
  });
  it('a step click keeps the selected workflows', () => {
    expect(selectPick({ workflows: ['a', 'b'], picks: [wf('a'), wf('b')] }, st('s'), false)).toEqual({ workflows: ['a', 'b'], picks: [st('s')] });
    expect(selectPick({ workflows: ['a'], picks: [] }, ghost('g'), false)).toEqual({ workflows: ['a'], picks: [ghost('g')] });
  });
  it('ctrl+click on steps toggles among steps, keeps workflows', () => {
    const prev: SelectionState = { workflows: ['a', 'b'], picks: [st('s')] };
    const added = selectPick(prev, st('t'), true);
    expect(added).toEqual({ workflows: ['a', 'b'], picks: [st('s'), st('t')] });
    expect(selectPick(added, st('s'), true)).toEqual({ workflows: ['a', 'b'], picks: [st('t')] });
  });
  it('ctrl+click mixes ghosts with steps', () => {
    const r = selectPick({ workflows: ['a'], picks: [st('s')] }, ghost('g'), true);
    expect(r).toEqual({ workflows: ['a'], picks: [st('s'), ghost('g')] });
    expect(selectPick(r, ghost('g'), true).picks).toEqual([st('s')]);
  });
  it('an entry arrow or cache line click selects its workflow alone', () => {
    const e: Pick = { kind: 'entry', workflowId: 'h', stepId: 'f' };
    expect(selectPick({ workflows: ['a', 'b'], picks: [] }, e, false)).toEqual({ workflows: ['h'], picks: [e] });
    const l: Pick = { kind: 'cacheLink', workflowId: 'd', cacheId: 'c' };
    expect(selectPick(none, l, false)).toEqual({ workflows: ['d'], picks: [l] });
  });
  it('the empty board clears everything', () => {
    expect(selectPick({ workflows: ['a'], picks: [st('s')] }, null, false)).toEqual(none);
    expect(selectPick({ workflows: ['a'], picks: [st('s')] }, null, true)).toEqual(none);
  });
  it('hues follow selection order', () => {
    expect(hueOf({ workflows: ['b', 'a'] }, 'a')).toBe('#7C3AED');
    expect(hueOf({ workflows: ['b', 'a'] }, 'b')).toBe('#FF0072');
    expect(hueOf({ workflows: ['b', 'a'] }, 'z')).toBeNull();
  });
});
