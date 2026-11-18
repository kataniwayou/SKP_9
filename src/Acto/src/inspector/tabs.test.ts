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

describe('tabsOf (the top row)', () => {
  it('a step: Step and Processor only, with or without workflows or schemas [user, 2026-11-18]', () => {
    expect(ids({ workflows: [], picks: [step('fetch')] })).toEqual(['step', 'processor']);
    expect(ids({ workflows: ['daily', 'hourly'], picks: [step('fetch')] })).toEqual(['step', 'processor']);
    expect(tabsOf({ workflows: ['daily'], picks: [step('fetch')] }, withSlots, noGhosts).map((t) => t.id)).toEqual(['step', 'processor']);
    const bare = { ...b, steps: { ...b.steps, fetch: { ...b.steps.fetch!, processorId: null } } };
    expect(tabsOf({ workflows: [], picks: [step('fetch')] }, bare, noGhosts).map((t) => t.id)).toEqual(['step', 'processor']);
  });
  it('a triangle plus one step: the step', () => {
    expect(ids({ workflows: ['daily'], picks: [wfPick('daily'), step('fetch')] })).toEqual(['step', 'processor']);
  });
  it('exactly one selected triangle: its Workflow tab', () => {
    expect(ids({ workflows: ['daily'], picks: [wfPick('daily')] })).toEqual(['workflow']);
    expect(focusKey({ workflows: ['hourly'], picks: [] })).toBe('wf:hourly');
  });
  it('two or more triangles only: no tabs, the pick list of those workflows [user, 2026-11-18]', () => {
    const sel: SelectionState = { workflows: ['daily', 'hourly'], picks: [wfPick('daily'), wfPick('hourly')] };
    expect(ids(sel)).toEqual([]);
    expect(focusKey(sel)).toBeNull();
    expect(listOf(sel)).toEqual([wfPick('daily'), wfPick('hourly')]);
    // a step unpicked, the workflows still selected: the same list
    expect(listOf({ workflows: ['daily', 'hourly'], picks: [] })).toEqual([wfPick('daily'), wfPick('hourly')]);
  });
  it('a cache, a link, a ghost', () => {
    expect(ids({ workflows: [], picks: [{ kind: 'cache', id: 'c1' }] })).toEqual(['cache']);
    expect(ids({ workflows: [], picks: [{ kind: 'wire', from: 'fetch', to: 'expand' }] })).toEqual(['link']);
    expect(ids({ workflows: ['daily'], picks: [{ kind: 'entry', workflowId: 'daily', stepId: 'fetch' }] })).toEqual(['link']);
    expect(ids({ workflows: ['daily', 'hourly'], picks: [{ kind: 'cacheLink', workflowId: 'daily', cacheId: 'c1' }] })).toEqual(['link']);
    const g: GhostItem = { key: 'step:gone', kind: 'step', row: { ...b.steps.lonely!, id: 'gone' } };
    const ghosts = { get: (k: string) => (k === g.key ? g : undefined) };
    const tabs = tabsOf({ workflows: [], picks: [{ kind: 'ghost', key: 'step:gone' }] }, b, ghosts);
    expect(tabs).toEqual([{ id: 'ghost', label: 'Deleted' }]);
  });
  it('two or more non-triangle picks: no tabs, the pick list of every pick, triangles included', () => {
    expect(ids({ workflows: [], picks: [step('fetch'), step('expand')] })).toEqual([]);
    const sel: SelectionState = { workflows: ['daily'], picks: [wfPick('daily'), step('fetch'), { kind: 'cache', id: 'c1' }] };
    expect(ids(sel)).toEqual([]);
    expect(listOf(sel)).toEqual(sel.picks);
  });
  it('one thing or nothing: no pick list', () => {
    expect(listOf({ workflows: ['daily', 'hourly'], picks: [step('fetch')] })).toBeNull();
    expect(listOf({ workflows: ['daily'], picks: [] })).toBeNull();
    expect(listOf({ workflows: [], picks: [] })).toBeNull();
  });
  it('nothing picked: no tabs', () => expect(ids({ workflows: [], picks: [] })).toEqual([]));
});

describe("stepTabsOf (Step's children)", () => {
  it('one assignment tab per selected workflow whose stream holds the step, in selection order, in its hue', () => {
    const tabs = stepTabsOf({ workflows: ['daily', 'hourly'], picks: [step('fetch')] }, b, 'fetch');
    expect(tabs.map((t) => [t.id, t.label, t.hue])).toEqual([['assignment:daily', 'daily', '#FF0072'], ['assignment:hourly', 'hourly', '#7C3AED']]);
    expect(stepTabsOf({ workflows: ['hourly', 'daily'], picks: [step('fetch')] }, b, 'fetch').map((t) => t.id)).toEqual(['assignment:hourly', 'assignment:daily']);
  });
  it('none without workflows, and none for a workflow whose stream does not hold it', () => {
    expect(stepTabsOf({ workflows: [], picks: [step('fetch')] }, b, 'fetch')).toEqual([]);
    expect(stepTabsOf({ workflows: ['daily', 'hourly'], picks: [step('lonely')] }, b, 'lonely')).toEqual([]);
    const cut = { ...b, workflows: { ...b.workflows, hourly: { ...b.workflows.hourly!, entryStepIds: [] } } };
    expect(stepTabsOf({ workflows: ['daily', 'hourly'], picks: [step('expand')] }, cut, 'expand').map((t) => t.id)).toEqual(['assignment:daily']);
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
  const sel: SelectionState = { workflows: ['daily'], picks: [step('fetch')] };
  const tabs = tabsOf(sel, b, noGhosts);
  const kids = stepTabsOf(sel, b, 'fetch');
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
  it('each parent keeps its own child while the pick stays: Step child, Processor child, back to Step [review, 2026-11-18]', () => {
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
