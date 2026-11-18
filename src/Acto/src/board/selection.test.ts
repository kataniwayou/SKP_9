import { describe, expect, it } from 'vitest';
import { hueOf } from './hues';
import { selectPick, withPicks, type Pick, type SelectionState } from './selection';

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
  // [user, 2026-11-18]: a plain click on something already selected unselects only it
  it('a plain click on the selected step unpicks it and keeps the workflows', () => {
    expect(selectPick({ workflows: ['a', 'b'], picks: [st('s')] }, st('s'), false)).toEqual({ workflows: ['a', 'b'], picks: [] });
    expect(selectPick({ workflows: [], picks: [st('s'), st('t')] }, st('t'), false)).toEqual({ workflows: [], picks: [st('s')] });
  });
  it('a plain click on a selected triangle unselects it, from the picks and from workflows', () => {
    expect(selectPick({ workflows: ['a'], picks: [wf('a')] }, wf('a'), false)).toEqual(none);
    expect(selectPick({ workflows: ['a', 'b'], picks: [wf('a'), wf('b')] }, wf('b'), false)).toEqual({ workflows: ['a'], picks: [wf('a')] });
    // drawn selected (in workflows) while a step is picked: still a selected triangle
    expect(selectPick({ workflows: ['a', 'b'], picks: [st('s')] }, wf('a'), false)).toEqual({ workflows: ['b'], picks: [st('s')] });
  });
  it('a plain click on a selected cache, wire, entry arrow, cache line or ghost unpicks only it', () => {
    const items: Pick[] = [{ kind: 'cache', id: 'c' }, { kind: 'wire', from: 's', to: 't' }, { kind: 'entry', workflowId: 'a', stepId: 's' },
      { kind: 'cacheLink', workflowId: 'a', cacheId: 'c' }, ghost('g')];
    for (const p of items) expect(selectPick({ workflows: ['a'], picks: [st('s'), p] }, p, false)).toEqual({ workflows: ['a'], picks: [st('s')] });
  });
  it('a plain click on an unselected item replaces the other picks, keeping workflows; ctrl toggles every kind', () => {
    expect(selectPick({ workflows: ['a'], picks: [st('s'), st('t')] }, { kind: 'cache', id: 'c' }, false)).toEqual({ workflows: ['a'], picks: [{ kind: 'cache', id: 'c' }] });
    const items: Pick[] = [wf('z'), st('u'), { kind: 'cache', id: 'c' }, { kind: 'wire', from: 's', to: 't' }, { kind: 'entry', workflowId: 'a', stepId: 's' },
      { kind: 'cacheLink', workflowId: 'a', cacheId: 'c' }, ghost('g')];
    for (const p of items) {
      const on = selectPick({ workflows: ['a'], picks: [st('s')] }, p, true);
      expect(on.picks).toEqual([st('s'), p]);
      expect(selectPick(on, p, true)).toEqual({ workflows: ['a'], picks: [st('s')] });
    }
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

describe('withPicks (the chat pick tool)', () => {
  it('picked steps keep the selected workflows', () => {
    expect(withPicks({ workflows: ['a', 'b'], picks: [wf('a'), wf('b')] }, [st('s')])).toEqual({ workflows: ['a', 'b'], picks: [st('s')] });
    expect(withPicks({ workflows: ['a'], picks: [wf('a')] }, [])).toEqual({ workflows: ['a'], picks: [] });
  });
  it('picked triangles become the selected workflows', () => {
    expect(withPicks({ workflows: ['x'], picks: [] }, [wf('a'), wf('b')])).toEqual({ workflows: ['a', 'b'], picks: [wf('a'), wf('b')] });
  });
});
