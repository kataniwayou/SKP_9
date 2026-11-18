import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BoardState } from '../../design/board';
import { board } from '../../design/boardFixtures';
import { createBoardStore } from '../../design/boardStore';
import { createGhostStore } from '../../design/ghosts';
import { setPayload } from '../../design/payloads';
import { LiveStoreProvider } from '../../live/LiveContext';
import { prettyJson } from '../../model/json';
import { createOutputStore } from '../../output/outputStore';
import { liveStub } from '../../test/liveStub';
import { InspectorPanel } from '../InspectorPanel';

const T = '2026-11-01T00:00:00Z';
const audit = { createdAt: T, createdBy: 'katan', updatedAt: T, updatedBy: null };
const REQUIRED = '{"type":"object","required":["k"]}';

function withSchemas(): BoardState {
  const b = board();
  return {
    ...b,
    processors: { p1: { ...b.processors.p1!, configSchemaId: 's-cfg', inputSchemaId: 's-in' } },
    schemas: {
      's-cfg': { id: 's-cfg', name: 'cfg', version: '1.0.0', description: null, definition: REQUIRED, audit, updatedAt: T },
      's-in': { id: 's-in', name: 'in', version: '1.0.0', description: null, definition: null, audit, updatedAt: T },
    },
  };
}

function setup(tab = 'Processor') {
  const store = createBoardStore(createOutputStore(null, () => '00:00:00'), null);
  store.load(withSchemas());
  render(<LiveStoreProvider value={liveStub()}>
    <InspectorPanel store={store} ghosts={createGhostStore(store)} selection={{ workflows: ['daily'], picks: [{ kind: 'step', id: 'fetch' }] }} />
  </LiveStoreProvider>);
  fireEvent.click(screen.getByRole('tab', { name: tab }));
  return store;
}

describe('ProcessorTab', () => {
  it('the processor, then the three schemas one under another; no In/Out/Config or Clear buttons', () => {
    setup();
    expect(screen.getByLabelText('Name')).toHaveValue('proc');
    expect(screen.getByText('Input schema · in 1.0.0')).toBeInTheDocument();
    expect(screen.getByText('definition not loaded')).toBeInTheDocument();
    expect(screen.queryByLabelText('Input schema definition')).toBeNull();
    expect(screen.getByText('Output schema').nextSibling).toHaveTextContent('none');
    expect(screen.getByText('Config schema · cfg 1.0.0')).toBeInTheDocument();
    expect(screen.getByLabelText('Config schema definition')).toHaveValue(prettyJson(REQUIRED));
    expect(prettyJson(REQUIRED)).toContain('\n  "type": "object",\n');
    for (const name of [/^In$/, /^Out$/, /^Config$/, /^Clear/]) expect(screen.queryByRole('button', { name })).toBeNull();
  });
  it('each schema has its own show all, sharing the one toggle', () => {
    setup();
    const toggles = screen.getAllByRole('button', { name: '▸ show all' });
    expect(toggles).toHaveLength(3); // the processor, in, cfg
    fireEvent.click(toggles[0]!);
    expect(screen.getAllByRole('button', { name: '▾ hide details' })).toHaveLength(3);
    expect(screen.getAllByText('Created by').map((e) => e.nextSibling?.textContent)).toEqual(['—', 'katan', 'katan']);
  });
  it('typing the processor name is one undo step', () => {
    const store = setup();
    const input = screen.getByLabelText('Name');
    fireEvent.change(input, { target: { value: 'p' } });
    fireEvent.change(input, { target: { value: 'pr' } });
    expect(store.state().processors.p1!.name).toBe('pr');
    store.undo();
    expect(store.state().processors.p1!.name).toBe('proc');
    expect(store.canUndo()).toBe(false);
  });
  it('the definition retyped as the same JSON is no edit', () => {
    const store = setup();
    fireEvent.change(screen.getByLabelText('Config schema definition'), { target: { value: '{ "type" : "object", "required": ["k"] }' } });
    expect(store.state().processors.p1!.configSchemaId).toBe('s-cfg');
    expect(store.unsaved().size).toBe(0);
  });
  it('a definition edit makes one copy, edits it in place after', () => {
    const store = setup();
    fireEvent.change(screen.getByLabelText('Config schema definition'), { target: { value: '{"type":"object"}' } });
    const copyId = store.state().processors.p1!.configSchemaId!;
    expect(copyId).not.toBe('s-cfg');
    expect(store.state().schemas[copyId]).toMatchObject({ definition: '{"type":"object"}', updatedAt: null });
    expect(store.state().schemas['s-cfg']!.definition).toBe(REQUIRED);
    fireEvent.change(screen.getByLabelText('Config schema definition'), { target: { value: '{"type":"object","x":1}' } });
    expect(store.state().processors.p1!.configSchemaId).toBe(copyId);
    expect(Object.keys(store.state().schemas)).toHaveLength(3);
    expect(screen.getByText('Config schema · cfg 1.0.0')).toBeInTheDocument();
  });
  it('the schema name edits the copy too', () => {
    const store = setup();
    fireEvent.change(screen.getByLabelText('Config schema name'), { target: { value: 'renamed' } });
    expect(store.state().schemas[store.state().processors.p1!.configSchemaId!]!.name).toBe('renamed');
  });
  it('the payload is checked against the config schema, in the workflow tab', () => {
    const store = setup('daily');
    expect(document.querySelector('.in-problem')).not.toBeNull(); // '{}' lacks the required key
    act(() => store.edit((b) => setPayload(b, 'daily', 'fetch', '{"k":1}', () => 'n')));
    expect(document.querySelector('.in-problem')).toBeNull();
    expect(screen.getByText('✓ checked against cfg 1.0.0; Save checks it again')).toBeInTheDocument();
  });
});
