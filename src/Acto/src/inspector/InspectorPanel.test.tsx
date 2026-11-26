import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
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
import { withSchemas } from './tabs/testBoard';

type Sel = { workflows: string[]; picks: Pick[] };

function setup(selection: Sel, state: BoardState = board()) {
  const store = createBoardStore(createOutputStore(null, () => '00:00:00'), null);
  store.load(state);
  const ghosts: GhostStore = createGhostStore(store);
  const ui = (sel: Sel) => <LiveStoreProvider value={liveStub()}><InspectorPanel store={store} selection={sel} ghosts={ghosts} /></LiveStoreProvider>;
  const view = render(ui(selection));
  return { store, ghosts, rerender: (sel: Sel) => view.rerender(ui(sel)) };
}
/// the top row; Step's and Processor's children are second tablists
const rowTabs = (name: string) => { const l = screen.queryByRole('tablist', { name }); return l ? within(l).queryAllByRole('tab') : []; };
const topTabs = () => rowTabs('Inspector tabs');
const tabNames = () => topTabs().map((t) => t.textContent);
const childNames = (row: 'Step' | 'Processor') => rowTabs(`${row} tabs`).map((t) => t.textContent);
/** A top tab by its label, else a child of the open parent (a workflow's name under Step, a schema under Processor). */
const openTab = (name: string) => {
  const top = topTabs().find((t) => t.textContent === name);
  if (top) { fireEvent.click(top); return; }
  if (!rowTabs('Step tabs').some((t) => t.textContent === name) && !rowTabs('Processor tabs').some((t) => t.textContent === name)) {
    fireEvent.click(topTabs().find((t) => t.textContent === 'Step')!);
  }
  fireEvent.click([...rowTabs('Step tabs'), ...rowTabs('Processor tabs')].find((t) => t.textContent === name)!);
};
const selectedTab = () => topTabs().find((t) => t.getAttribute('aria-selected') === 'true')?.textContent;
const selectedChild = (row: 'Step' | 'Processor') => rowTabs(`${row} tabs`).find((t) => t.getAttribute('aria-selected') === 'true')?.textContent ?? null;
const step = (id: string): Pick => ({ kind: 'step', id });
const payloadOf = (s: BoardStore, wf: string) => s.state().assignments[s.state().workflows[wf]!.assignmentIds[0]!]!.payload;

// the show-all toggle is remembered in sessionStorage: each test starts closed
afterEach(() => sessionStorage.clear());

describe('InspectorPanel', () => {
  it('summarises the board when nothing is selected', () => {
    setup({ workflows: [], picks: [] });
    expect(screen.getByText(/Select a workflow/)).toBeInTheDocument();
    expect(screen.getByText(/2 workflows/)).toBeInTheDocument();
  });

  describe('tabs (rules 2 and 3 [user, 2026-11-18])', () => {
    // the selection in the one shape: triangles are picks too
    const wfP = (id: string): Pick => ({ kind: 'workflow', id });
    it('one step alone: Step · Processor, no child row; with one workflow: its one assignment under Step, in its hue', () => {
      const { rerender } = setup({ workflows: [], picks: [step('fetch')] });
      expect(tabNames()).toEqual(['Step', 'Processor']);
      expect(screen.queryByRole('tablist', { name: 'Step tabs' })).toBeNull();
      rerender({ workflows: ['daily'], picks: [wfP('daily'), step('fetch')] });
      expect(tabNames()).toEqual(['Step', 'Processor']);
      expect(childNames('Step')).toEqual(['daily']);
      expect(selectedChild('Step')).toBeNull();
      expect([...document.querySelectorAll('.ins-subtab .dot')].map((d) => (d as HTMLElement).style.background)).toEqual(['rgb(255, 0, 114)']);
      expect(screen.getByLabelText('Name')).toHaveValue('fetch-orders'); // the step's own fields
      rerender({ workflows: ['daily'], picks: [wfP('daily'), step('lonely')] }); // not in daily's stream: the list [user, 2026-11-19]
      expect(tabNames()).toEqual([]);
      expect(screen.getByText('2 selected')).toBeInTheDocument();
    });
    it('several workflows with one step all their streams reach: one assignment tab per workflow, in pick order and hue [user, 2026-11-19]', () => {
      const { rerender } = setup({ workflows: ['hourly', 'daily'], picks: [wfP('hourly'), wfP('daily'), step('fetch')] });
      expect(tabNames()).toEqual(['Step', 'Processor']);
      expect(childNames('Step')).toEqual(['hourly', 'daily']);
      expect(selectedChild('Step')).toBeNull();
      expect([...document.querySelectorAll('.ins-subtab .dot')].map((d) => (d as HTMLElement).style.background)).toEqual(['rgb(255, 0, 114)', 'rgb(124, 58, 237)']);
      openTab('daily');
      expect(screen.getByText('assignment · belongs to daily')).toBeInTheDocument();
      openTab('hourly');
      expect(screen.getByText('assignment · belongs to hourly')).toBeInTheDocument();
      // one of them off the step's stream: the whole selection is the list
      rerender({ workflows: ['hourly', 'daily'], picks: [wfP('hourly'), wfP('daily'), step('lonely')] });
      expect(tabNames()).toEqual([]);
      expect(screen.getByText('3 selected')).toBeInTheDocument();
    });
    it('a child shows its assignment; the parent tab again shows its own fields', () => {
      setup({ workflows: ['daily'], picks: [wfP('daily'), step('fetch')] });
      openTab('daily');
      expect(selectedTab()).toBe('Step');
      expect(selectedChild('Step')).toBe('daily');
      expect(screen.getByText('assignment · belongs to daily')).toBeInTheDocument();
      openTab('Step');
      expect(selectedChild('Step')).toBeNull();
      expect(screen.getByLabelText('Name')).toHaveValue('fetch-orders');
    });
    it('each parent keeps its own child while the pick stays: Step child, Processor, back to Step', () => {
      const b0 = board();
      const slots = { ...b0, processors: { p1: { ...b0.processors.p1!, configSchemaId: 's-cfg' } },
        schemas: { 's-cfg': { id: 's-cfg', name: 'cfg', version: '1.0.0', description: null, definition: '{}', audit: { createdAt: '', createdBy: null, updatedAt: '', updatedBy: null }, at: null, updatedAt: null } } };
      const { rerender } = setup({ workflows: ['daily'], picks: [wfP('daily'), step('fetch')] }, slots);
      openTab('daily');
      openTab('Processor');
      expect(selectedChild('Processor')).toBeNull();
      openTab('Config schema');
      openTab('Step');
      expect(selectedChild('Step')).toBe('daily');
      expect(screen.getByText('assignment · belongs to daily')).toBeInTheDocument();
      openTab('Processor');
      expect(selectedChild('Processor')).toBe('Config schema');
      // the shown parent clicked again: its own fields; Step keeps its child
      openTab('Processor');
      expect(selectedChild('Processor')).toBeNull();
      openTab('Step');
      expect(selectedChild('Step')).toBe('daily');
      // a new pick forgets them
      rerender({ workflows: ['daily'], picks: [wfP('daily'), step('expand')] });
      rerender({ workflows: ['daily'], picks: [wfP('daily'), step('fetch')] });
      expect(selectedChild('Step')).toBeNull();
    });
    it('the chosen tab is kept while the same step stays picked; a child whose workflow is replaced is gone', () => {
      const { rerender } = setup({ workflows: ['daily'], picks: [wfP('daily'), step('fetch')] });
      expect(selectedTab()).toBe('Step');
      openTab('daily');
      expect(selectedChild('Step')).toBe('daily');
      rerender({ workflows: ['hourly'], picks: [step('fetch'), wfP('hourly')] }); // triangle replaced, step stays
      expect(selectedTab()).toBe('Step');
      expect(childNames('Step')).toEqual(['hourly']);
      expect(selectedChild('Step')).toBeNull();
      openTab('Processor');
      rerender({ workflows: [], picks: [step('fetch')] });
      expect(selectedTab()).toBe('Processor');
      rerender({ workflows: [], picks: [step('expand')] });
      expect(selectedTab()).toBe('Step');
    });
    it("Processor's children are its schemas; none chosen at first; the chosen one kept while the pick stays and it exists", () => {
      const b0 = board();
      const slots = { ...b0, processors: { p1: { ...b0.processors.p1!, configSchemaId: 's-cfg' } },
        schemas: { 's-cfg': { id: 's-cfg', name: 'cfg', version: '1.0.0', description: null, definition: '{}', audit: { createdAt: '', createdBy: null, updatedAt: '', updatedBy: null }, at: null, updatedAt: null } } };
      const { store, rerender } = setup({ workflows: [], picks: [step('fetch')] }, slots);
      openTab('Processor');
      expect(childNames('Processor')).toEqual(['Config schema']);
      expect(selectedChild('Processor')).toBeNull();
      openTab('Config schema');
      expect(selectedChild('Processor')).toBe('Config schema');
      expect(screen.getByText('schema · config of proc')).toBeInTheDocument();
      rerender({ workflows: ['daily'], picks: [wfP('daily'), step('fetch')] });
      expect(selectedChild('Processor')).toBe('Config schema');
      // the slot emptied: no child row, the processor's own fields
      act(() => store.edit((b) => ({ ...b, processors: { p1: { ...b.processors.p1!, configSchemaId: null } } })));
      expect(screen.queryByRole('tablist', { name: 'Processor tabs' })).toBeNull();
      expect(screen.getByLabelText('Source hash')).toBeInTheDocument();
      act(() => store.undo());
      expect(selectedChild('Processor')).toBe('Config schema');
      // a new pick: Step, no child
      rerender({ workflows: [], picks: [step('expand')] });
      expect(selectedTab()).toBe('Step');
      openTab('Processor');
      expect(selectedChild('Processor')).toBeNull();
    });
    it('a step picked again after another pick opens on its first tab: step → triangle → the same step', () => {
      const { rerender } = setup({ workflows: [], picks: [step('fetch')] });
      openTab('Processor');
      expect(selectedTab()).toBe('Processor');
      rerender({ workflows: ['daily'], picks: [wfP('daily')] });
      expect(selectedTab()).toBe('Workflow');
      rerender({ workflows: [], picks: [step('fetch')] });
      expect(selectedTab()).toBe('Step');
    });
    it('exactly one triangle: its Workflow tab', () => {
      setup({ workflows: ['hourly'], picks: [wfP('hourly')] });
      expect(tabNames()).toEqual(['Workflow']);
      expect(screen.getByLabelText('Name')).toHaveValue('hourly');
    });
    it('anything else: the numbered pick list of everything selected, triangles included', () => {
      const { rerender } = setup({ workflows: ['daily', 'hourly'], picks: [wfP('daily'), wfP('hourly')] });
      expect(tabNames()).toEqual([]);
      expect(screen.queryByLabelText('Name')).toBeNull();
      expect([...document.querySelectorAll('.in-picks li')].map((l) => l.textContent)).toEqual(['daily', 'hourly']);
      expect(screen.getByText('2 selected')).toBeInTheDocument();
      rerender({ workflows: [], picks: [step('fetch'), step('expand')] });
      expect([...document.querySelectorAll('.in-picks li')].map((l) => l.textContent)).toEqual(['fetch-orders', 'expand']);
      rerender({ workflows: ['daily'], picks: [wfP('daily'), step('fetch'), { kind: 'cache', id: 'c1' }] });
      expect([...document.querySelectorAll('.in-picks li')].map((l) => l.getAttribute('data-kind'))).toEqual(['workflow', 'step', 'cache']);
      expect(screen.getByText('3 selected')).toBeInTheDocument();
      rerender({ workflows: ['daily', 'hourly'], picks: [wfP('daily'), wfP('hourly'), step('lonely')] });
      expect(tabNames()).toEqual([]);
      expect(screen.getByText('3 selected')).toBeInTheDocument();
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
    /** board() with p1 holding a config schema: a required string, a required integer, an optional with a default, an optional boolean. */
    const withConfig = (definition: string | null): BoardState => {
      const b0 = board();
      return { ...b0, processors: { p1: { ...b0.processors.p1!, configSchemaId: 's-cfg' } },
        schemas: { 's-cfg': { id: 's-cfg', name: 'cfg', version: '1.0.0', description: null, definition, audit: { createdAt: '', createdBy: null, updatedAt: '', updatedBy: null }, at: null, updatedAt: null } } };
    };
    const KAFKA = JSON.stringify({ type: 'object', required: ['topic', 'partitions'], properties: {
      topic: { type: 'string' }, partitions: { type: 'integer' }, acks: { type: 'string', default: 'all' }, compress: { type: 'boolean' } } });
    it("＋ Create lays the new assignment's payload out from the config schema, as Studio; the check names the placeholders [user, 2026-11-19]", () => {
      const { store } = opened({ workflows: ['daily'], picks: [step('expand')] }, withConfig(KAFKA));
      expect(screen.getByText(/No assignment yet for daily/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: '＋ Create' }));
      const want = { topic: '<string>', partitions: '<integer>', acks: 'all', compress: false };
      const made = store.state().assignments[store.state().workflows.daily!.assignmentIds.at(-1)!]!;
      expect(made.stepId).toBe('expand');
      expect(JSON.parse(made.payload)).toEqual(want);
      expect(screen.getByLabelText('Payload')).toHaveValue(JSON.stringify(want, null, 2));
      expect(screen.queryByRole('button', { name: '＋ Create' })).toBeNull();
      expect(screen.getByText('/topic: still a placeholder: fill in a string')).toBeInTheDocument();
      expect(screen.getByText('/partitions: still a placeholder: fill in an integer')).toBeInTheDocument();
      expect(store.state().workflows.hourly!.assignmentIds).toEqual(['a-hourly-fetch']);
      act(() => store.undo());
      expect(store.state().workflows.daily!.assignmentIds).toEqual(['a-daily-fetch']);
    });
    it("a processor with no config schema: a warning before and after ＋ Create, which makes {} [user, 2026-11-19]", () => {
      const { store } = opened({ workflows: ['daily'], picks: [step('expand')] }, withConfig(null));
      const off = { ...store.state(), processors: { p1: { ...store.state().processors.p1!, configSchemaId: null } } };
      cleanup();
      const r = opened({ workflows: ['daily'], picks: [step('expand')] }, off);
      const warning = "proc has no config schema, so this payload can't be laid out or checked";
      expect(document.querySelector('.in-noschema')?.textContent).toContain(warning);
      fireEvent.click(screen.getByRole('button', { name: '＋ Create' }));
      expect(screen.getByLabelText('Payload')).toHaveValue('{}');
      expect(document.querySelector('.in-noschema')?.textContent).toContain('Point a config schema to the processor');
      expect(r.store.unsaved().size).toBeGreaterThan(0);
    });
    it('no warning when the processor has a config schema, or the step has no processor', () => {
      opened({ workflows: ['daily'], picks: [step('expand')] }, withConfig(KAFKA));
      expect(document.querySelector('.in-noschema')).toBeNull();
      cleanup();
      const b0 = board();
      opened({ workflows: ['daily'], picks: [step('expand')] }, { ...b0, steps: { ...b0.steps, expand: { ...b0.steps.expand!, processorId: null } } });
      expect(document.querySelector('.in-noschema')).toBeNull();
    });
    it('＋ Create with no config schema (or one without properties) makes {}', () => {
      for (const def of [null, '{"type":"object"}']) {
        const { store } = opened({ workflows: ['daily'], picks: [step('expand')] }, withConfig(def));
        fireEvent.click(screen.getByRole('button', { name: '＋ Create' }));
        expect(store.state().assignments[store.state().workflows.daily!.assignmentIds.at(-1)!]!.payload).toBe('{}');
        cleanup();
      }
    });
    it('shows the payload of its own workflow, pretty, on the same step', () => {
      const { store, rerender } = setup({ workflows: ['daily'], picks: [step('fetch')] });
      act(() => store.edit((b) => setPayload(b, 'hourly', 'fetch', '{"every":"hour"}', () => 'x')));
      act(() => store.edit((b) => setPayload(b, 'daily', 'fetch', '{"every":"day"}', () => 'y')));
      openTab('daily');
      expect(screen.getByText('assignment · belongs to daily')).toBeInTheDocument();
      expect(screen.getByLabelText('Payload')).toHaveValue('{\n  "every": "day"\n}');
      rerender({ workflows: ['hourly'], picks: [step('fetch')] }); // the other triangle with the step: its assignment
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
    it('Remove assignment unlinks it from that workflow only; the Payload editor goes and ＋ Create comes back, as in Studio [user, 2026-11-19]', () => {
      const { store } = opened({ workflows: ['daily'], picks: [step('fetch')] });
      fireEvent.click(screen.getByRole('button', { name: 'Remove assignment' }));
      expect(store.state().workflows.daily!.assignmentIds).toEqual([]);
      expect(store.state().workflows.hourly!.assignmentIds).toEqual(['a-hourly-fetch']);
      expect(screen.queryByRole('button', { name: 'Remove assignment' })).toBeNull();
      expect(screen.queryByLabelText('Payload')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: '＋ Create' }));
      expect(payloadOf(store, 'daily')).toBe('{}');
      expect(screen.getByLabelText('Payload')).toHaveValue('{}');
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
    it('edits name', () => {
      const { store } = setup(sel);
      fireEvent.change(screen.getByDisplayValue('daily'), { target: { value: 'nightly' } });
      expect(store.state().workflows.daily!.name).toBe('nightly');
    });
    it('lists entry steps and caches, each with Remove', () => {
      const { store } = setup(sel);
      fireEvent.click(screen.getByRole('button', { name: 'Remove entry fetch-orders' }));
      expect(store.state().workflows.daily!.entryStepIds).toEqual([]);
      fireEvent.click(screen.getByRole('button', { name: 'Remove cache c1' }));
      expect(store.state().workflows.daily!.cacheIds).toEqual([]);
    });
    it('lists every assignment read-only, including one on a step it does not reach: no Delete, no payload textbox, its keys shown', () => {
      const { store } = setup(sel);
      act(() => store.edit((b) => setPayload(b, 'daily', 'lonely', '{"x":1,"y":2}', () => 'new-a')));
      const list = screen.getByTestId('assignments');
      expect(screen.getByText('Assignments')).toBeInTheDocument();
      expect(list.querySelectorAll('.in-assign')).toHaveLength(2);
      expect(within(list).queryByRole('button', { name: 'Delete' })).toBeNull();
      expect(within(list).queryByRole('textbox')).toBeNull();
      expect(within(list).getByText('fetch-orders').nextSibling).toHaveTextContent('◆ 0 keys');
      expect(within(list).getByText('lonely').nextSibling).toHaveTextContent('◆ 2 keys · not in its stream');
      expect(screen.queryByText('Payload keys in its stream')).toBeNull();
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

  it('a cache shows its fields, its items as a table and who uses it', () => {
    const b0 = board();
    const { store } = setup({ workflows: [], picks: [{ kind: 'cache', id: 'c1' }] }, { ...b0, caches: { c1: { ...b0.caches.c1!, items: '{"k":"v"}' } } });
    expect(screen.getByRole('tab', { name: 'Cache' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Root'), { target: { value: 'new-root' } });
    expect(store.state().caches.c1!.root).toBe('new-root');
    expect(screen.getByRole('textbox', { name: 'Key 1' })).toHaveValue('k');
    expect(screen.getByRole('textbox', { name: 'Value 1' })).toHaveValue('v');
    fireEvent.click(screen.getByRole('button', { name: 'JSON' }));
    const json = screen.getByRole('textbox', { name: 'Items as JSON' });
    expect(json).toHaveValue('{\n  "k": "v"\n}');
    fireEvent.change(json, { target: { value: '{"k" :"v"}' } });
    fireEvent.blur(json);
    expect(store.state().caches.c1!.items).toBe('{"k":"v"}'); // the same JSON: no edit
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
    rerender({ workflows: [], picks: [{ kind: 'entry', workflowId: 'daily', stepId: 'fetch' }] });
    expect(screen.getByText('From').nextSibling).toHaveTextContent('daily');
    expect(screen.getByText('To').nextSibling).toHaveTextContent('fetch-orders');
    rerender({ workflows: [], picks: [{ kind: 'cacheLink', workflowId: 'daily', cacheId: 'c1' }] });
    expect(screen.getByText('To').nextSibling).toHaveTextContent('c1');
  });

  it('several picks are listed, in pick order', () => {
    setup({ workflows: [], picks: [step('expand'), { kind: 'cache', id: 'c1' }, { kind: 'wire', from: 'fetch', to: 'expand' }] });
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

  describe('links [user, 2026-11-19]', () => {
    it("the Step tab lists the step's wires out; ✕ removes that wire only, in one undo step", () => {
      const { store } = setup({ workflows: [], picks: [step('fetch')] });
      expect(screen.getByRole('button', { name: 'Remove wire to expand' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Remove wire to expand' }));
      expect(store.state().steps.fetch!.nextStepIds).toEqual([]);
      expect(store.state().workflows.daily!.entryStepIds).toEqual(['fetch']);
      act(() => store.undo());
      expect(store.state().steps.fetch!.nextStepIds).toEqual(['expand']);
    });
    it('a step with no wires out says none', () => {
      setup({ workflows: [], picks: [step('expand')] });
      expect(screen.queryByRole('button', { name: /Remove wire to/ })).toBeNull();
    });
    /** The Inspector that moves its own selection, as App does; `picked` is the last selection it asked for. */
    function hosted(first: Pick[]) {
      const store = createBoardStore(createOutputStore(null, () => '00:00:00'), null);
      store.load(board());
      const ghosts = createGhostStore(store);
      const out = { store, picked: [] as Pick[], centred: [] as unknown[] };
      function Host() {
        const [sel, setSel] = useState<Sel>({ workflows: [], picks: first });
        return <InspectorPanel store={store} selection={sel} ghosts={ghosts} onPicks={(p) => { out.picked = p; setSel({ workflows: [], picks: p }); }}
          onCenter={(r) => out.centred.push(r)} />;
      }
      render(<LiveStoreProvider value={liveStub()}><Host /></LiveStoreProvider>);
      return out;
    }
    const daily: Pick = { kind: 'workflow', id: 'daily' };
    const inList = () => within(screen.getByTestId('assignments'));
    it("an assignment chip selects that workflow with the step and opens Step › the workflow's assignment", () => {
      const h = hosted([daily]);
      expect(tabNames()).toEqual(['Workflow']);
      fireEvent.click(inList().getByRole('button', { name: 'Open assignment fetch-orders' }));
      expect(h.picked).toEqual([daily, step('fetch')]);
      expect(selectedTab()).toBe('Step');
      expect(selectedChild('Step')).toBe('daily');
      expect(screen.getByLabelText('Payload')).toBeInTheDocument();
    });
    it('an assignment chip has no ✕: it is not a connection (Step › workflow removes it)', () => {
      const h = hosted([daily]);
      expect(inList().queryByRole('button', { name: /Remove assignment/ })).toBeNull();
      expect(inList().getAllByRole('button')).toHaveLength(1);
      expect(h.store.state().workflows.daily!.assignmentIds).toEqual(['a-daily-fetch']);
    });
    it('a chip link centres the step (or the cache) it opens on the board [user, 2026-11-19]', () => {
      const h = hosted([daily]);
      fireEvent.click(screen.getByRole('button', { name: 'Open entry fetch-orders' }));
      fireEvent.click(screen.getByRole('button', { name: 'Open step expand' }));
      expect(h.centred).toEqual([{ kind: 'step', id: 'fetch' }, { kind: 'step', id: 'expand' }]);
    });
    it('a cache chip centres the cache', () => {
      const h = hosted([daily]);
      fireEvent.click(screen.getByRole('button', { name: 'Open cache c1' }));
      expect(h.centred).toEqual([{ kind: 'cache', id: 'c1' }]);
    });
    it('an entry-step chip selects that workflow with the step and opens Step with no child chosen', () => {
      const h = hosted([daily]);
      fireEvent.click(screen.getByRole('button', { name: 'Open entry fetch-orders' }));
      expect(h.picked).toEqual([daily, step('fetch')]);
      expect(selectedTab()).toBe('Step');
      expect(selectedChild('Step')).toBeNull();
      expect(childNames('Step')).toEqual(['daily']);
    });
    it('a cache chip selects the cache alone and opens its tab', () => {
      const h = hosted([daily]);
      fireEvent.click(screen.getByRole('button', { name: 'Open cache c1' }));
      expect(h.picked).toEqual([{ kind: 'cache', id: 'c1' }]);
      expect(tabNames()).toEqual(['Cache']);
    });
    it('a next-step chip picks that step as a plain click would: the workflow stays, the step is replaced', () => {
      const h = hosted([daily, step('fetch')]);
      fireEvent.click(screen.getByRole('button', { name: 'Open step expand' }));
      expect(h.picked).toEqual([daily, step('expand')]);
      expect(selectedTab()).toBe('Step');
      expect(screen.getByLabelText('Name')).toHaveValue('expand');
    });
  });
});

describe('InspectorPanel Undo and Redo lock', () => {
  it('Undo and Redo are disabled while a schema is the focus even when the board can undo; enabled again for a step', () => {
    const b = withSchemas();
    const { store, rerender } = setup({ workflows: [], picks: [step('fetch')] }, b);
    act(() => { store.edit((s) => ({ ...s, steps: { ...s.steps, fetch: { ...s.steps.fetch!, name: 'renamed' } } })); });
    expect(store.canUndo()).toBe(true);
    const undo = () => screen.getByRole('button', { name: 'Undo' });
    expect(undo()).toBeEnabled();
    rerender({ workflows: [], picks: [{ kind: 'schema', id: 's-cfg' }] });
    expect(undo()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled();
    expect(screen.getByRole('tab', { name: 'Schema' })).toBeInTheDocument();
    rerender({ workflows: [], picks: [{ kind: 'processor', id: 'p1' }] });
    expect(undo()).toBeDisabled();
    rerender({ workflows: [], picks: [step('fetch')] });
    expect(undo()).toBeEnabled();
  });
});

describe('InspectorPanel processor card', () => {
  it('a stepless processor shows its slot schemas as read-only child tabs', () => {
    setup({ workflows: [], picks: [{ kind: 'processor', id: 'p1' }] }, withSchemas());
    expect(childNames('Processor')).toEqual(['Input schema', 'Config schema']);
    fireEvent.click(rowTabs('Processor tabs').find((t) => t.textContent === 'Config schema')!);
    expect(screen.getByLabelText('Name')).toBeDisabled();
    expect(screen.getByLabelText('Definition')).toBeDisabled();
  });
});
