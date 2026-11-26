import { describe, expect, it } from 'vitest';
import type { Pick, SelectionState } from '../board/selection';
import { board } from '../design/boardFixtures';

import type { GhostItem } from '../design/ghosts';
import { activeChild, activeTab, chooseChild, chooseTab, focusKey, formatInstant, keepChosen, listOf, processorTabsOf, stepTabsOf, tabsOf, type Chosen } from './tabs';

const b = board();
const noGhosts = { get: (): GhostItem | undefined => undefined };
const step = (id: string): Pick => ({ kind: 'step', id });
const ids = (sel: SelectionState, ghosts = noGhosts) => tabsOf(sel, b, ghosts).map((t) => t.id);

const withSlots = { ...b, processors: { p1: { ...b.processors.p1!, inputSchemaId: 's-in', configSchemaId: 's-cfg' } } };
const wfPick = (id: string): Pick => ({ kind: 'workflow', id });
/** A selection in the one shape: the workflows are the picked triangles. */
const sel = (...picks: Pick[]): SelectionState => ({ workflows: picks.flatMap((p) => (p.kind === 'workflow' ? [p.id] : [])), picks });
const cache: Pick = { kind: 'cache', id: 'c1' };

// rule 2 [user, 2026-11-18]: what the Inspector shows
describe('tabsOf and listOf (rule 2)', () => {
  it('exactly one workflow and nothing else: its Workflow form', () => {
    expect(ids(sel(wfPick('daily')))).toEqual(['workflow']);
    expect(focusKey(sel(wfPick('hourly')), b)).toBe('wf:hourly');
    expect(listOf(sel(wfPick('daily')), b)).toBeNull();
  });
  it('exactly one step and nothing else: Step · Processor, no assignment', () => {
    expect(ids(sel(step('fetch')))).toEqual(['step', 'processor']);
    expect(stepTabsOf(sel(step('fetch')), b, 'fetch')).toEqual([]);
  });
  it('exactly one workflow and one step: Step · Processor with that workflow\'s assignment under Step', () => {
    const s = sel(wfPick('daily'), step('fetch'));
    expect(ids(s)).toEqual(['step', 'processor']);
    expect(focusKey(s, b)).toBe('st:fetch');
    expect(listOf(s, b)).toBeNull();
    expect(stepTabsOf(s, b, 'fetch').map((t) => [t.id, t.label, t.hue])).toEqual([['assignment:daily', 'daily', '#FF0072']]);
    expect(stepTabsOf(sel(step('fetch'), wfPick('hourly')), b, 'fetch').map((t) => t.id)).toEqual(['assignment:hourly']);
  });
  it('exactly one other item: its own tab', () => {
    expect(ids(sel(cache))).toEqual(['cache']);
    expect(ids(sel({ kind: 'wire', from: 'fetch', to: 'expand' }))).toEqual(['link']);
    expect(ids(sel({ kind: 'entry', workflowId: 'daily', stepId: 'fetch' }))).toEqual(['link']);
    expect(ids(sel({ kind: 'cacheLink', workflowId: 'daily', cacheId: 'c1' }))).toEqual(['link']);
    const g: GhostItem = { key: 'step:gone', kind: 'step', row: { ...b.steps.lonely!, id: 'gone' } };
    const ghosts = { get: (k: string) => (k === g.key ? g : undefined) };
    expect(tabsOf(sel({ kind: 'ghost', key: 'step:gone' }), b, ghosts)).toEqual([{ id: 'ghost', label: 'Deleted' }]);
  });
  it('several workflows and one step all their streams reach: Step · Processor, one assignment tab per workflow in pick order, each in its hue [user, 2026-11-19]', () => {
    const s = sel(wfPick('hourly'), wfPick('daily'), step('fetch'));
    expect(ids(s)).toEqual(['step', 'processor']);
    expect(focusKey(s, b)).toBe('st:fetch');
    expect(listOf(s, b)).toBeNull();
    expect(stepTabsOf(s, b, 'fetch').map((t) => [t.id, t.label, t.hue])).toEqual([
      ['assignment:hourly', 'hourly', '#FF0072'], ['assignment:daily', 'daily', '#7C3AED']]);
    // expand is reached by both through fetch's wire
    expect(stepTabsOf(sel(wfPick('daily'), wfPick('hourly'), step('expand')), b, 'expand').map((t) => t.id)).toEqual(['assignment:daily', 'assignment:hourly']);
  });
  it("one workflow off the step's stream makes the whole selection a list, also when the others reach it", () => {
    const off = { ...b, workflows: { ...b.workflows, hourly: { ...b.workflows.hourly!, entryStepIds: ['lonely'] } } };
    const s = sel(wfPick('daily'), wfPick('hourly'), step('fetch'));
    expect(focusKey(s, off)).toBeNull();
    expect(listOf(s, off)).toEqual(s.picks);
    expect(stepTabsOf(s, off, 'fetch')).toEqual([]);
  });
  it('anything else: no tabs, the numbered pick list of everything selected', () => {
    const cases: SelectionState[] = [
      sel(wfPick('daily'), wfPick('hourly')),
      sel(step('fetch'), step('expand')),
      sel(wfPick('daily'), step('fetch'), step('expand')),
      sel(wfPick('daily'), step('lonely')), // the workflow's stream does not reach the step [user, 2026-11-19]
      sel(wfPick('daily'), wfPick('hourly'), step('lonely')),
      sel(wfPick('daily'), step('fetch'), cache),
      sel(wfPick('daily'), cache),
      sel(step('fetch'), cache),
      sel(cache, { kind: 'wire', from: 'fetch', to: 'expand' }),
    ];
    for (const s of cases) {
      expect(ids(s)).toEqual([]);
      expect(focusKey(s, b)).toBeNull();
      expect(listOf(s, b)).toEqual(s.picks);
    }
  });
  it('nothing selected: no tabs, no list', () => {
    expect(ids(sel())).toEqual([]);
    expect(listOf(sel(), b)).toBeNull();
  });
  it('a step without a processor, or with schemas: still Step and Processor on top', () => {
    const bare = { ...b, steps: { ...b.steps, fetch: { ...b.steps.fetch!, processorId: null } } };
    expect(tabsOf(sel(step('fetch')), bare, noGhosts).map((t) => t.id)).toEqual(['step', 'processor']);
    expect(tabsOf(sel(wfPick('daily'), step('fetch')), withSlots, noGhosts).map((t) => t.id)).toEqual(['step', 'processor']);
  });
});

describe("stepTabsOf (Step's children, rule 3)", () => {
  it("none when a picked workflow's stream does not hold the step", () => {
    expect(stepTabsOf(sel(wfPick('daily'), step('lonely')), b, 'lonely')).toEqual([]);
  });
  it('none without a workflow picked with the step, or with anything else picked', () => {
    expect(stepTabsOf(sel(step('fetch')), b, 'fetch')).toEqual([]);
    expect(stepTabsOf(sel(wfPick('daily'), step('fetch'), cache), b, 'fetch')).toEqual([]);
  });
});

describe("processorTabsOf (Processor's children)", () => {
  it('a schema tab per slot holding a schema, in slot order; no Processor child', () => {
    const subs = processorTabsOf(withSlots, 'p1');
    expect(subs.map((t) => t.id)).toEqual(['schema:input', 'schema:config']);
    expect(subs.map((t) => t.label)).toEqual(['Input schema', 'Config schema']);
  });
  it('no schemas, no processor or an unknown one: none', () => {
    expect(processorTabsOf(b, 'p1')).toEqual([]);
    expect(processorTabsOf(b, null)).toEqual([]);
    expect(processorTabsOf(b, 'gone')).toEqual([]);
  });
});

describe('keepChosen', () => {
  it('keeps the chosen tab for the same pick key and drops it for any other', () => {
    const chosen: Chosen = { key: 'st:fetch', tab: 'processor', children: {} };
    expect(keepChosen(chosen, 'st:fetch')).toBe(chosen);
    expect(keepChosen(chosen, 'wf:daily')).toBeNull();
    expect(keepChosen(null, 'st:fetch')).toBeNull();
  });
});

describe('activeTab, activeChild, chooseTab, chooseChild', () => {
  const s = sel(wfPick('daily'), step('fetch'));
  const tabs = tabsOf(s, b, noGhosts);
  const kids = stepTabsOf(s, b, 'fetch');
  const schemaKids = processorTabsOf(withSlots, 'p1');
  it('a new pick: Step, no child', () => {
    expect(activeTab(tabs, 'st:fetch', null)).toBe('step');
    expect(activeChild(kids, 'st:fetch', 'step', null)).toBeNull();
  });
  it('the chosen tab and child while the same pick stays and they exist', () => {
    const c = chooseChild(null, 'st:fetch', 'step', 'assignment:daily');
    expect(activeTab(tabs, 'st:fetch', c)).toBe('step');
    expect(activeChild(kids, 'st:fetch', 'step', c)).toBe('assignment:daily');
    expect(activeChild(kids, 'st:fetch', 'step', chooseChild(null, 'st:fetch', 'step', 'assignment:hourly'))).toBeNull();
    expect(activeChild(kids, 'st:expand', 'step', c)).toBeNull();
    expect(activeChild(kids, 'st:fetch', 'processor', c)).toBeNull();
    expect(activeTab(tabs, 'st:expand', { key: 'st:fetch', tab: 'processor', children: {} })).toBe('step');
  });
  it('each parent keeps its own child while the pick stays: Step child, Processor child, back to Step', () => {
    let c = chooseChild(null, 'st:fetch', 'step', 'assignment:daily');
    c = chooseTab(c, 'st:fetch', 'step', 'processor');
    expect(activeChild(schemaKids, 'st:fetch', 'processor', c)).toBeNull();
    c = chooseChild(c, 'st:fetch', 'processor', 'schema:config');
    c = chooseTab(c, 'st:fetch', 'processor', 'step');
    expect(activeTab(tabs, 'st:fetch', c)).toBe('step');
    expect(activeChild(kids, 'st:fetch', 'step', c)).toBe('assignment:daily');
    c = chooseTab(c, 'st:fetch', 'step', 'processor');
    expect(activeChild(schemaKids, 'st:fetch', 'processor', c)).toBe('schema:config');
  });
  it('a click on the shown parent returns it to its own fields and keeps the other parent\'s child', () => {
    let c = chooseChild(null, 'st:fetch', 'step', 'assignment:daily');
    c = chooseChild(chooseTab(c, 'st:fetch', 'step', 'processor'), 'st:fetch', 'processor', 'schema:input');
    c = chooseTab(c, 'st:fetch', 'processor', 'processor');
    expect(activeChild(schemaKids, 'st:fetch', 'processor', c)).toBeNull();
    expect(activeChild(kids, 'st:fetch', 'step', chooseTab(c, 'st:fetch', 'processor', 'step'))).toBe('assignment:daily');
  });
  it('a new pick forgets every child', () => {
    const c = chooseChild(null, 'st:fetch', 'step', 'assignment:daily');
    expect(chooseTab(c, 'st:expand', 'step', 'processor').children).toEqual({});
  });
});

describe('formatInstant', () => {
  it('YYYY-MM-DD HH:MM:SS.mmm UTC; — when absent', () => {
    expect(formatInstant('2026-10-05T12:00:00.123456Z')).toBe('2026-10-05 12:00:00.123 UTC');
    expect(formatInstant('2026-10-05T12:00:00Z')).toBe('2026-10-05 12:00:00.000 UTC');
    expect(formatInstant('2026-10-05T12:00:00.4Z')).toBe('2026-10-05 12:00:00.400 UTC');
    expect(formatInstant('2026-10-05T14:00:00.5+02:00')).toBe('2026-10-05 12:00:00.500 UTC');
    expect(formatInstant(null)).toBe('—');
    expect(formatInstant('')).toBe('—');
    expect(formatInstant('soon')).toBe('soon');
  });
});

describe('schema and processor picks', () => {
  const full = {
    ...withSlots,
    schemas: { 's-in': { id: 's-in' } as never, 's-cfg': { id: 's-cfg' } as never },
  };
  it('a schema pick gives the Schema tab; a processor pick gives Processor with its slot child tabs', () => {
    expect(tabsOf(sel({ kind: 'schema', id: 's-cfg' }), full, noGhosts)).toEqual([{ id: 'schema', label: 'Schema' }]);
    expect(tabsOf(sel({ kind: 'processor', id: 'p1' }), full, noGhosts)).toEqual([{ id: 'stepless', label: 'Processor' }]);
    expect(processorTabsOf(full, 'p1').map((t) => t.id)).toEqual(['schema:input', 'schema:config']);
    expect(tabsOf(sel({ kind: 'schema', id: 'gone' }), full, noGhosts)).toEqual([]);
  });
});
