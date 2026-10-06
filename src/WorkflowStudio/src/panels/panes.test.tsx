import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { graphDto, processorDto, stepDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { createStudioStore, StudioStoreProvider, type StudioStore } from '../store/studioStore';
import { Inspector } from './Inspector';
import { Output, Toolbox } from './PaneNote';
import { Problems } from './Problems';

const graph = graphDto({
  steps: [stepDto('s1', { name: 'fetch', nextStepIds: ['s2'], processorId: 'p1' }), stepDto('s2', { name: 'store', processorId: 'p1' })],
  processors: [processorDto('p1', { name: 'fetcher' })],
} as never);

async function storeWith(problems: Parameters<typeof loadedDocument>[1] = []): Promise<StudioStore> {
  const store = createStudioStore();
  store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
  store.dispatch({ type: 'loaded', workflowId: 'wf1', doc: await loadedDocument(graph, problems) });
  return store;
}
const wrap = (store: StudioStore, ui: ReactNode) => render(<StudioStoreProvider value={store}>{ui}</StudioStoreProvider>);

describe('Inspector', () => {
  it('asks for a workflow, then for a selection', async () => {
    const empty = createStudioStore();
    const { unmount } = wrap(empty, <Inspector />);
    expect(screen.getByText('Open a workflow to inspect it.')).toBeInTheDocument();
    unmount();

    wrap(await storeWith(), <Inspector />);
    expect(screen.getByText(/Nothing selected/)).toBeInTheDocument();
  });

  it('fills when something is selected, and keeps one show-all switch across entities', async () => {
    const store = await storeWith();
    wrap(store, <Inspector />);
    act(() => store.dispatch({ type: 'select', workflowId: 'wf1', selection: { kind: 'step', stepId: 's1' } }));
    expect(screen.getByText('STEP')).toBeInTheDocument();
    expect(screen.getByLabelText('Unique name')).toHaveTextContent('fetch_1.0.0-s1');
    expect(screen.queryByText('Created at')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '▸ show all' }));
    expect(screen.getByText('Created at')).toBeInTheDocument();

    act(() => store.dispatch({ type: 'select', workflowId: 'wf1', selection: { kind: 'workflow' } }));
    expect(screen.getByText('WORKFLOW')).toBeInTheDocument();
    expect(screen.getByText('Created at')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '▾ hide details' })).toBeInTheDocument();
  });

  it('marks every read-only value so its full text shows when it is cut', async () => {
    const store = await storeWith();
    store.dispatch({ type: 'select', workflowId: 'wf1', selection: { kind: 'processor', processorId: 'p1', stepId: 's1' } });
    const { container } = wrap(store, <Inspector />);
    const values = [...container.querySelectorAll('.ro, .slot .v')];
    expect(values.length).toBeGreaterThan(5);
    for (const v of values) expect(v.getAttribute('data-tipcut')).toBe(v.textContent);
  });
});

describe('Problems', () => {
  it('says when validate failed, and when there are none', async () => {
    const { unmount } = wrap(await storeWith(null), <Problems />);
    expect(screen.getByText('Problems unavailable.')).toBeInTheDocument();
    unmount();
    wrap(await storeWith([]), <Problems />);
    expect(screen.getByText('No problems')).toBeInTheDocument();
  });

  it('lists gate, title and detail, and selects what a problem names when clicked', async () => {
    const store = await storeWith([
      { gate: 'schemaEdge', title: 'Schema-edge mismatch between steps', detail: "on edge 's1' -> 's2'", offending: { parentStepId: 's1', childStepId: 's2' } },
      { gate: 'somethingNew', title: 'A gate this studio does not know', detail: 'd', offending: 42 },
    ]);
    wrap(store, <Problems />);
    const [named, unnamed] = screen.getAllByRole('listitem');
    expect(named).toHaveTextContent('schemaEdgeSchema-edge mismatch between steps');

    fireEvent.click(unnamed!);
    expect(store.getState().docs[0]!.selection).toBeNull();
    fireEvent.click(named!);
    expect(store.getState().docs[0]!.selection).toEqual({ kind: 'step', stepId: 's2' });
  });

  it('selects a problem from the keyboard: it is focusable and Enter selects its target', async () => {
    const store = await storeWith([
      { gate: 'schemaEdge', title: 'Schema-edge mismatch between steps', detail: "on edge 's1' -> 's2'", offending: { parentStepId: 's1', childStepId: 's2' } },
      { gate: 'somethingNew', title: 'A gate this studio does not know', detail: 'd', offending: 42 },
    ]);
    wrap(store, <Problems />);
    const [named, unnamed] = screen.getAllByRole('listitem');
    expect(named).toHaveAttribute('tabindex', '0');
    expect(unnamed).not.toHaveAttribute('tabindex');

    fireEvent.keyDown(named!, { key: 'Enter' });
    expect(store.getState().docs[0]!.selection).toEqual({ kind: 'step', stepId: 's2' });
  });
});

describe('Output and Toolbox', () => {
  it('are real panes with one line each', () => {
    render(<><Output /><Toolbox /></>);
    expect(screen.getByText('Output will show save and orchestration messages in a later version.')).toBeInTheDocument();
    expect(screen.getByText('The toolbox arrives in a later version.')).toBeInTheDocument();
  });
});
