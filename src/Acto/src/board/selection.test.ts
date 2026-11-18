import { describe, expect, it } from 'vitest';
import { focusOf, listOf, stepTabsOf } from '../inspector/tabs';
import { board } from '../design/boardFixtures';
import { hueOf } from './hues';
import { selectPick, synced, withPicks, type Pick, type SelectionState } from './selection';

const wf = (id: string): Pick => ({ kind: 'workflow', id });
const st = (id: string): Pick => ({ kind: 'step', id });
const ghost = (key: string): Pick => ({ kind: 'ghost', key });
const cache: Pick = { kind: 'cache', id: 'c' };
const wire: Pick = { kind: 'wire', from: 's', to: 't' };
const entry: Pick = { kind: 'entry', workflowId: 'a', stepId: 's' };
const line: Pick = { kind: 'cacheLink', workflowId: 'a', cacheId: 'c' };
const none: SelectionState = { workflows: [], picks: [] };
/** A selection in the one shape: the workflows are the picked triangles. */
const sel = (...picks: Pick[]): SelectionState => ({ workflows: picks.flatMap((p) => (p.kind === 'workflow' ? [p.id] : [])), picks });
const click = (s: SelectionState, p: Pick | null) => selectPick(s, p, false);
const ctrl = (s: SelectionState, p: Pick) => selectPick(s, p, true);

// rule 1 [user, 2026-11-18], one test per line
describe('selectPick (rule 1)', () => {
  it('a plain click on an unselected triangle replaces every selected triangle, keeps the steps, drops the rest', () => {
    expect(click(sel(wf('a'), wf('b'), st('s'), st('t'), cache, wire, ghost('g')), wf('c'))).toEqual(sel(st('s'), st('t'), wf('c')));
    expect(click(none, wf('a'))).toEqual(sel(wf('a')));
  });
  it('a plain click on an unselected step replaces every selected step, keeps the triangles, drops the rest', () => {
    expect(click(sel(wf('a'), wf('b'), st('s'), st('t'), cache, entry), st('u'))).toEqual(sel(wf('a'), wf('b'), st('u')));
    expect(click(sel(cache), st('s'))).toEqual(sel(st('s')));
  });
  it('a plain click on an unselected cache, wire, entry arrow, cache line or ghost selects it alone', () => {
    for (const p of [cache, wire, entry, line, ghost('g')]) expect(click(sel(wf('a'), st('s'), wire === p ? cache : wire), p)).toEqual(sel(p));
    // an entry arrow or a cache line no longer selects its workflow
    expect(click(none, entry).workflows).toEqual([]);
  });
  it('Ctrl+click toggles any item in or out', () => {
    for (const p of [wf('z'), st('u'), cache, wire, entry, line, ghost('g')]) {
      const on = ctrl(sel(wf('a'), st('s')), p);
      expect(on).toEqual(synced({ workflows: [], picks: [wf('a'), st('s'), p] }));
      expect(ctrl(on, p)).toEqual(sel(wf('a'), st('s')));
    }
  });
  it('a plain click on an already selected item removes only it', () => {
    const all = sel(wf('a'), wf('b'), st('s'), cache);
    expect(click(all, wf('a'))).toEqual(sel(wf('b'), st('s'), cache));
    expect(click(all, st('s'))).toEqual(sel(wf('a'), wf('b'), cache));
    expect(click(all, cache)).toEqual(sel(wf('a'), wf('b'), st('s')));
    expect(click(sel(wf('a')), wf('a'))).toEqual(none);
  });
  it('a click on the empty board clears everything', () => {
    expect(click(sel(wf('a'), st('s')), null)).toEqual(none);
    expect(selectPick(sel(wf('a'), st('s')), null, true)).toEqual(none);
  });
  it('workflows are always the picked triangles, in pick order (their hues)', () => {
    const s = ctrl(ctrl(click(none, wf('b')), st('s')), wf('a'));
    expect(s.workflows).toEqual(['b', 'a']);
    expect(hueOf(s, 'b')).toBe('#FF0072');
    expect(hueOf(s, 'a')).toBe('#7C3AED');
    expect(hueOf(s, 'z')).toBeNull();
  });
  it('a selection of the old shape is read into the one shape', () => {
    expect(synced({ workflows: ['a'], picks: [st('s')] })).toEqual(sel(st('s'), wf('a')));
    expect(click({ workflows: ['a'], picks: [st('s')] }, wf('a'))).toEqual(sel(st('s')));
  });
});

// the user's sequence, and the two extra cases (spec §4/§5) [user, 2026-11-18]
describe('the user\'s sequence: clicks and what the Inspector shows', () => {
  const b = board(); // daily and hourly both enter fetch
  const shows = (s: SelectionState) => {
    const f = focusOf(s);
    if (listOf(s)) return 'list';
    if (!f) return 'nothing';
    if (f.kind === 'step') return `step ${f.id}${stepTabsOf(s, b, f.id).map((t) => ` + ${t.id}`).join('')}`;
    return `${f.kind} ${'id' in f ? f.id : ''}`.trim();
  };
  it('click A → A form; Ctrl+click B → list; Ctrl+click step → list; click B → step with A\'s assignment; click C → step with C\'s', () => {
    let s = click(none, wf('daily'));
    expect(shows(s)).toBe('workflow daily');
    s = ctrl(s, wf('hourly'));
    expect(shows(s)).toBe('list');
    s = ctrl(s, st('fetch'));
    expect(shows(s)).toBe('list');
    s = click(s, wf('hourly')); // selected: it leaves
    expect(s).toEqual(sel(wf('daily'), st('fetch')));
    expect(shows(s)).toBe('step fetch + assignment:daily');
    s = click(s, wf('hourly')); // a third triangle C (unselected): it replaces A, the step stays
    expect(s).toEqual(sel(st('fetch'), wf('hourly')));
    expect(shows(s)).toBe('step fetch + assignment:hourly');
  });
  it('two steps selected, then a click on a triangle: the list', () => {
    const s = click(ctrl(click(none, st('fetch')), st('expand')), wf('daily'));
    expect(s).toEqual(sel(st('fetch'), st('expand'), wf('daily')));
    expect(shows(s)).toBe('list');
  });
  it('a cache selected, then a click on a step: the cache is dropped', () => {
    const s = click(click(none, { kind: 'cache', id: 'c1' }), st('fetch'));
    expect(s).toEqual(sel(st('fetch')));
    expect(shows(s)).toBe('step fetch');
  });
});

describe('withPicks (the chat pick tool)', () => {
  it('takes the picks as they are; their triangles are the selected workflows', () => {
    expect(withPicks(sel(wf('a'), wf('b')), [st('s')])).toEqual(sel(st('s')));
    expect(withPicks(sel(wf('a')), [])).toEqual(none);
    expect(withPicks({ workflows: ['x'], picks: [] }, [wf('a'), st('s'), wf('b')])).toEqual(sel(wf('a'), st('s'), wf('b')));
  });
});
