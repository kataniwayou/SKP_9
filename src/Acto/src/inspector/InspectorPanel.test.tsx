import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Pick } from '../board/selection';
import { createBoardStore, type BoardStore } from '../design/boardStore';
import { createGhostStore, type GhostStore } from '../design/ghosts';
import { board, shared } from '../design/boardFixtures';
import type { BoardState } from '../design/board';
import { setPayload } from '../design/payloads';
import { LiveStoreProvider } from '../live/LiveContext';
import { createOutputStore } from '../output/outputStore';
import { liveStub } from '../test/liveStub';
import { InspectorPanel } from './InspectorPanel';

type Sel = { workflows: string[]; picks: Pick[] };

function setup(selection: Sel, state: BoardState = board()) {
  const store = createBoardStore(createOutputStore(null, () => '00:00:00'), null);
  store.load(state);
  const ghosts: GhostStore = createGhostStore(store);
  const ui = (sel: Sel) => <LiveStoreProvider value={liveStub()}><InspectorPanel store={store} selection={sel} ghosts={ghosts} /></LiveStoreProvider>;
  const view = render(ui(selection));
  return { store, ghosts, rerender: (sel: Sel) => view.rerender(ui(sel)) };
}
// the top row only: the Processor tab's sub-tabs are a second tablist
const topTabs = () => { const l = screen.queryByRole('tablist', { name: 'Inspector tabs' }); return l ? within(l).queryAllByRole('tab') : []; };
const tabNames = () => topTabs().map((t) => t.textContent);
const openTab = (name: string) => fireEvent.click(topTabs().find((t) => t.textContent === name)!);
const selectedTab = () => topTabs().find((t) => t.getAttribute('aria-selected') === 'true')?.textContent;
const subTabs = () => within(screen.getByRole('tablist', { name: 'Processor tabs' })).getAllByRole('tab');
const selectedSub = () => subTabs().find((t) => t.getAttribute('aria-selected') === 'true')?.textContent;
const step = (id: string): Pick => ({ kind: 'step', id });
// getByDisplayValue collapses whitespace: the pretty payload as it matches
const SHARED = '{ "shared": true }';
const payloadOf = (s: BoardStore, wf: string) => s.state().assignments[s.state().workflows[wf]!.assignmentIds[0]!]!.payload;

// the show-all toggle is remembered in sessionStorage: each test starts closed
afterEach(() => sessionStorage.clear());

describe('InspectorPanel', () => {
  it('summarises the board when nothing is selected', () => {
    setup({ workflows: [], picks: [] });
    expect(screen.getByText(/Select a workflow/)).toBeInTheDocument();
    expect(screen.getByText(/2 workflows/)).toBeInTheDocument();
  });

  describe('tabs', () => {
    it('a step with no workflow: Step and Processor; with workflows: one tab per workflow whose stream holds it', () => {
      const { rerender } = setup({ workflows: [], picks: [step('fetch')] });
      expect(tabNames()).toEqual(['Step', 'Processor']);
      rerender({ workflows: ['daily', 'hourly'], picks: [step('fetch')] });
      expect(tabNames()).toEqual(['Step', 'Processor', 'daily', 'hourly']);
      expect([...document.querySelectorAll('.ins-tab .dot')].map((d) => (d as HTMLElement).style.background)).toEqual(['rgb(255, 0, 114)', 'rgb(124, 58, 237)']);
      rerender({ workflows: ['daily'], picks: [step('lonely')] });
      expect(tabNames()).toEqual(['Step', 'Processor']);
    });
    it('the first tab opens on a new pick; a chosen tab is kept while the same pick stays', () => {
      const { rerender } = setup({ workflows: ['daily'], picks: [step('fetch')] });
      expect(selectedTab()).toBe('Step');
      openTab('Processor');
      expect(selectedTab()).toBe('Processor');
      rerender({ workflows: ['daily', 'hourly'], picks: [step('fetch')] });
      expect(selectedTab()).toBe('Processor');
      openTab('hourly');
      rerender({ workflows: ['daily'], picks: [step('fetch')] }); // the hourly tab is gone
      expect(selectedTab()).toBe('Step');
      openTab('Processor');
      rerender({ workflows: ['daily'], picks: [step('expand')] });
      expect(selectedTab()).toBe('Step');
    });
    it('Processor sub-tabs: the first on a new pick; the chosen one kept while the pick stays and it exists [user, 2026-11-18]', () => {
      const b0 = board();
      const slots = { ...b0, processors: { p1: { ...b0.processors.p1!, configSchemaId: 's-cfg' } },
        schemas: { 's-cfg': { id: 's-cfg', name: 'cfg', version: '1.0.0', description: null, definition: '{}', audit: { createdAt: '', createdBy: null, updatedAt: '', updatedBy: null }, updatedAt: null } } };
      const { store, rerender } = setup({ workflows: [], picks: [step('fetch')] }, slots);
      openTab('Processor');
      expect(subTabs().map((t) => t.textContent)).toEqual(['Processor', 'Config schema']);
      expect(selectedSub()).toBe('Processor');
      fireEvent.click(subTabs()[1]!);
      expect(selectedSub()).toBe('Config schema');
      expect(screen.getByText('schema · config of proc')).toBeInTheDocument();
      // the same pick, away to Step and back: the sub-tab is kept
      openTab('Step');
      openTab('Processor');
      expect(selectedSub()).toBe('Config schema');
      rerender({ workflows: ['daily'], picks: [step('fetch')] });
      expect(selectedSub()).toBe('Config schema');
      // the slot emptied: the sub-tab is gone, the first one shows
      act(() => store.edit((b) => ({ ...b, processors: { p1: { ...b.processors.p1!, configSchemaId: null } } })));
      expect(selectedSub()).toBe('Processor');
      act(() => store.undo());
      expect(selectedSub()).toBe('Config schema');
      // a new pick opens the first sub-tab
      rerender({ workflows: [], picks: [step('expand')] });
      openTab('Processor');
      expect(selectedSub()).toBe('Processor');
    });
    it('a step picked again after another pick opens on its first tab: step → triangle → the same step', () => {
      const { rerender } = setup({ workflows: [], picks: [step('fetch')] });
      openTab('Processor');
      expect(selectedTab()).toBe('Processor');
      rerender({ workflows: ['daily'], picks: [{ kind: 'workflow', id: 'daily' }] });
      expect(selectedTab()).toBe('Workflow');
      rerender({ workflows: ['daily'], picks: [step('fetch')] });
      expect(selectedTab()).toBe('Step');
    });
    it('triangles only: the Workflow tab of the last one clicked', () => {
      setup({ workflows: ['daily', 'hourly'], picks: [{ kind: 'workflow', id: 'daily' }, { kind: 'workflow', id: 'hourly' }] });
      expect(tabNames()).toEqual(['Workflow']);
      expect(screen.getByLabelText('Name')).toHaveValue('hourly');
    });
    it('workflows selected and nothing picked: the last selected workflow', () => {
      setup({ workflows: ['hourly', 'daily'], picks: [] });
      expect(screen.getByLabelText('Name')).toHaveValue('daily');
    });
  });

  describe('show all', () => {
    it('reveals Id, Created at, Created by, Updated at, Updated by; the state survives switching tabs and is kept for the session', () => {
      setup({ workflows: ['daily'], picks: [step('fetch')] });
      expect(screen.queryByText('Created at')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: '▸ show all' }));
      expect(sessionStorage.getItem('acto.details')).toBe('1');
      for (const k of ['Id', 'Created at', 'Created by', 'Updated at', 'Updated by']) expect(screen.getByText(k)).toBeInTheDocument();
      expect(screen.getByText('Id').nextSibling).toHaveTextContent('fetch');
      expect(screen.getByText('Created at').nextSibling).toHaveTextContent('2026-11-01 00:00:00.000 UTC');
      expect(screen.getByText('Created by').nextSibling).toHaveTextContent('—');
      openTab('daily');
      expect(screen.getByRole('button', { name: '▾ hide details' })).toBeInTheDocument();
      expect(screen.getByText('Id').nextSibling).toHaveTextContent('a-daily-fetch');
      fireEvent.click(screen.getByRole('button', { name: '▾ hide details' }));
      openTab('Step');
      expect(screen.getByRole('button', { name: '▸ show all' })).toBeInTheDocument();
      expect(screen.queryByText('Created at')).toBeNull();
    });
    it('a row made on the board shows — for every audit field', () => {
      const { store } = setup({ workflows: ['daily'], picks: [step('fetch')] });
      fireEvent.click(screen.getByRole('button', { name: '▸ show all' }));
      act(() => store.edit((b) => ({ ...b, steps: { ...b.steps, fetch: { ...b.steps.fetch!, updatedAt: null, createdAt: null } } })));
      expect(screen.getByText('Created at').nextSibling).toHaveTextContent('—');
      expect(screen.getByText('Updated at').nextSibling).toHaveTextContent('—');
    });
  });

  describe('step', () => {
    it('the unique name, the kind line, the shared fields and who uses it', () => {
      setup({ workflows: [], picks: [step('fetch')] });
      expect(screen.getByLabelText('Unique name')).toHaveTextContent('fetch-orders 1.0.0');
      expect(screen.getByText('step · shared by daily, hourly')).toBeInTheDocument();
      expect(screen.getByLabelText('Name')).toHaveValue('fetch-orders');
      expect(screen.getByLabelText('Version')).toHaveValue('1.0.0');
      expect(screen.getByRole('combobox', { name: 'Entry condition' })).toHaveAttribute('data-value', '1');
      expect(screen.getByText('Used by').nextSibling).toHaveTextContent('daily, hourly');
      expect(screen.queryByLabelText('Payload')).toBeNull();
    });
    it('a shared field edit goes to the step', () => {
      const { store } = setup({ workflows: ['daily'], picks: [step('fetch')] });
      fireEvent.change(screen.getByDisplayValue('fetch-orders'), { target: { value: 'renamed' } });
      expect(store.state().steps.fetch!.name).toBe('renamed');
    });
    it('the entry condition is set on the step', () => {
      const { store } = setup({ workflows: [], picks: [step('fetch')] });
      fireEvent.click(screen.getByRole('combobox', { name: 'Entry condition' }));
      fireEvent.click(screen.getByRole('option', { name: /Failed/ }));
      expect(store.state().steps.fetch!.entryCondition).toBe(2);
    });
  });

  describe('assignment tab', () => {
    const PRETTY = '{\n  "share": "/mnt",\n  "n": [\n    1,\n    2\n  ]\n}';
    const opened = (sel: Sel, state?: BoardState) => { const r = setup(sel, state); openTab(sel.workflows.at(-1)!); return r; };
    it('shows the payload of its own workflow, pretty, on the same step', () => {
      const { store } = setup({ workflows: ['daily', 'hourly'], picks: [step('fetch')] });
      act(() => store.edit((b) => setPayload(b, 'hourly', 'fetch', '{"every":"hour"}', () => 'x')));
      act(() => store.edit((b) => setPayload(b, 'daily', 'fetch', '{"every":"day"}', () => 'y')));
      openTab('daily');
      expect(screen.getByText('assignment · belongs to daily')).toBeInTheDocument();
      expect(screen.getByLabelText('Payload')).toHaveValue('{\n  "every": "day"\n}');
      openTab('hourly');
      expect(screen.getByLabelText('Payload')).toHaveValue('{\n  "every": "hour"\n}');
    });
    it('editing the payload changes that workflow only, one undo step while typing', () => {
      const { store } = opened({ workflows: ['daily'], picks: [step('fetch')] });
      const area = screen.getByLabelText('Payload');
      fireEvent.change(area, { target: { value: '{"a"' } });
      fireEvent.change(area, { target: { value: '{"a":1}' } });
      expect(payloadOf(store, 'daily')).toBe('{"a":1}');
      expect(payloadOf(store, 'hourly')).toBe('{}');
      act(() => store.undo());
      expect(payloadOf(store, 'daily')).toBe('{}');
      expect(screen.getByLabelText('Payload')).toHaveValue('{}');
    });
    it('the same JSON retyped in another layout is no edit (Review Focus 5)', () => {
      const b0 = board();
      const b: BoardState = { ...b0, assignments: { ...b0.assignments, 'a-daily-fetch': { ...b0.assignments['a-daily-fetch']!, payload: '{"share":"/mnt","n":[1,2]}' } } };
      const { store } = opened({ workflows: ['daily'], picks: [step('fetch')] }, b);
      const area = screen.getByLabelText('Payload');
      expect(area).toHaveValue(PRETTY);
      fireEvent.change(area, { target: { value: '{ "share" : "/mnt", "n" : [ 1, 2 ] }' } });
      expect(area).toHaveValue('{ "share" : "/mnt", "n" : [ 1, 2 ] }'); // kept as typed while typing
      expect(store.unsaved().size).toBe(0);
      expect(store.canUndo()).toBe(false);
      fireEvent.blur(area);
      expect(area).toHaveValue(PRETTY);
    });
    it('the JSON check shows under the payload', () => {
      const { store } = opened({ workflows: ['daily'], picks: [step('fetch')] });
      fireEvent.change(screen.getByLabelText('Payload'), { target: { value: '{oops' } });
      expect(document.querySelector('.in-problem')).not.toBeNull();
      expect(store.state().assignments['a-daily-fetch']!.payload).toBe('{oops');
      expect(screen.getByLabelText('Payload')).toHaveValue('{oops');
    });
    it('Remove assignment unlinks it from that workflow only; then an empty payload makes one on typing', () => {
      const { store } = opened({ workflows: ['daily'], picks: [step('fetch')] });
      fireEvent.click(screen.getByRole('button', { name: 'Remove assignment' }));
      expect(store.state().workflows.daily!.assignmentIds).toEqual([]);
      expect(store.state().workflows.hourly!.assignmentIds).toEqual(['a-hourly-fetch']);
      expect(screen.queryByRole('button', { name: 'Remove assignment' })).toBeNull();
      expect(screen.getByLabelText('Payload')).toHaveValue('');
      fireEvent.change(screen.getByLabelText('Payload'), { target: { value: '{"z":1}' } });
      expect(payloadOf(store, 'daily')).toBe('{"z":1}');
    });
    it('changed, then typed back to the saved JSON in another layout: nothing unsaved (the saved text itself is written)', () => {
      const b0 = board();
      const b: BoardState = { ...b0, assignments: { ...b0.assignments, 'a-daily-fetch': { ...b0.assignments['a-daily-fetch']!, payload: '{"a":1}' } } };
      const { store } = opened({ workflows: ['daily'], picks: [step('fetch')] }, b);
      const area = screen.getByLabelText('Payload');
      fireEvent.change(area, { target: { value: '{"a":2}' } });
      expect(store.unsaved().size).toBe(1);
      fireEvent.change(area, { target: { value: '{ "a" : 1 }' } });
      expect(payloadOf(store, 'daily')).toBe('{"a":1}');
      expect(store.unsaved().size).toBe(0);
      expect(area).toHaveValue('{ "a" : 1 }');
    });
    it('Name, Version and Description edit the assignment row, one undo step while typing', () => {
      const { store } = opened({ workflows: ['daily'], picks: [step('fetch')] });
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'f' } });
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'fx' } });
      fireEvent.change(screen.getByLabelText('Version'), { target: { value: '2.0.0' } });
      fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'd' } });
      expect(store.state().assignments['a-daily-fetch']).toMatchObject({ name: 'fx', version: '2.0.0', description: 'd' });
      expect(store.state().assignments['a-hourly-fetch']!.name).toBe('fetch-assignment');
      fireEvent.change(screen.getByLabelText('Description'), { target: { value: '' } });
      expect(store.state().assignments['a-daily-fetch']!.description).toBeNull();
      act(() => { store.undo(); store.undo(); store.undo(); });
      expect(store.state().assignments['a-daily-fetch']!.name).toBe('fetch-assignment');
    });
    it('a field edit of a row both workflows link copies it for its own workflow once, then edits the copy', () => {
      const { store } = opened({ workflows: ['daily'], picks: [step('fetch')] }, shared());
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'd' } });
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'da' } });
      const s = store.state();
      expect(s.assignments['a-shared']!.name).toBe('fetch-assignment');
      expect(s.workflows.hourly!.assignmentIds).toEqual(['a-shared']);
      const copy = s.workflows.daily!.assignmentIds[0]!;
      expect(copy).not.toBe('a-shared');
      expect(s.assignments[copy]).toMatchObject({ name: 'da', payload: '{"shared":true}', updatedAt: null });
      expect(Object.keys(s.assignments)).toHaveLength(2);
    });
    it('a payload on a row both workflows link is copied for its own workflow, as a new row', () => {
      const { store } = opened({ workflows: ['daily'], picks: [step('fetch')] }, shared());
      fireEvent.change(screen.getByLabelText('Payload'), { target: { value: '{"d":1}' } });
      const s = store.state();
      expect(s.assignments['a-shared']!.payload).toBe('{"shared":true}');
      expect(s.workflows.hourly!.assignmentIds).toEqual(['a-shared']);
      expect(s.assignments[s.workflows.daily!.assignmentIds[0]!]).toMatchObject({ payload: '{"d":1}', createdAt: null, createdBy: null, updatedBy: null, updatedAt: null });
    });
  });

  it('the Processor tab shows the processor', () => {
    setup({ workflows: [], picks: [step('fetch')] });
    openTab('Processor');
    expect(screen.getByDisplayValue('proc')).toBeInTheDocument();
    expect(screen.getByText('processor · used by 3 steps')).toBeInTheDocument();
  });

  describe('workflow', () => {
    const sel: Sel = { workflows: ['daily'], picks: [{ kind: 'workflow', id: 'daily' }] };
    it('edits name, cron (with its text)', () => {
      const { store } = setup(sel);
      fireEvent.change(screen.getByDisplayValue('daily'), { target: { value: 'nightly' } });
      expect(store.state().workflows.daily!.name).toBe('nightly');
      fireEvent.change(screen.getByLabelText('Cron'), { target: { value: '0 0 * * *' } });
      expect(store.state().workflows.daily!.cronExpression).toBe('0 0 * * *');
      expect(screen.queryByText('not scheduled')).toBeNull();
      fireEvent.change(screen.getByLabelText('Cron'), { target: { value: '' } });
      expect(store.state().workflows.daily!.cronExpression).toBeNull();
      expect(screen.getByText('not scheduled')).toBeInTheDocument();
    });
    it('lists entry steps and caches, each with Remove', () => {
      const { store } = setup(sel);
      fireEvent.click(screen.getByRole('button', { name: 'Remove entry fetch-orders' }));
      expect(store.state().workflows.daily!.entryStepIds).toEqual([]);
      fireEvent.click(screen.getByRole('button', { name: 'Remove cache c1' }));
      expect(store.state().workflows.daily!.cacheIds).toEqual([]);
    });
    it('lists every assignment, including one on a step it does not reach, editable and deletable', () => {
      const { store } = setup(sel);
      act(() => store.edit((b) => setPayload(b, 'daily', 'lonely', '{"x":1}', () => 'new-a')));
      const list = screen.getByTestId('assignments');
      expect(within(list).getByText('lonely')).toBeInTheDocument();
      expect(within(list).getByText('fetch-orders')).toBeInTheDocument();
      fireEvent.change(within(list).getByDisplayValue('{ "x": 1 }'), { target: { value: '{"x":2}' } });
      expect(store.state().assignments['new-a']!.payload).toBe('{"x":2}');
      fireEvent.click(within(list).getAllByRole('button', { name: 'Delete' })[1]!);
      expect(store.state().workflows.daily!.assignmentIds).toEqual(['a-daily-fetch']);
      expect(store.state().assignments['new-a']).toBeUndefined();
    });
    it('two assignments of one workflow on the same step are each editable by their own id', () => {
      const b0 = board();
      const b: BoardState = { ...b0,
        assignments: { ...b0.assignments, a2: { ...b0.assignments['a-daily-fetch']!, id: 'a2', payload: '{"second":1}' } },
        workflows: { ...b0.workflows, daily: { ...b0.workflows.daily!, assignmentIds: ['a-daily-fetch', 'a2'] } } };
      const { store } = setup(sel, b);
      fireEvent.change(within(screen.getByTestId('assignments')).getByDisplayValue('{ "second": 1 }'), { target: { value: '{"second":2}' } });
      expect(store.state().assignments.a2!.payload).toBe('{"second":2}');
      expect(store.state().assignments['a-daily-fetch']!.payload).toBe('{}');
    });
    it('a list edit of a row another workflow links copies it for this one', () => {
      const { store } = setup(sel, shared());
      fireEvent.change(within(screen.getByTestId('assignments')).getByDisplayValue(SHARED), { target: { value: '{"d":1}' } });
      const s = store.state();
      expect(s.assignments['a-shared']!.payload).toBe('{"shared":true}');
      expect(s.workflows.hourly!.assignmentIds).toEqual(['a-shared']);
      expect(s.assignments[s.workflows.daily!.assignmentIds[0]!]!.payload).toBe('{"d":1}');
    });
    it('typing into a shared payload in the list keeps the same focused textarea and is one undo step', () => {
      const { store } = setup(sel, shared());
      const list = screen.getByTestId('assignments');
      const area = within(list).getByDisplayValue(SHARED);
      area.focus();
      fireEvent.change(area, { target: { value: '{"shared":tru' } });
      expect(document.activeElement).toBe(area);
      fireEvent.change(area, { target: { value: '{"d":1}' } });
      expect(document.activeElement).toBe(area);
      expect(within(screen.getByTestId('assignments')).getByDisplayValue('{"d":1}')).toBe(area);
      act(() => store.undo());
      expect(store.state().workflows.daily!.assignmentIds).toEqual(['a-shared']);
      expect(store.canUndo()).toBe(false);
    });
    it('a bad payload in the list shows the JSON check', () => {
      setup(sel);
      fireEvent.change(within(screen.getByTestId('assignments')).getByDisplayValue('{}'), { target: { value: 'nope' } });
      expect(document.querySelector('.in-problem')).not.toBeNull();
    });
    it('the payload keys in its stream, one line per step with a payload', () => {
      const { store } = setup(sel);
      act(() => store.edit((b) => setPayload(b, 'daily', 'fetch', '{"a":1,"b":2}', () => 'n')));
      expect(screen.getByText('Payload keys in its stream')).toBeInTheDocument();
      expect(screen.getAllByText('fetch-orders').at(-1)!.nextSibling).toHaveTextContent('◆ 2 keys');
    });
    it('caches are chips with a count', () => {
      setup(sel);
      expect(screen.getByText('Caches · 1')).toBeInTheDocument();
      expect(screen.getByText('workflow · checking…')).toBeInTheDocument();
    });
    it('shows the location', () => {
      setup(sel);
      expect(screen.getByText('Location').nextSibling).toHaveTextContent('0, 0');
    });
  });

  it('a cache shows its fields, its items pretty and who uses it', () => {
    const b0 = board();
    const { store } = setup({ workflows: [], picks: [{ kind: 'cache', id: 'c1' }] }, { ...b0, caches: { c1: { ...b0.caches.c1!, items: '{"k":"v"}' } } });
    expect(screen.getByRole('tab', { name: 'Cache' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Root'), { target: { value: 'new-root' } });
    expect(store.state().caches.c1!.root).toBe('new-root');
    expect(screen.getByLabelText('Items')).toHaveValue('{\n  "k": "v"\n}');
    fireEvent.change(screen.getByLabelText('Items'), { target: { value: '{"k" :"v"}' } });
    expect(store.state().caches.c1!.items).toBe('{"k":"v"}');
    expect(screen.getByText('Used by').nextSibling).toHaveTextContent('daily');
  });

  it('a ghost shows its snapshot read-only in a Deleted tab, and its name in the pick list', () => {
    const { store, rerender } = setup({ workflows: [], picks: [] });
    act(() => store.edit((b) => { const steps = { ...b.steps }; delete steps.lonely; return { ...b, steps }; }));
    rerender({ workflows: [], picks: [{ kind: 'ghost', key: 'step:lonely' }] });
    expect(tabNames()).toEqual(['Deleted']);
    expect(screen.getByText('deleted · step')).toBeInTheDocument();
    expect(screen.getByText('Name').nextSibling).toHaveTextContent('lonely');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('Deleted — Restore or Remove from its toolbar.')).toBeInTheDocument();
    rerender({ workflows: [], picks: [{ kind: 'ghost', key: 'step:lonely' }, step('fetch')] });
    expect([...document.querySelectorAll('.in-picks li')].map((li) => li.textContent)).toEqual(['lonely', 'fetch-orders']);
  });

  it('a wire, an entry arrow and a cache line show from, to and the condition', () => {
    const { rerender } = setup({ workflows: [], picks: [{ kind: 'wire', from: 'fetch', to: 'expand' }] });
    expect(screen.getByText('From').nextSibling).toHaveTextContent('fetch-orders');
    expect(screen.getByText('To').nextSibling).toHaveTextContent('expand');
    expect(screen.getByText('Runs when').nextSibling).toHaveTextContent('Completed');
    rerender({ workflows: ['daily'], picks: [{ kind: 'entry', workflowId: 'daily', stepId: 'fetch' }] });
    expect(screen.getByText('From').nextSibling).toHaveTextContent('daily');
    expect(screen.getByText('To').nextSibling).toHaveTextContent('fetch-orders');
    rerender({ workflows: ['daily'], picks: [{ kind: 'cacheLink', workflowId: 'daily', cacheId: 'c1' }] });
    expect(screen.getByText('To').nextSibling).toHaveTextContent('c1');
  });

  it('several picks are listed, in pick order', () => {
    setup({ workflows: ['daily'], picks: [step('expand'), { kind: 'cache', id: 'c1' }, { kind: 'wire', from: 'fetch', to: 'expand' }] });
    expect(screen.getByText('3 selected')).toBeInTheDocument();
    expect([...document.querySelectorAll('.in-picks li')].map((li) => li.textContent)).toEqual(['expand', 'c1', 'fetch-orders → expand']);
  });

  it('Undo and Redo act on the one board history', () => {
    const { store } = setup({ workflows: ['daily'], picks: [{ kind: 'workflow', id: 'daily' }] });
    const undo = screen.getByRole('button', { name: 'Undo' });
    const redo = screen.getByRole('button', { name: 'Redo' });
    expect(undo).toBeDisabled();
    fireEvent.change(screen.getByDisplayValue('daily'), { target: { value: 'x' } });
    expect(undo).toBeEnabled();
    fireEvent.click(undo);
    expect(store.state().workflows.daily!.name).toBe('daily');
    expect(redo).toBeEnabled();
    fireEvent.click(redo);
    expect(store.state().workflows.daily!.name).toBe('x');
  });
});
