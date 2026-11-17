import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { memoryStorage } from '../test/memoryStorage';
import { describe, expect, it } from 'vitest';
import { toFlow } from '../board/toFlow';
import { createBoardStore, useBoard, type BoardStore } from '../design/boardStore';
import { bwFull, proc } from '../design/fixtures';
import { AUDIT } from '../model/fixtures';
import { createOutputStore } from '../output/outputStore';
import { LiveStoreProvider } from '../live/LiveContext';
import { liveStub } from '../test/liveStub';
import type { Selection } from '../board/selection';
import { InspectorPanel } from './InspectorPanel';
import { bw } from '../board/fixtures';
import type { Pick } from '../board/picks';
import { setCacheField, setProcessorField, setStepField } from '../design/state';

function setup(sel: Selection | null, tweak?: (b: ReturnType<typeof bwFull>) => void) {
  const b = bwFull();
  tweak?.(b);
  const store = createBoardStore(createOutputStore(null, () => '00:00:00'), null);
  store.load({ listed: true, workflows: [b], failures: [] }, [{ ...proc('p1', 'Analyst'), configSchemaId: 's1' }]);
  function Harness({ s }: { s: BoardStore }) {
    const ws = useBoard(s);
    return <InspectorPanel workflows={ws} picks={sel === null ? [] : [sel]} store={s} />;
  }
  render(<LiveStoreProvider value={liveStub()}><Harness s={store} /></LiveStoreProvider>);
  return store;
}
const stepName = (st: BoardStore) => st.boards()[0]!.graph.steps.get('a')!.name;
const A: Selection = { kind: 'step', workflowId: 'w1', stepId: 'a' };

describe('inspector editing', () => {
  it('typing commits one undo step, keeps focus, and undo clears unsaved', () => {
    const st = setup(A);
    const input = screen.getByDisplayValue('a-name');
    input.focus();
    fireEvent.change(input, { target: { value: 'a' } });
    fireEvent.change(screen.getByDisplayValue('a'), { target: { value: 'ab' } });
    expect(stepName(st)).toBe('ab');
    expect(st.entry('w1')!.history.past).toHaveLength(1);
    expect(screen.getByDisplayValue('ab')).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(st.entry('w1')!.unsaved).toBe(true);
    st.undo('w1');
    expect(stepName(st)).toBe('a-name');
    expect(st.entry('w1')!.unsaved).toBe(false);
  });
  it('recolours the wires into the step when the entry condition changes', () => {
    const st = setup({ kind: 'step', workflowId: 'w1', stepId: 'b' });
    fireEvent.change(screen.getByLabelText(/Entry condition/), { target: { value: '2' } });
    const edge = toFlow(st.boards()).edges.find((e) => e.id === 'wi:w1:a>b');
    expect((edge!.data as { condition: number }).condition).toBe(2);
  });
  it('shows the checker message for an invalid payload and keeps it', () => {
    const st = setup(A, (b) => {
      b.graph.processors.set('p1', { ...b.graph.processors.get('p1')!, configSchemaId: 's1' });
      b.graph.schemas.set('s1', { id: 's1', name: 's', version: '1', description: null, audit: b.graph.workflow.audit,
        definition: JSON.stringify({ type: 'object', required: ['x'] }) });
    });
    fireEvent.change(screen.getByLabelText(/Payload/), { target: { value: '{}' } });
    fireEvent.change(screen.getByLabelText(/Payload/), { target: { value: '{"y":1}' } });
    expect(st.boards()[0]!.graph.assignments[0]!.payload).toBe('{"y":1}');
    expect(document.querySelectorAll('.in-problem').length).toBeGreaterThan(0);
  });
  it('removes the assignment', () => {
    const st = setup(A);
    fireEvent.click(screen.getByText('Remove assignment'));
    expect(st.boards()[0]!.graph.assignments).toHaveLength(0);
  });
  it('shows the store value again when the save lock refuses an edit', () => {
    const st = setup(A);
    st.setSaving('w1', true);
    const input = screen.getByDisplayValue('a-name');
    fireEvent.change(input, { target: { value: 'zzz' } });
    expect((input as HTMLInputElement).value).toBe('a-name');
  });

  describe('header', () => {
    const header = () => document.querySelector('.ph') as HTMLElement;
    const btn = (n: string) => screen.getByRole('button', { name: n }) as HTMLButtonElement;
    it('is greyed with no name when nothing is selected', () => {
      setup(null);
      expect(btn('Undo').disabled).toBe(true);
      expect(btn('Redo').disabled).toBe(true);
      expect(header().textContent).not.toContain('orders');
    });
    it('shows the workflow name and enables Undo/Redo as the history allows', () => {
      const st = setup(A);
      expect(header().textContent).toContain('orders');
      expect(btn('Undo').disabled).toBe(true);
      expect(btn('Redo').disabled).toBe(true);
      fireEvent.change(screen.getByDisplayValue('a-name'), { target: { value: 'ab' } });
      expect(btn('Undo').disabled).toBe(false);
      expect(btn('Redo').disabled).toBe(true);
      fireEvent.click(btn('Undo'));
      expect(stepName(st)).toBe('a-name');
      expect(btn('Undo').disabled).toBe(true);
      expect(btn('Redo').disabled).toBe(false);
      fireEvent.click(btn('Redo'));
      expect(stepName(st)).toBe('ab');
    });
    it('names the kind of the pick next to the panel name', () => {
      setup(A);
      expect(header().querySelector('.cnt')).toHaveTextContent(/^step$/);
    });
    it('counts the unsaved workflows in the board summary', () => {
      const st = setup(null);
      expect(screen.getByText(/0 unsaved\./)).toBeInTheDocument();
      act(() => { st.edit('w1', (s) => setStepField(s, 'a', 'name', 'ab')); });
      expect(screen.getByText(/1 unsaved\./)).toBeInTheDocument();
    });
    it('does not offer Undo/Redo without a store', () => {
      render(<LiveStoreProvider value={liveStub()}><InspectorPanel workflows={[bwFull()]} picks={[A]} /></LiveStoreProvider>);
      expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    });
  });

  describe('processor section', () => {
    const withSchema = (def: string | null) => (b: ReturnType<typeof bwFull>) => {
      b.graph.schemas.set('s1', { id: 's1', name: 'cfg', version: '1', description: null, audit: AUDIT, ...(def === null ? {} : { definition: def }) });
    };
    const defn = () => screen.getByLabelText('Config schema definition') as HTMLTextAreaElement;
    it('shows the processor fields and the three slots', () => {
      setup(A, withSchema('{"type":"object"}'));
      expect(screen.getByLabelText('Processor name')).toHaveProperty('value', 'Analyst');
      expect(screen.getByLabelText('Processor version')).toBeTruthy();
      expect(screen.getByLabelText('Processor description')).toBeTruthy();
      expect(screen.getByText('In schema').nextSibling).toHaveTextContent('none');
      expect(screen.getByText('Out schema').nextSibling).toHaveTextContent('none');
      expect(screen.getByLabelText('Config schema name')).toHaveProperty('value', 'cfg');
      expect(screen.getByLabelText('Config schema version')).toHaveProperty('value', '1');
      expect(defn().value).toBe('{"type":"object"}');
    });
    it('typing the processor name is one undo step and the step card follows', () => {
      const st = setup(A, withSchema('{}'));
      fireEvent.change(screen.getByLabelText('Processor name'), { target: { value: 'A' } });
      fireEvent.change(screen.getByLabelText('Processor name'), { target: { value: 'An' } });
      expect(st.boards()[0]!.graph.processors.get('p1')!.name).toBe('An');
      expect(st.entry('w1')!.history.past).toHaveLength(1);
      st.undo('w1');
      expect(st.boards()[0]!.graph.processors.get('p1')!.name).toBe('Analyst');
      expect(st.entry('w1')!.unsaved).toBe(false);
    });
    it('a definition edit makes one copy, re-checks the payload against it, and Clear then Undo restores', () => {
      const st = setup(A, withSchema('{}'));
      fireEvent.change(screen.getByLabelText(/Payload/), { target: { value: '{"y":1}' } });
      expect(document.querySelectorAll('.in-problem')).toHaveLength(0);
      const pastBefore = st.entry('w1')!.history.past.length;
      fireEvent.change(defn(), { target: { value: '{"type":"object","required":["x"]}' } });
      fireEvent.change(defn(), { target: { value: '{"type":"object","required":["x"],"a":1}' } });
      const ps = st.entry('w1')!.history.present.processors!;
      expect(Object.keys(ps)).toEqual(['p1']);
      expect(st.entry('w1')!.history.past).toHaveLength(pastBefore + 1);
      expect((ps.p1!.slots.config as { copy: { name: string } }).copy.name).toBe('cfg');
      expect(document.querySelectorAll('.in-problem').length).toBeGreaterThan(0);
      const before = st.entry('w1')!.history.present;
      fireEvent.click(screen.getByRole('button', { name: 'Clear Config' }));
      expect(screen.getByText('Config schema').nextSibling).toHaveTextContent('none');
      st.undo('w1');
      expect(st.entry('w1')!.history.present).toBe(before);
    });
    it('reads a schema without a loaded definition as read-only', () => {
      setup(A, withSchema(null));
      expect(screen.getByText(/definition not loaded/)).toBeTruthy();
      expect(screen.queryByLabelText('Config schema definition')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Clear Config' })).toBeNull();
    });
  });
});

describe('the shared-entity lock', () => {
  /** w1 'orders' and w2 'billing' share step s1 (processor p-s1) and cache c1; w2's s1 is picked. */
  function sharedSetup(lockIn: (st: BoardStore) => void, pick: Pick, session: Storage | null = null) {
    const cache = { id: 'c1', name: 'rates', version: '1', description: null, root: 'r', items: '{}', audit: AUDIT };
    const mk = (id: string, name: string) => {
      const b = bw(id, ['s1']);
      b.graph.workflow = { ...b.graph.workflow, name, cacheIds: ['c1'] };
      b.graph.caches = new Map([['c1', cache]]);
      return b;
    };
    const store = createBoardStore(createOutputStore(null, () => '00:00:00'), session);
    store.load({ listed: true, workflows: [mk('w1', 'orders'), mk('w2', 'billing')], failures: [] }, []);
    lockIn(store);
    function Harness({ s }: { s: BoardStore }) {
      const ws = useBoard(s);
      return <InspectorPanel workflows={ws} picks={[pick]} store={s} />;
    }
    render(<LiveStoreProvider value={liveStub()}><Harness s={store} /></LiveStoreProvider>);
    return store;
  }
  const S2: Pick = { kind: 'step', workflowId: 'w2', stepId: 's1' };
  const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

  it('shows a step being changed elsewhere with its saved value, read-only', () => {
    sharedSetup((st) => st.edit('w1', (s) => setStepField(s, 's1', 'name', 'renamed')), S2);
    expect(screen.getByText('being changed in orders')).toBeInTheDocument();
    expect(input('Name').value).toBe('s1-name');
    expect(input('Name').disabled).toBe(true);
    expect((screen.getByLabelText(/Entry condition/) as HTMLSelectElement).disabled).toBe(true);
    expect(input('Processor name').disabled).toBe(false);
  });
  it('locks the processor fields while another workflow changes the processor', () => {
    sharedSetup((st) => st.edit('w1', (s) => setProcessorField(s, st.processor('p-s1', 'w1')!, 'name', 'Other')), S2);
    expect(screen.getByText('being changed in orders')).toBeInTheDocument();
    expect(input('Processor name').disabled).toBe(true);
    expect(input('Processor name').value).toBe('s1-proc');
    expect(input('Name').disabled).toBe(false);
  });
  it('locks a cache another workflow is changing', () => {
    sharedSetup((st) => st.edit('w1', (s) => setCacheField(s, 'c1', 'root', 'z')), { kind: 'cache', workflowId: 'w2', cacheId: 'c1' });
    expect(screen.getByText('being changed in orders')).toBeInTheDocument();
    expect(input('Root').disabled).toBe(true);
    expect(input('Root').value).toBe('r');
  });
  it('leaves the fields open in both workflows when drafts brought both back changing the step', () => {
    const draftOf = (wf: 'w1' | 'w2', name: string) => {
      const session = memoryStorage();
      sharedSetup((st) => st.edit(wf, (s) => setStepField(s, 's1', 'name', name)), { kind: 'workflow', workflowId: wf }, session);
      cleanup();
      return JSON.parse(session.getItem('acto.drafts')!) as Record<string, unknown>;
    };
    const both = memoryStorage({ 'acto.drafts': JSON.stringify({ ...draftOf('w1', 'one'), ...draftOf('w2', 'two') }) });
    for (const wf of ['w1', 'w2']) {
      const st = sharedSetup(() => {}, { kind: 'step', workflowId: wf, stepId: 's1' }, both);
      expect(st.entry(wf)!.unsaved).toBe(true);
      expect(screen.queryByText(/being changed in/)).toBeNull();
      expect(input('Name').disabled).toBe(false);
      cleanup();
    }
  });
  it('leaves the fields open in the workflow making the change', () => {
    sharedSetup((st) => st.edit('w1', (s) => setStepField(s, 's1', 'name', 'renamed')), { kind: 'step', workflowId: 'w1', stepId: 's1' });
    expect(screen.queryByText(/being changed in/)).toBeNull();
    expect(input('Name').disabled).toBe(false);
  });
});
