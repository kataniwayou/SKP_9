import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { assignmentDto, graphDto, processorDto, schemaDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { entityName } from '../model/entityNames';
import { createStudioStore, StudioStoreProvider, type StudioStore } from '../store/studioStore';
import { inspectorGraph, renderInspector } from '../test/inspector';
import { Output } from './Output';
import { Toolbox } from './PaneNote';
import type { DesignError } from '../model/graph';
import { Problems } from './Problems';
import { buildDesignRequest } from '../app/saveDesign';
import { applyDesign } from '../design/apply';
import { designOf } from '../store/studioState';
import { addCircuitWire, moveWire, setBends, setEnd } from '../circuit/circuit';
import type { StudioDocument } from '../app/document';
import { circuitOf, EMPTY_DRAFT, withCircuit } from '../design/draft';

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

  it('says how many items are picked, and reads a picked wire as text (the user request of 2026-10-09)', async () => {
    const { store } = await renderInspector({ getEntity: vi.fn() }, { selection: null, picks: [{ kind: 'node', id: 's1' }, { kind: 'wire', id: 's1->s2' }] });
    expect(await screen.findByText('2 items selected')).toBeInTheDocument();

    act(() => store.dispatch({ type: 'pick', workflowId: 'wf1', picks: [{ kind: 'wire', id: 's1->s2' }] }));
    expect(screen.getByText('WIRE')).toBeInTheDocument();
    expect(screen.getByLabelText('Wire name')).toHaveTextContent('fetch_1.0.0-s1 → store_1.0.0-s2');
    const dl = screen.getByLabelText('Wire read-out');
    const row = (label: string) => within(dl).getByText(label, { selector: 'dt' }).nextElementSibling!.textContent;
    expect(row('From (tail)')).toBe('step fetch_1.0.0-s1, output side (automatic)');
    expect(row('To (head)')).toBe('step store_1.0.0-s2, input side (automatic)');
    expect(row('Direction')).toBe('directed');
    expect(row('Condition')).toBe('Completed');
    expect(row('Carries')).toBe('fetch_1.0.0-s1 → store_1.0.0-s2');
    expect(row('Shape')).toBe('automatic');
    expect(row('Joined on it')).toBe('none');
    // names are plain text: nothing in the read-out is a button or a link
    expect(within(dl).queryAllByRole('button')).toEqual([]);
    expect(within(dl).queryAllByRole('link')).toEqual([]);

    // it follows the drawing: the head detached, the read-out says so
    const base = (store.getState().docs[0]!.status as { doc: StudioDocument }).doc;
    const c = setEnd(circuitOf(base, EMPTY_DRAFT), 's1->s2', 'head', { on: 'open', x: 900, y: 48 });
    act(() => store.dispatch({ type: 'design', workflowId: 'wf1', draft: withCircuit(EMPTY_DRAFT, base, c) }));
    expect(row('To (head)')).toBe('open (at 900, 48)');
    expect(row('Carries')).toBe('nothing');
    expect(row('Condition')).toBe('undecided');

    // undo or redo can leave a pick naming a wire that is gone
    act(() => store.dispatch({ type: 'pick', workflowId: 'wf1', picks: [{ kind: 'wire', id: 'gone->s9' }] }));
    expect(screen.getByLabelText('Wire name')).toHaveTextContent('gone → s9');
    expect(screen.getByText('This wire is not drawn.')).toBeInTheDocument();
  });

  it('the workflow shows its graph as text under its fields: entry steps, a row per step, problems; it follows the drawing', async () => {
    const { store } = await renderInspector({ getEntity: vi.fn(async () => ok(workflowDto())) }, { selection: { kind: 'workflow' } });
    const graph = await screen.findByRole('region', { name: 'Graph' });
    const entry = within(graph).getByText('Entry steps', { selector: 'dt' }).nextElementSibling!;
    expect(entry.textContent).toBe('fetch_1.0.0-s1 · Completed');
    const table = within(graph).getByRole('table', { name: 'Steps' });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Step', 'Entry', 'Next steps']);
    const rowsOf = () => within(table).getAllByRole('row').slice(1).map((r) => [...r.children].map((c) => c.textContent));
    expect(rowsOf()).toEqual([['fetch_1.0.0-s1', 'Completed', 'store_1.0.0-s2'], ['store_1.0.0-s2', 'Completed', 'none']]);
    expect(within(graph).getByText('Problems', { selector: 'dt' }).nextElementSibling!.textContent).toBe('none');
    expect(within(graph).queryAllByRole('button')).toEqual([]);

    const base = (store.getState().docs[0]!.status as { doc: StudioDocument }).doc;
    const c = setEnd(circuitOf(base, EMPTY_DRAFT), 's1->s2', 'head', { on: 'open', x: 900, y: 48 });
    act(() => store.dispatch({ type: 'design', workflowId: 'wf1', draft: withCircuit(EMPTY_DRAFT, base, c) }));
    expect(rowsOf()).toEqual([['fetch_1.0.0-s1', 'Completed', 'none'], ['store_1.0.0-s2', 'Completed', 'none']]);
    expect(within(graph).getByText('Open wires', { selector: 'dt' }).nextElementSibling!.textContent).toBe('1fetch_1.0.0-s1 → an open end');
    expect(within(graph).getByText('Steps with no wires', { selector: 'dt' }).nextElementSibling!.textContent).toBe('1store_1.0.0-s2');
  });
});

describe('Inspector: the Graph of a step (the user request of 2026-10-09)', () => {
  it('shows its condition, what feeds it, what it feeds and its wires, under its fields; it follows the drawing', async () => {
    const { store } = await renderInspector({ getEntity: vi.fn(async () => ok(stepDto('s1', { name: 'fetch', nextStepIds: ['s2'], processorId: 'p1' }))) },
      { selection: { kind: 'step', stepId: 's1' } });
    const graph = await screen.findByRole('region', { name: 'Graph' });
    const row = (label: string) => within(graph).getByText(label, { selector: 'dt' }).nextElementSibling!.textContent;
    expect(row('Entry condition')).toBe('Completed');
    expect(row('In')).toBe('workflow');
    expect(row('Out')).toBe('store_1.0.0-s2');
    expect(row('Wires on it')).toBe('2');
    expect(within(graph).queryAllByRole('button')).toEqual([]);

    const base = (store.getState().docs[0]!.status as { doc: StudioDocument }).doc;
    const c = setEnd(circuitOf(base, EMPTY_DRAFT), 's1->s2', 'head', { on: 'open', x: 900, y: 48 });
    act(() => store.dispatch({ type: 'design', workflowId: 'wf1', draft: withCircuit(EMPTY_DRAFT, base, c) }));
    expect(row('Out')).toBe('none');
    expect(row('Wires on it')).toBe('2fetch_1.0.0-s1 → an open end (open)');
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

  describe('a stale stamp with no changed fields (spec §6.2: Revert clears it)', () => {
    // a not-applied Save stored s1's wiring and the workflow with the stamps loaded then; both rows have moved since
    const stale = graphDto({
      ...inspectorGraph,
      workflow: workflowDto({ updatedAt: 'w-fresh' }),
      steps: [stepDto('s1', { name: 'fetch', nextStepIds: ['s2'], processorId: 'p1', updatedAt: 't-fresh' }), stepDto('s2', { name: 'store', processorId: 'p1' })],
      design: {
        workflow: { updatedAt: 'w-old', fields: {} },
        steps: [{ id: 's1', updatedAt: 't-old', fields: {}, nextStepIds: [] }],
      },
    } as never);
    const request = (store: StudioStore) => {
      const open = store.getState().docs[0]!;
      const base = open.status.kind === 'ready' ? open.status.doc : null;
      const design = designOf(open);
      return buildDesignRequest(base!, applyDesign(base!, design.draft, design.edits), design);
    };

    it('a wiring-only step: marked, Revert enabled, and Revert sends the freshly loaded stamp with the wiring kept', async () => {
      const getEntity = vi.fn(async () => ok(stepDto('s1', { name: 'fetch', processorId: 'p1', updatedAt: 't-fresh' })));
      const { store } = await renderInspector({ getEntity }, { selection: { kind: 'step', stepId: 's1' }, graph: stale });
      expect(request(store).steps).toEqual([{ id: 's1', updatedAt: 't-old', fields: {}, nextStepIds: [] }]);
      await screen.findByLabelText('Description');
      expect(screen.getByText('● unsaved changes')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
      expect(store.getState().docs[0]!.edits.steps['s1']).toBeUndefined();
      expect(screen.getByRole('button', { name: 'Revert' })).toBeDisabled();
      expect(request(store).steps).toEqual([{ id: 's1', updatedAt: 't-fresh', fields: {}, nextStepIds: [] }]);
    });

    it('the workflow: marked, Revert enabled, and Revert sends the freshly loaded stamp', async () => {
      const getEntity = vi.fn(async () => ok(workflowDto({ updatedAt: 'w-fresh' })));
      const { store } = await renderInspector({ getEntity }, { selection: { kind: 'workflow' }, graph: stale });
      expect(request(store).workflow.updatedAt).toBe('w-old');
      await screen.findByLabelText('Description');
      expect(screen.getByText('● unsaved changes')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
      expect(store.getState().docs[0]!.edits.workflow).toBeNull();
      expect(request(store).workflow.updatedAt).toBe('w-fresh');
    });

    it('a field typed back to its saved value keeps the old stamp until Revert drops it', async () => {
      const getEntity = vi.fn(async () => ok(stepDto('s1', { name: 'fetch', processorId: 'p1', updatedAt: 't-fresh' })));
      const { store } = await renderInspector({ getEntity }, { selection: { kind: 'step', stepId: 's1' }, graph: stale });
      fireEvent.change(await screen.findByLabelText('Description'), { target: { value: 'typed' } });
      fireEvent.change(screen.getByLabelText('Description'), { target: { value: '' } });
      expect(store.getState().docs[0]!.edits.steps['s1']).toEqual({ updatedAt: 't-old', fields: {} });
      expect(screen.getByRole('button', { name: 'Revert' })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
      expect(request(store).steps[0]!.updatedAt).toBe('t-fresh');
    });
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

  async function shorted(errors: DesignError[] | null = null): Promise<StudioStore> {
    const base = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2', 's3'] }), stepDto('s2'), stepDto('s3', { entryCondition: 2 })],
    }));
    const store = createStudioStore();
    store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
    store.dispatch({ type: 'loaded', workflowId: 'wf1', doc: base });
    store.dispatch({ type: 'design', workflowId: 'wf1', draft: withCircuit(EMPTY_DRAFT, base, setEnd(circuitOf(base, EMPTY_DRAFT), 's1->s3', 'tail', { on: 'wire', host: 's1->s2', at: 40 })) });
    const state = store.getState();
    return createStudioStore({ ...state, docs: state.docs.map((d) => ({ ...d, errors })) });
  }

  it('lists a short circuit of the design while it lasts, not only after a Save; its row selects the step (plan 9 §2.2-7)', async () => {
    const store = await shorted();
    wrap(store, <Problems />);
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('short circuit: Completed meets Failed');
    fireEvent.click(rows[0]!);
    expect(store.getState().docs[0]!.selection).toEqual({ kind: 'step', stepId: 's3' });
  });

  it('lists a short circuit once: a stored copy is superseded by the live one, other errors stay; undone, it goes', async () => {
    const copy: DesignError = { kind: 'step', id: 's3', stage: 'wires', field: null, message: 'short circuit: Completed meets Failed' };
    const other: DesignError = { kind: 'step', id: 's2', stage: 'steps', field: 'version', message: 'bad' };
    const store = await shorted([copy, other]);
    wrap(store, <Problems />);
    expect(screen.getAllByRole('listitem').map((r) => r.querySelector('.pd')!.textContent)).toEqual(['short circuit: Completed meets Failed', 'bad']);

    act(() => store.dispatch({ type: 'undo', workflowId: 'wf1' }));
    expect(screen.getAllByRole('listitem').map((r) => r.querySelector('.pd')!.textContent)).toEqual(['bad']);
  });
});

describe('Problems: a wire lying on another net\'s wire (the user\'s rule 2, 2026-10-09)', () => {
  it('lists "short circuit: <wire> overlaps <wire>" with the wires named as the Inspector names them, while it lasts', async () => {
    const base = await loadedDocument(graph);
    const store = createStudioStore();
    store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
    store.dispatch({ type: 'loaded', workflowId: 'wf1', doc: base });
    const host = base.wires.find((w) => w.id === 's1->s2')!.points;
    // s1 -> s2 shaped by hand where it is (an automatic wire would move a track over: the coordinator's ruling)
    const c = moveWire(addCircuitWire(setBends(circuitOf(base, EMPTY_DRAFT), 's1->s2', { xs: [host[0]![0]], ys: [] }), 'w:f', { tail: { on: 'open', x: 0, y: 0 }, head: { on: 'open', x: 0, y: 0 } }), 'w:f', host, () => null);
    store.dispatch({ type: 'design', workflowId: 'wf1', draft: withCircuit(EMPTY_DRAFT, base, c) });
    wrap(store, <Problems />);
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.querySelector('.gate')).toHaveTextContent('Wire');
    expect(rows[0]!.querySelector('b')).toHaveTextContent('fetch_1.0.0-s1 → store_1.0.0-s2');
    expect(rows[0]!.querySelector('.pd')).toHaveTextContent('short circuit: fetch_1.0.0-s1 → store_1.0.0-s2 overlaps an open end → an open end');
    // clicking the row picks both wires on the canvas (review 2026-10-09)
    expect(rows[0]).toHaveAttribute('tabindex', '0');
    fireEvent.click(rows[0]!);
    expect(store.getState().docs[0]!.picks).toEqual([{ kind: 'wire', id: 's1->s2' }, { kind: 'wire', id: 'w:f' }]);
    act(() => store.dispatch({ type: 'undo', workflowId: 'wf1' }));
    expect(screen.getByText('No problems')).toBeInTheDocument();
  });
});

describe('Output and Toolbox', () => {
  it('Output says nothing happened yet, then logs each Save answer with its workflow (plan 8 §4.1)', async () => {
    const store = await storeWith();
    const { unmount } = wrap(store, <Output />);
    expect(screen.getByText('Nothing yet. Each Save says here what happened.')).toBeInTheDocument();
    unmount();
    act(() => store.dispatch({ type: 'saveFailed', workflowId: 'wf1', at: '2026-10-07T12:00:00Z', message: 'Network error: down' }));
    wrap(store, <Output />);
    expect(screen.getByRole('log', { name: 'Output' })).toHaveTextContent('orders Not saved: Network error: down');
  });

  it('Toolbox is a real pane with one line', () => {
    render(<Toolbox />);
    expect(screen.getByText('The toolbox arrives in a later version.')).toBeInTheDocument();
  });
});
