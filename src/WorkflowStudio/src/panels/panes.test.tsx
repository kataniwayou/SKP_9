import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { assignmentDto, cacheDto, graphDto, processorDto, schemaDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { createStudioStore, StudioStoreProvider, type StudioStore } from '../store/studioStore';
import { inspectorGraph, renderInspector } from '../test/inspector';
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

const ok = <T,>(value: T) => ({ ok: true, value }) as const;

describe('Inspector', () => {
  it('asks for a workflow, then for a selection', async () => {
    const { store } = await renderInspector({}, { selection: { kind: 'step', stepId: 's1' } });
    act(() => store.dispatch({ type: 'select', workflowId: 'wf1', selection: null }));
    expect(screen.getByText(/Nothing selected/)).toBeInTheDocument();

    act(() => store.dispatch({ type: 'close', workflowId: 'wf1' }));
    expect(screen.getByText('Open a workflow to inspect it.')).toBeInTheDocument();
  });

  it('fills when something is selected, and keeps one show-all switch across entities', async () => {
    const getEntity = vi.fn(async (kind: string) => ok(kind === 'step' ? stepDto('s1', { name: 'fetch' }) : workflowDto()));
    const { store } = await renderInspector({ getEntity }, { selection: { kind: 'step', stepId: 's1' } });
    expect(screen.getByText('STEP')).toBeInTheDocument();
    expect(await screen.findByLabelText('Unique name')).toHaveTextContent('fetch_1.0.0-s1');
    expect(screen.queryByText('Created at')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '▸ show all' }));
    expect(screen.getByText('Created at')).toBeInTheDocument();

    act(() => store.dispatch({ type: 'select', workflowId: 'wf1', selection: { kind: 'workflow' } }));
    expect(screen.getByText('WORKFLOW')).toBeInTheDocument();
    expect(await screen.findByText('Created at')).toBeInTheDocument();
    expect(screen.getByLabelText('Unique name')).toHaveTextContent('orders_1.0.0-wf1');
    expect(screen.getByRole('button', { name: '▾ hide details' })).toBeInTheDocument();
  });

  it('marks every read-only value so its full text shows when it is cut', async () => {
    const { container } = await renderInspector({ getEntity: vi.fn().mockResolvedValue(ok(processorDto('p1', { name: 'fetcher', configSchemaId: 'sc1' }))) },
      { selection: { kind: 'processor', processorId: 'p1', stepId: 's1' } });
    fireEvent.click(await screen.findByRole('button', { name: '▸ show all' }));
    const values = [...container.querySelectorAll('.ro, .slot .v')];
    expect(values.length).toBeGreaterThan(5);
    for (const v of values) expect(v.getAttribute('data-tipcut')).toBe(v.textContent);
  });
});

describe('Inspector editing (slice 3b)', () => {
  const step = stepDto('s1', { name: 'fetch', nextStepIds: ['s2'], processorId: 'p1', description: null });

  it('reads the selected step and shows its writable fields filled in', async () => {
    const { api } = await renderInspector({ getEntity: vi.fn().mockResolvedValue(ok(step)) }, { selection: { kind: 'step', stepId: 's1' } });
    expect(await screen.findByLabelText('Name')).toHaveValue('fetch');
    expect(screen.getByLabelText('Version')).toHaveValue('1.0.0');
    expect(screen.getByLabelText('Entry condition')).toHaveAttribute('data-value', '1');
    expect(api.getEntity).toHaveBeenCalledWith('step', 's1');
  });

  it('marks an edit unsaved, saves it, and takes what the server read back', async () => {
    const putEntity = vi.fn().mockResolvedValue(ok({ ...step, description: 'now' }));
    const { afterWrite } = await renderInspector({ getEntity: vi.fn().mockResolvedValue(ok(step)), putEntity }, { selection: { kind: 'step', stepId: 's1' } });
    fireEvent.change(await screen.findByLabelText('Description'), { target: { value: 'now' } });
    expect(screen.getByText('● unsaved changes')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putEntity).toHaveBeenCalledWith('step', 's1', expect.objectContaining({ description: 'now', nextStepIds: ['s2'] })));
    await waitFor(() => expect(screen.queryByText('● unsaved changes')).toBeNull());
    expect(screen.getByLabelText('Description')).toHaveValue('now');
    expect(afterWrite).toHaveBeenCalled();
  });

  it('Revert drops the edits; Save and Revert are disabled with nothing to save', async () => {
    await renderInspector({ getEntity: vi.fn().mockResolvedValue(ok(step)) }, { selection: { kind: 'step', stepId: 's1' } });
    const save = await screen.findByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.keyDown(screen.getByLabelText('Entry condition'), { key: 'a' });
    expect(save).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    expect(screen.getByLabelText('Entry condition')).toHaveAttribute('data-value', '1');
    expect(save).toBeDisabled();
  });

  it('disables Save while Name is empty, showing the saved name as the placeholder', async () => {
    await renderInspector({ getEntity: vi.fn().mockResolvedValue(ok(step)) }, { selection: { kind: 'step', stepId: 's1' } });
    const name = await screen.findByLabelText('Name');
    fireEvent.change(name, { target: { value: '' } });
    expect(name).toHaveAttribute('placeholder', 'fetch');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('marks invalid JSON while typing and still lets the server judge it', async () => {
    await renderInspector({ getEntity: vi.fn().mockResolvedValue(ok(cacheDto('c1'))) }, { selection: { kind: 'cache', cacheId: 'c1' } });
    fireEvent.change(await screen.findByLabelText('Items'), { target: { value: '{"a":' } });
    expect(screen.getByText('Not valid JSON')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('shows a 400 under its field and a 409 in a banner, keeping what was typed', async () => {
    const putEntity = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { kind: 'badRequest', status: 400, detail: 'Validation failed', errors: { Version: ['Version must be x.y.z.'] } } })
      .mockResolvedValueOnce({ ok: false, error: { kind: 'conflict', status: 409, detail: 'Unique constraint violation: root already exists.', entity: null } });
    await renderInspector({ getEntity: vi.fn().mockResolvedValue(ok(cacheDto('c1'))), putEntity }, { selection: { kind: 'cache', cacheId: 'c1' } });
    fireEvent.change(await screen.findByLabelText('Version'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Version must be x.y.z.')).toBeInTheDocument();
    expect(screen.getByLabelText('Version')).toHaveValue('abc');
    expect(screen.getByLabelText('Version')).toHaveAttribute('aria-invalid', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not saved: Unique constraint violation: root already exists.');
    expect(screen.getByLabelText('Version')).toHaveValue('abc');
  });

  it('drills from a step to its processor and on to a schema slot, with a breadcrumb back', async () => {
    const getEntity = vi.fn(async (kind: string, id: string) =>
      ok(kind === 'step' ? step : kind === 'processor' ? processorDto('p1', { name: 'fetcher', configSchemaId: 'sc1' }) : schemaDto(id, { name: 'cfg' })));
    const { guard } = await renderInspector({ getEntity }, { selection: { kind: 'step', stepId: 's1' } });
    fireEvent.click(await screen.findByRole('button', { name: /fetcher_1\.0\.0-p1/ }));
    expect(await screen.findByText('PROCESSOR')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'sc1' }));                   // the Config slot; the graph does not carry sc1
    expect(await screen.findByLabelText('Definition')).toHaveValue('{}');
    expect(screen.getByRole('navigation', { name: 'Drill-down' })).toHaveTextContent('Step›Processor›Config schema');
    expect(guard).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByText('PROCESSOR')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Step' }));
    expect(await screen.findByLabelText('Name')).toHaveValue('fetch');
  });

  it('shows why a restored draft cannot be read, and lets it be discarded (review focus 4)', async () => {
    const { store } = await renderInspector({ getEntity: vi.fn().mockResolvedValue({ ok: false, error: { kind: 'notFound', status: 404 } }) },
      { selection: { kind: 'step', stepId: 's1' } });
    act(() => store.dispatch({ type: 'edit', workflowId: 'wf1', key: 'description', text: 'restored', saved: '' }));
    expect(await screen.findByText('This step no longer exists.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard unsaved changes' }));
    expect(store.getState().docs[0]!.inspector.edits).toEqual({});
  });

  it('a failed re-read keeps the form and what was typed, with a note (final review 2)', async () => {
    const getEntity = vi.fn().mockResolvedValueOnce(ok(step)).mockResolvedValue({ ok: false, error: { kind: 'network', message: 'down' } });
    const { service } = await renderInspector({ getEntity }, { selection: { kind: 'step', stepId: 's1' } });
    fireEvent.change(await screen.findByLabelText('Description'), { target: { value: 'typed' } });
    act(() => service.read('wf1', true));
    expect(await screen.findByText('Could not read it. Network error: down')).toBeInTheDocument();
    expect(screen.getByLabelText('Description')).toHaveValue('typed');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('a read that failed with nothing to show offers Retry, which reads it again (final review 2)', async () => {
    const getEntity = vi.fn().mockResolvedValueOnce({ ok: false, error: { kind: 'network', message: 'down' } }).mockResolvedValue(ok(step));
    const { store } = await renderInspector({ getEntity }, { selection: { kind: 'step', stepId: 's1' } });
    act(() => store.dispatch({ type: 'edit', workflowId: 'wf1', key: 'description', text: 'restored', saved: '' }));
    expect(await screen.findByText('Could not read it. Network error: down')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard unsaved changes' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Description')).toHaveValue('restored');
    expect(getEntity).toHaveBeenCalledTimes(2);
  });

  it('Discard unsaved changes is disabled while a write is in flight', async () => {
    const { store } = await renderInspector({ getEntity: vi.fn().mockResolvedValue({ ok: false, error: { kind: 'notFound', status: 404 } }) },
      { selection: { kind: 'step', stepId: 's1' } });
    act(() => store.dispatch({ type: 'edit', workflowId: 'wf1', key: 'description', text: 'restored', saved: '' }));
    act(() => store.dispatch({ type: 'busy', workflowId: 'wf1', busy: true, write: 1 }));
    expect(await screen.findByRole('button', { name: 'Discard unsaved changes' })).toBeDisabled();
  });

  const withAssignment = graphDto({
    ...inspectorGraph,
    assignments: [assignmentDto('a1', { stepId: 's1', payload: '{"k":1,"j":2}' })],
  } as never);

  it("opens a step's assignment and saves it with its step unchanged", async () => {
    const assignment = assignmentDto('a1', { stepId: 's1', payload: '{"k":1,"j":2}' });
    const putEntity = vi.fn().mockResolvedValue(ok({ ...assignment, payload: '{"k":3}' }));
    const getEntity = vi.fn(async (kind: string) => ok(kind === 'step' ? step : assignment));
    await renderInspector({ getEntity, putEntity }, { selection: { kind: 'step', stepId: 's1' }, graph: withAssignment });
    fireEvent.click(await screen.findByRole('button', { name: '◆ 2 keys' }));
    fireEvent.change(await screen.findByLabelText('Payload'), { target: { value: '{"k":3}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putEntity).toHaveBeenCalledWith('assignment', 'a1', {
      name: 'assignment-a1', version: '1.0.0', description: null, stepId: 's1', payload: '{"k":3}',
    }));
  });

  it('adds an assignment to a step that has none: a prefilled form, then Create', async () => {
    const created = assignmentDto('a9', { name: 'fetch-assignment', stepId: 's1' });
    const createAssignment = vi.fn().mockResolvedValue(ok(created));
    const getEntity = vi.fn(async (kind: string) => ok(kind === 'step' ? step : kind === 'workflow' ? workflowDto() : created));
    const putEntity = vi.fn().mockResolvedValue(ok(workflowDto({ assignmentIds: ['a9'] })));
    await renderInspector({ getEntity, putEntity, createAssignment }, { selection: { kind: 'step', stepId: 's1' } });

    fireEvent.click(await screen.findByRole('button', { name: '＋ Create' }));
    expect(await screen.findByText('NEW ASSIGNMENT')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('fetch-assignment');
    expect(screen.getByLabelText('Payload')).toHaveValue('{}');
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(putEntity).toHaveBeenCalledWith('workflow', 'wf1', expect.objectContaining({ assignmentIds: ['a9'] })));
    expect(createAssignment).toHaveBeenCalledWith({ name: 'fetch-assignment', version: '1.0.0', description: null, stepId: 's1', payload: '{}' });
    expect(await screen.findByText('ASSIGNMENT')).toBeInTheDocument();
  });

  it('a created assignment keeps Save and Remove disabled until it is linked; a failed link says so and keeps the typed text', async () => {
    const created = assignmentDto('a9', { name: 'fetch-assignment', stepId: 's1' });
    let answer!: (r: unknown) => void;
    const linking = new Promise((r) => { answer = r; });
    const getEntity = vi.fn(async (kind: string) => (kind === 'workflow' ? linking : ok(kind === 'step' ? step : created)));
    const putEntity = vi.fn();
    await renderInspector({ getEntity, putEntity, createAssignment: vi.fn().mockResolvedValue(ok(created)) } as never, { selection: { kind: 'step', stepId: 's1' } });
    fireEvent.click(await screen.findByRole('button', { name: '＋ Create' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create' }));
    expect(await screen.findByText('ASSIGNMENT')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'typed' } });
    expect(screen.getByRole('button', { name: 'Remove assignment' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    await act(async () => answer({ ok: false, error: { kind: 'network', message: 'down' } }));
    expect(await screen.findByText('Created but not linked to this workflow: Network error: down')).toBeInTheDocument();
    expect(screen.getByLabelText('Description')).toHaveValue('typed');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(putEntity).not.toHaveBeenCalled();
  });

  it('the new-assignment form cancels back to its step', async () => {
    await renderInspector({ getEntity: vi.fn().mockResolvedValue(ok(step)) }, { selection: { kind: 'step', stepId: 's1' } });
    fireEvent.click(await screen.findByRole('button', { name: '＋ Create' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('STEP')).toBeInTheDocument();
  });

  it('asks the page before removing an assignment, from the assignment itself', async () => {
    const assignment = assignmentDto('a1', { stepId: 's1' });
    const { confirmRemove } = await renderInspector({ getEntity: vi.fn(async (kind: string) => ok(kind === 'step' ? step : assignment)) },
      { selection: { kind: 'step', stepId: 's1' }, graph: withAssignment });
    fireEvent.click(await screen.findByRole('button', { name: '◆ 2 keys' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove assignment' }));
    expect(confirmRemove).toHaveBeenCalledWith('wf1', 'a1', document);
    expect(screen.queryByRole('button', { name: /Unlink/ })).toBeNull();
  });

  it("asks the page before removing an assignment, from its step's row", async () => {
    const { confirmRemove } = await renderInspector({ getEntity: vi.fn().mockResolvedValue(ok(step)) },
      { selection: { kind: 'step', stepId: 's1' }, graph: withAssignment });
    expect(await screen.findByRole('button', { name: '◆ 2 keys' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '＋ Create' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '✕ Remove' }));
    expect(confirmRemove).toHaveBeenCalledWith('wf1', 'a1', document);
  });

  it('a step without an assignment offers Create and no Remove', async () => {
    await renderInspector({ getEntity: vi.fn().mockResolvedValue(ok(step)) }, { selection: { kind: 'step', stepId: 's1' } });
    expect(await screen.findByRole('button', { name: '＋ Create' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '✕ Remove' })).toBeNull();
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
