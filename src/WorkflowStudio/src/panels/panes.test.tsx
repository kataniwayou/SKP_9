import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { assignmentDto, graphDto, processorDto, schemaDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { entityName } from '../model/entityNames';
import { createStudioStore, StudioStoreProvider, type StudioStore } from '../store/studioStore';
import { inspectorGraph, renderInspector } from '../test/inspector';
import { Output, Toolbox } from './PaneNote';
import type { DesignError } from '../model/graph';
import { Problems } from './Problems';

const graph = graphDto({
  steps: [stepDto('s1', { name: 'fetch', nextStepIds: ['s2'], processorId: 'p1' }), stepDto('s2', { name: 'store', processorId: 'p1' })],
  processors: [processorDto('p1', { name: 'fetcher' })],
} as never);

async function storeWith(errors: DesignError[] | null = null): Promise<StudioStore> {
  const store = createStudioStore();
  store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
  store.dispatch({ type: 'loaded', workflowId: 'wf1', doc: await loadedDocument(graph) });
  const state = store.getState();
  return createStudioStore({ ...state, docs: state.docs.map((d) => ({ ...d, errors })) });
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

  it('says how many items are picked, and names a picked wire (plan 4)', async () => {
    const { store } = await renderInspector({ getEntity: vi.fn() }, { selection: null, picks: [{ kind: 'node', id: 's1' }, { kind: 'wire', id: 's1->s2' }] });
    expect(await screen.findByText('2 items selected')).toBeInTheDocument();

    act(() => store.dispatch({ type: 'pick', workflowId: 'wf1', picks: [{ kind: 'wire', id: 's1->s2' }] }));
    expect(screen.getByText('Wire: fetch_1.0.0-s1 → store_1.0.0-s2')).toBeInTheDocument();
    // undo or redo can leave a pick naming a wire that is gone
    act(() => store.dispatch({ type: 'pick', workflowId: 'wf1', picks: [{ kind: 'wire', id: 'gone->s9' }] }));
    expect(screen.getByText('Wire: gone → s9')).toBeInTheDocument();
  });
});

describe('Inspector editing (plan 8 §3.3: the design, never BaseApi)', () => {
  const step = stepDto('s1', { name: 'fetch', nextStepIds: ['s2'], processorId: 'p1' });
  const reads = (kind: string, id: string) => ok(
    kind === 'step' ? (id === 's1' ? step : stepDto('s2', { name: 'store', processorId: 'p1' }))
      : kind === 'processor' ? processorDto('p1', { name: 'fetcher', configSchemaId: 'sc1' })
        : kind === 'schema' ? schemaDto('sc1', { name: 'cfg', version: '1.2.3', definition: '{"type":"object"}' })
          : assignmentDto(id, { stepId: 's1' }));

  it('an edit goes to the design: marked, kept when the Inspector moves away, and Revert drops it', async () => {
    const getEntity = vi.fn(async (kind: string, id: string) => reads(kind, id));
    const { store, api } = await renderInspector({ getEntity }, { selection: { kind: 'step', stepId: 's1' } });
    fireEvent.change(await screen.findByLabelText('Description'), { target: { value: 'typed' } });
    expect(screen.getByText('● unsaved changes')).toBeInTheDocument();

    act(() => store.dispatch({ type: 'select', workflowId: 'wf1', selection: { kind: 'step', stepId: 's2' } }));
    act(() => store.dispatch({ type: 'select', workflowId: 'wf1', selection: { kind: 'step', stepId: 's1' } }));
    expect(await screen.findByLabelText('Description')).toHaveValue('typed');

    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    expect(screen.getByLabelText('Description')).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(api.putEntity).not.toHaveBeenCalled();
  });

  it('a schema edited from its processor\'s slot becomes a copy with the same name and version (spec §1.5)', async () => {
    const getEntity = vi.fn(async (kind: string, id: string) => reads(kind, id));
    const { store } = await renderInspector({ getEntity }, { selection: { kind: 'processor', processorId: 'p1', stepId: 's1' } });
    // the fixture graph carries no schema rows, so the slot shows the schema's id
    fireEvent.click(await screen.findByRole('button', { name: 'sc1' }));
    fireEvent.change(await screen.findByLabelText('Definition'), { target: { value: '{"type":"string"}' } });
    const copy = store.getState().docs[0]!.edits.schemas['p1:config']!;
    expect([copy.name, copy.version, copy.definition]).toEqual(['cfg', '1.2.3', '{"type":"string"}']);
    expect(copy.id).not.toBe('sc1');
  });

  it('an empty slot offers ＋ Define: a copy named <processor>-<slot>, 1.0.0', async () => {
    const getEntity = vi.fn(async (kind: string, id: string) => reads(kind, id));
    const { store } = await renderInspector({ getEntity }, { selection: { kind: 'processor', processorId: 'p1', stepId: 's1' } });
    const output = (await screen.findAllByText('Out'))[0]!.closest('.slot')!;
    fireEvent.click(within(output as HTMLElement).getByRole('button', { name: '＋ Define' }));
    fireEvent.change(await screen.findByLabelText('Definition'), { target: { value: '{"type":"array"}' } });
    expect(store.getState().docs[0]!.edits.schemas['p1:output']).toMatchObject({ name: 'fetcher-output', version: '1.0.0', definition: '{"type":"array"}' });
  });

  it('＋ Create makes the step\'s assignment in the design and shows it; Remove takes it away; nothing is written', async () => {
    const getEntity = vi.fn(async (kind: string, id: string) => reads(kind, id));
    const { store, api } = await renderInspector({ getEntity }, { selection: { kind: 'step', stepId: 's1' } });
    fireEvent.click(await screen.findByRole('button', { name: '＋ Create' }));
    expect(await screen.findByText('ASSIGNMENT')).toBeInTheDocument();
    expect(await screen.findByLabelText('Name')).toHaveValue('fetch-assignment');
    // not in the database yet: named by what the design holds, with its new id
    const id = store.getState().docs[0]!.edits.assignments['s1']!.id;
    expect(screen.getByLabelText('Unique name')).toHaveTextContent(entityName('fetch-assignment', '1.0.0', id));
    fireEvent.click(screen.getByRole('button', { name: 'Remove assignment' }));
    expect(await screen.findByText('STEP')).toBeInTheDocument();
    expect(store.getState().docs[0]!.edits.assignments).toEqual({});
    expect(api.createAssignment).not.toHaveBeenCalled();
    expect(api.deleteAssignment).not.toHaveBeenCalled();
  });
  it("the step row drills into its assignment, and ✕ Remove takes it off in the design only", async () => {
    const getEntity = vi.fn(async (kind: string, id: string) => reads(kind, id));
    const graph = graphDto({ ...inspectorGraph, assignments: [assignmentDto('a1', { stepId: 's1', payload: '{"a":1,"b":2}' })] } as never);
    const { store, api } = await renderInspector({ getEntity }, { selection: { kind: 'step', stepId: 's1' }, graph });
    fireEvent.click(await screen.findByRole('button', { name: '◆ 2 keys' }));
    expect(await screen.findByText('ASSIGNMENT')).toBeInTheDocument();
    expect(getEntity).toHaveBeenCalledWith('assignment', 'a1');
    fireEvent.click(screen.getByRole('button', { name: 'Step' }));
    fireEvent.click(await screen.findByRole('button', { name: '✕ Remove' }));
    expect(store.getState().docs[0]!.edits.assignments['s1']).toMatchObject({ op: 'delete', id: 'a1' });
    expect(await screen.findByRole('button', { name: '＋ Create' })).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    for (const write of [api.putEntity, api.createAssignment, api.deleteAssignment, api.saveDesign]) expect(write).not.toHaveBeenCalled();
  });

  it('drills step → processor → schema with a breadcrumb, and the crumbs go back', async () => {
    const getEntity = vi.fn(async (kind: string, id: string) => reads(kind, id));
    await renderInspector({ getEntity }, { selection: { kind: 'step', stepId: 's1' } });
    fireEvent.click(await screen.findByRole('button', { name: 'fetcher_1.0.0-p1' }));
    expect(await screen.findByText('PROCESSOR')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'sc1' }));
    expect(await screen.findByText('SCHEMA')).toBeInTheDocument();
    const crumbs = screen.getByRole('navigation', { name: 'Drill-down' });
    expect(crumbs).toHaveTextContent('Step›Processor›Config schema');
    fireEvent.click(within(crumbs).getByRole('button', { name: 'Back' }));
    expect(await screen.findByText('PROCESSOR')).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Drill-down' })).getByRole('button', { name: 'Step' }));
    expect(await screen.findByText('STEP')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Drill-down' })).toBeNull();
  });

  it('a failed read offers Retry, which reads it again', async () => {
    const getEntity = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { kind: 'network', message: 'down' } })
      .mockImplementation(async (kind: string, id: string) => reads(kind, id));
    await renderInspector({ getEntity }, { selection: { kind: 'step', stepId: 's1' } });
    expect(await screen.findByText(/^Could not read it\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Description')).toBeInTheDocument();
    expect(getEntity).toHaveBeenCalledTimes(2);
  });

  describe("the last Save's errors under their fields", () => {
    // a Save answered with errors; the design read back holds a copy of p1's config schema, id cp1
    const answered = async (store: StudioStore, errors: DesignError[]) => {
      const design = {
        processors: [{ id: 'p1', slots: { config: 'cp1' } }],
        schemas: [{ id: 'cp1', name: 'cfg', version: '1.2.3', description: null, definition: '{}' }],
      };
      const doc = await loadedDocument(graphDto({ ...inspectorGraph, design } as never));
      act(() => store.dispatch({ type: 'saveAnswered', workflowId: 'wf1', at: '2026-10-08T10:00:00Z', applied: false, errors, doc }));
    };

    it("shows a step's error under its field, and only there", async () => {
      const getEntity = vi.fn(async (kind: string, id: string) => reads(kind, id));
      const { store } = await renderInspector({ getEntity }, { selection: { kind: 'step', stepId: 's1' } });
      await answered(store, [
        { kind: 'step', id: 's1', stage: 'steps', field: 'description', message: 'too long' },
        { kind: 'step', id: 's2', stage: 'steps', field: 'name', message: 'not this one' },
      ]);
      expect(await screen.findByLabelText('Description')).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByText('too long')).toBeInTheDocument();
      expect(screen.getByLabelText('Name')).not.toHaveAttribute('aria-invalid');
      expect(screen.queryByText('not this one')).toBeNull();
    });

    it("finds a schema copy's error by the copy's id, reached from the processor's slot", async () => {
      const getEntity = vi.fn(async (kind: string, id: string) => reads(kind, id));
      const { store } = await renderInspector({ getEntity }, { selection: { kind: 'processor', processorId: 'p1', stepId: 's1' } });
      await answered(store, [{ kind: 'schema', id: 'cp1', stage: 'schemas', field: 'definition', message: 'not a schema' }]);
      fireEvent.click(await screen.findByRole('button', { name: 'cfg_1.2.3-cp1' }));
      expect(await screen.findByLabelText('Definition')).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByText('not a schema')).toBeInTheDocument();
      expect(screen.getByLabelText('Unique name')).toHaveTextContent('cfg_1.2.3-cp1');
      expect(getEntity).toHaveBeenCalledWith('schema', 'sc1');
    });
  });
});

describe('Problems (plan 8 §4.1: the last Save\'s errors)', () => {
  const errors: DesignError[] = [
    { kind: 'step', id: 's2', stage: 'steps', field: 'version', message: "'abc' is not a version" },
    { kind: 'schema', id: 'nowhere', stage: 'schemas', field: 'definition', message: 'not JSON' },
  ];

  it('says "No problems" when no Save has reported any', async () => {
    wrap(await storeWith(null), <Problems />);
    expect(screen.getByText('No problems')).toBeInTheDocument();
  });

  it('lists entity, field and message, and selects the entity of a row when clicked', async () => {
    const store = await storeWith(errors);
    wrap(store, <Problems />);
    const [named, unnamed] = screen.getAllByRole('listitem');
    expect(named).toHaveTextContent('Step');
    expect(named).toHaveTextContent('store_1.0.0-s2 · version');
    expect(named).toHaveTextContent("'abc' is not a version");

    fireEvent.click(unnamed!);
    expect(store.getState().docs[0]!.selection).toBeNull();
    fireEvent.click(named!);
    expect(store.getState().docs[0]!.selection).toEqual({ kind: 'step', stepId: 's2' });
  });

  it('selects from the keyboard: a row with an entity is focusable and Enter selects it', async () => {
    const store = await storeWith(errors);
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
