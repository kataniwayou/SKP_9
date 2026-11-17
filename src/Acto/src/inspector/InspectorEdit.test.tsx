import { fireEvent, render, screen } from '@testing-library/react';
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
      fireEvent.change(defn(), { target: { value: '{"type":"object","required":["x"]}' } });
      fireEvent.change(defn(), { target: { value: '{"type":"object","required":["x"],"a":1}' } });
      const ps = st.entry('w1')!.history.present.processors!;
      expect(Object.keys(ps)).toEqual(['p1']);
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
