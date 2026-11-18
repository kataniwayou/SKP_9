import { describe, expect, it } from 'vitest';
import type { Pick, SelectionState } from '../board/selection';
import { board } from '../design/boardFixtures';
import type { GhostItem } from '../design/ghosts';
import { activeTab, focusKey, formatInstant, keepChosen, tabsOf } from './tabs';

const b = board();
const noGhosts = { get: (): GhostItem | undefined => undefined };
const step = (id: string): Pick => ({ kind: 'step', id });
const ids = (sel: SelectionState, ghosts = noGhosts) => tabsOf(sel, b, ghosts).map((t) => t.id);

describe('tabsOf', () => {
  it('a step with no workflow selected: Step and Processor, no assignment', () => {
    expect(ids({ workflows: [], picks: [step('fetch')] })).toEqual(['step', 'processor']);
  });
  it('a step with workflows selected: one tab per workflow whose stream holds it, named after it, in its hue', () => {
    const tabs = tabsOf({ workflows: ['daily', 'hourly'], picks: [step('fetch')] }, b, noGhosts);
    expect(tabs.map((t) => t.id)).toEqual(['step', 'processor', 'assignment:daily', 'assignment:hourly']);
    expect(tabs.slice(2).map((t) => [t.label, t.hue])).toEqual([['daily', '#FF0072'], ['hourly', '#7C3AED']]);
    expect(tabs[0]!.hue).toBeUndefined();
  });
  it('a workflow whose stream does not hold the step has no tab', () => {
    expect(ids({ workflows: ['daily', 'hourly'], picks: [step('lonely')] })).toEqual(['step', 'processor']);
    const cut = { ...b, workflows: { ...b.workflows, hourly: { ...b.workflows.hourly!, entryStepIds: [] } } };
    expect(tabsOf({ workflows: ['daily', 'hourly'], picks: [step('expand')] }, cut, noGhosts).map((t) => t.id))
      .toEqual(['step', 'processor', 'assignment:daily']);
  });
  it('triangles only: the Workflow tab, for the last one clicked', () => {
    const sel: SelectionState = { workflows: ['daily', 'hourly'], picks: [{ kind: 'workflow', id: 'daily' }, { kind: 'workflow', id: 'hourly' }] };
    expect(ids(sel)).toEqual(['workflow']);
    expect(focusKey(sel)).toBe('wf:hourly');
    expect(focusKey({ workflows: ['daily', 'hourly'], picks: [] })).toBe('wf:hourly');
    expect(focusKey({ workflows: ['hourly', 'daily'], picks: [{ kind: 'workflow', id: 'hourly' }] })).toBe('wf:hourly');
  });
  it('a cache, a link, a ghost', () => {
    expect(ids({ workflows: [], picks: [{ kind: 'cache', id: 'c1' }] })).toEqual(['cache']);
    expect(ids({ workflows: [], picks: [{ kind: 'wire', from: 'fetch', to: 'expand' }] })).toEqual(['link']);
    expect(ids({ workflows: ['daily'], picks: [{ kind: 'entry', workflowId: 'daily', stepId: 'fetch' }] })).toEqual(['link']);
    expect(ids({ workflows: ['daily'], picks: [{ kind: 'cacheLink', workflowId: 'daily', cacheId: 'c1' }] })).toEqual(['link']);
    const g: GhostItem = { key: 'step:gone', kind: 'step', row: { ...b.steps.lonely!, id: 'gone' } };
    const ghosts = { get: (k: string) => (k === g.key ? g : undefined) };
    const tabs = tabsOf({ workflows: [], picks: [{ kind: 'ghost', key: 'step:gone' }] }, b, ghosts);
    expect(tabs).toEqual([{ id: 'ghost', label: 'Deleted' }]);
  });
  it('two or more non-triangle picks: no tabs (the pick list)', () => {
    expect(ids({ workflows: [], picks: [step('fetch'), step('expand')] })).toEqual([]);
    expect(ids({ workflows: ['daily'], picks: [{ kind: 'workflow', id: 'daily' }, step('fetch'), { kind: 'cache', id: 'c1' }] })).toEqual([]);
  });
  it('a triangle plus one step: the step', () => {
    expect(ids({ workflows: ['daily'], picks: [{ kind: 'workflow', id: 'daily' }, step('fetch')] })).toEqual(['step', 'processor', 'assignment:daily']);
  });
  it('nothing picked: no tabs', () => expect(ids({ workflows: [], picks: [] })).toEqual([]));
});

describe('keepChosen', () => {
  it('keeps the chosen tab for the same pick key and drops it for any other', () => {
    const chosen = { key: 'st:fetch', tab: 'processor' as const };
    expect(keepChosen(chosen, 'st:fetch')).toBe(chosen);
    expect(keepChosen(chosen, 'wf:daily')).toBeNull();
    expect(keepChosen(null, 'st:fetch')).toBeNull();
  });
});

describe('activeTab', () => {
  const tabs = tabsOf({ workflows: ['daily'], picks: [step('fetch')] }, b, noGhosts);
  it('the first tab on a new pick', () => expect(activeTab(tabs, 'st:fetch', null)).toBe('step'));
  it('the chosen tab while the same pick stays and the tab exists', () => {
    expect(activeTab(tabs, 'st:fetch', { key: 'st:fetch', tab: 'assignment:daily' })).toBe('assignment:daily');
    expect(activeTab(tabs, 'st:expand', { key: 'st:fetch', tab: 'processor' })).toBe('step');
    expect(activeTab(tabs, 'st:fetch', { key: 'st:fetch', tab: 'assignment:hourly' })).toBe('step');
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
