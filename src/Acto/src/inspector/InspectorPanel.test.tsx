import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Pick } from '../board/selection';
import { createBoardStore, type BoardStore } from '../design/boardStore';
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
  const ui = (sel: Sel) => <LiveStoreProvider value={liveStub()}><InspectorPanel store={store} selection={sel} /></LiveStoreProvider>;
  const view = render(ui(selection));
  return { store, rerender: (sel: Sel) => view.rerender(ui(sel)) };
}
const step = (id: string): Pick => ({ kind: 'step', id });
const payloadOf = (s: BoardStore, wf: string) => s.state().assignments[s.state().workflows[wf]!.assignmentIds[0]!]!.payload;

describe('InspectorPanel', () => {
  it('summarises the board when nothing is selected', () => {
    setup({ workflows: [], picks: [] });
    expect(screen.getByText(/Select a workflow/)).toBeInTheDocument();
    expect(screen.getByText(/2 workflows/)).toBeInTheDocument();
  });

  describe('step', () => {
    it('shows the payload of the selected workflow, daily then hourly, on the same step', () => {
      const { store, rerender } = setup({ workflows: ['daily'], picks: [step('fetch')] });
      act(() => store.edit((b) => setPayload(b, 'hourly', 'fetch', '{"every":"hour"}', () => 'x')));
      act(() => store.edit((b) => setPayload(b, 'daily', 'fetch', '{"every":"day"}', () => 'y')));
      expect(screen.getByText('Payload · daily')).toBeInTheDocument();
      expect(screen.getByLabelText('Payload · JSON')).toHaveValue('{"every":"day"}');
      rerender({ workflows: ['hourly'], picks: [step('fetch')] });
      expect(screen.getByText('Payload · hourly')).toBeInTheDocument();
      expect(screen.getByLabelText('Payload · JSON')).toHaveValue('{"every":"hour"}');
    });
    it('editing the payload changes the selected workflow only, one undo step while typing', () => {
      const { store } = setup({ workflows: ['daily'], picks: [step('fetch')] });
      const area = screen.getByLabelText('Payload · JSON');
      fireEvent.change(area, { target: { value: '{"a"' } });
      fireEvent.change(area, { target: { value: '{"a":1}' } });
      expect(payloadOf(store, 'daily')).toBe('{"a":1}');
      expect(payloadOf(store, 'hourly')).toBe('{}');
      store.undo();
      expect(payloadOf(store, 'daily')).toBe('{}');
    });
    it('with no workflow selected there is no payload field, only the shared fields', () => {
      setup({ workflows: [], picks: [step('fetch')] });
      expect(screen.queryByText(/Payload ·/)).toBeNull();
      expect(screen.queryByLabelText('Payload · JSON')).toBeNull();
      expect(screen.getByDisplayValue('fetch-orders')).toBeInTheDocument();
      expect(screen.getByText(/shared/)).toBeInTheDocument();
    });
    it('a step the workflow does not reach says so and has no payload field', () => {
      setup({ workflows: ['daily'], picks: [step('lonely')] });
      expect(screen.getByText('not in daily')).toBeInTheDocument();
      expect(screen.queryByLabelText('Payload · JSON')).toBeNull();
    });
    it('a shared field edit goes to the step', () => {
      const { store } = setup({ workflows: ['daily'], picks: [step('fetch')] });
      fireEvent.change(screen.getByDisplayValue('fetch-orders'), { target: { value: 'renamed' } });
      expect(store.state().steps.fetch!.name).toBe('renamed');
    });
    it('the JSON check shows under the payload', () => {
      const { store } = setup({ workflows: ['daily'], picks: [step('fetch')] });
      fireEvent.change(screen.getByLabelText('Payload · JSON'), { target: { value: '{oops' } });
      expect(document.querySelector('.in-problem')).not.toBeNull();
      expect(store.state().assignments['a-daily-fetch']!.payload).toBe('{oops');
    });
    it('Remove assignment unlinks it from the selected workflow only', () => {
      const { store } = setup({ workflows: ['daily'], picks: [step('fetch')] });
      fireEvent.click(screen.getByRole('button', { name: 'Remove assignment' }));
      expect(store.state().workflows.daily!.assignmentIds).toEqual([]);
      expect(store.state().workflows.hourly!.assignmentIds).toEqual(['a-hourly-fetch']);
    });
    it('a payload on a row both workflows link is copied for the selected one', () => {
      const { store } = setup({ workflows: ['daily'], picks: [step('fetch')] }, shared());
      fireEvent.change(screen.getByLabelText('Payload · JSON'), { target: { value: '{"d":1}' } });
      const s = store.state();
      expect(s.assignments['a-shared']!.payload).toBe('{"shared":true}');
      expect(s.workflows.hourly!.assignmentIds).toEqual(['a-shared']);
      expect(s.assignments[s.workflows.daily!.assignmentIds[0]!]!.payload).toBe('{"d":1}');
    });
    it('shows the processor section', () => {
      setup({ workflows: [], picks: [step('fetch')] });
      expect(screen.getByDisplayValue('proc')).toBeInTheDocument();
    });
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
      fireEvent.change(within(list).getByDisplayValue('{"x":1}'), { target: { value: '{"x":2}' } });
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
      fireEvent.change(within(screen.getByTestId('assignments')).getByDisplayValue('{"second":1}'), { target: { value: '{"second":2}' } });
      expect(store.state().assignments.a2!.payload).toBe('{"second":2}');
      expect(store.state().assignments['a-daily-fetch']!.payload).toBe('{}');
    });
    it('a list edit of a row another workflow links copies it for this one', () => {
      const { store } = setup(sel, shared());
      fireEvent.change(within(screen.getByTestId('assignments')).getByDisplayValue('{"shared":true}'), { target: { value: '{"d":1}' } });
      const s = store.state();
      expect(s.assignments['a-shared']!.payload).toBe('{"shared":true}');
      expect(s.workflows.hourly!.assignmentIds).toEqual(['a-shared']);
      expect(s.assignments[s.workflows.daily!.assignmentIds[0]!]!.payload).toBe('{"d":1}');
    });
    it('typing into a shared payload in the list keeps the same focused textarea and is one undo step', () => {
      const { store } = setup(sel, shared());
      const list = screen.getByTestId('assignments');
      const area = within(list).getByDisplayValue('{"shared":true}');
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
    it('shows the location', () => {
      setup(sel);
      expect(screen.getByText('Location').nextSibling).toHaveTextContent('0, 0');
    });
  });

  it('a cache shows its fields', () => {
    const { store } = setup({ workflows: [], picks: [{ kind: 'cache', id: 'c1' }] });
    fireEvent.change(screen.getByLabelText('Root'), { target: { value: 'new-root' } });
    expect(store.state().caches.c1!.root).toBe('new-root');
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
