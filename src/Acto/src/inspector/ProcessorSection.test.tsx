import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BoardState } from '../design/board';
import { board } from '../design/boardFixtures';
import { createBoardStore } from '../design/boardStore';
import { setPayload } from '../design/payloads';
import { LiveStoreProvider } from '../live/LiveContext';
import { createOutputStore } from '../output/outputStore';
import { liveStub } from '../test/liveStub';
import { InspectorPanel } from './InspectorPanel';

const T = '2026-11-01T00:00:00Z';
const audit = { createdAt: T, createdBy: null, updatedAt: T, updatedBy: null };
const REQUIRED = '{"type":"object","required":["k"]}';

function withSchemas(): BoardState {
  const b = board();
  return {
    ...b,
    processors: { p1: { ...b.processors.p1, configSchemaId: 's-cfg', inputSchemaId: 's-in' } },
    schemas: {
      's-cfg': { id: 's-cfg', name: 'cfg', version: '1.0.0', description: null, definition: REQUIRED, audit, updatedAt: T },
      's-in': { id: 's-in', name: 'in', version: '1.0.0', description: null, definition: null, audit, updatedAt: T },
    },
  };
}

function setup() {
  const store = createBoardStore(createOutputStore(null, () => '00:00:00'), null);
  store.load(withSchemas());
  render(<LiveStoreProvider value={liveStub()}>
    <InspectorPanel store={store} selection={{ workflows: ['daily'], picks: [{ kind: 'step', id: 'fetch' }] }} />
  </LiveStoreProvider>);
  return store;
}

describe('ProcessorSection', () => {
  it('shows the processor fields and the three slots; an unloaded definition is read-only; no schema reads none', () => {
    setup();
    expect(screen.getByDisplayValue('proc')).toBeInTheDocument();
    expect(screen.getByLabelText('Config schema definition')).toHaveValue(REQUIRED);
    expect(screen.getByText('In schema').nextSibling).toHaveTextContent('in 1.0.0 · definition not loaded');
    expect(screen.queryByLabelText('In schema definition')).toBeNull();
    expect(screen.getByText('Out schema').nextSibling).toHaveTextContent('none');
  });
  it('typing the processor name is one undo step', () => {
    const store = setup();
    const input = screen.getByLabelText('Processor name');
    fireEvent.change(input, { target: { value: 'p' } });
    fireEvent.change(input, { target: { value: 'pr' } });
    expect(store.state().processors.p1!.name).toBe('pr');
    store.undo();
    expect(store.state().processors.p1!.name).toBe('proc');
    expect(store.canUndo()).toBe(false);
  });
  it('a definition edit makes one copy, edits it in place after, and re-checks the payload', () => {
    const store = setup();
    expect(document.querySelector('.in-problem')).not.toBeNull(); // '{}' lacks the required key
    const area = screen.getByLabelText('Config schema definition');
    fireEvent.change(area, { target: { value: '{"type":"object"}' } });
    const copyId = store.state().processors.p1!.configSchemaId!;
    expect(copyId).not.toBe('s-cfg');
    expect(store.state().schemas[copyId]).toMatchObject({ definition: '{"type":"object"}', updatedAt: null });
    expect(store.state().schemas['s-cfg']!.definition).toBe(REQUIRED);
    expect(document.querySelector('.in-problem')).toBeNull();
    fireEvent.change(screen.getByLabelText('Config schema definition'), { target: { value: '{"type":"object","x":1}' } });
    expect(store.state().processors.p1!.configSchemaId).toBe(copyId);
    expect(Object.keys(store.state().schemas)).toHaveLength(3);
  });
  it('the schema name edits the copy too', () => {
    const store = setup();
    fireEvent.change(screen.getByLabelText('Config schema name'), { target: { value: 'renamed' } });
    expect(store.state().schemas[store.state().processors.p1!.configSchemaId!]!.name).toBe('renamed');
  });
  it('Clear empties the slot and Undo restores it', () => {
    const store = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Clear Config' }));
    expect(store.state().processors.p1!.configSchemaId).toBeNull();
    expect(screen.getByText('Config schema').nextSibling).toHaveTextContent('none');
    act(() => store.undo());
    expect(store.state().processors.p1!.configSchemaId).toBe('s-cfg');
    expect(screen.getByLabelText('Config schema definition')).toHaveValue(REQUIRED);
  });
  it('the payload is checked against the config schema', () => {
    const store = setup();
    act(() => store.edit((b) => setPayload(b, 'daily', 'fetch', '{"k":1}', () => 'n')));
    expect(document.querySelector('.in-problem')).toBeNull();
  });
});
