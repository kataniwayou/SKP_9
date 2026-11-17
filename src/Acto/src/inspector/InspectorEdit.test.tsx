import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { toFlow } from '../board/toFlow';
import { createBoardStore, useBoard, type BoardStore } from '../design/boardStore';
import { bwFull, proc } from '../design/fixtures';
import { createOutputStore } from '../output/outputStore';
import { LiveStoreProvider } from '../live/LiveContext';
import { liveStub } from '../test/liveStub';
import type { Selection } from '../board/selection';
import { InspectorPanel } from './InspectorPanel';

function setup(sel: Selection, tweak?: (b: ReturnType<typeof bwFull>) => void) {
  const b = bwFull();
  tweak?.(b);
  const store = createBoardStore(createOutputStore(null, () => '00:00:00'), null);
  store.load({ listed: true, workflows: [b], failures: [] }, [{ ...proc('p1', 'Analyst'), configSchemaId: b.graph.schemas.size > 0 ? 's1' : null }]);
  function Harness({ s }: { s: BoardStore }) {
    const ws = useBoard(s);
    return <InspectorPanel workflows={ws} selection={sel} store={s} />;
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
    const edge = toFlow(st.boards()).edges.find((e) => e.id.includes('a') && e.target === 'b' || (e.data as { wireId?: string })?.wireId === 'a>b');
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
});
