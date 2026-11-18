import { fireEvent, render, screen, within } from '@testing-library/react';
import type { Pick } from '../../board/selection';
import type { BoardState } from '../../design/board';
import { board } from '../../design/boardFixtures';
import { createBoardStore } from '../../design/boardStore';
import { createGhostStore } from '../../design/ghosts';
import { LiveStoreProvider } from '../../live/LiveContext';
import { createOutputStore } from '../../output/outputStore';
import { liveStub } from '../../test/liveStub';
import { InspectorPanel } from '../InspectorPanel';

const T = '2026-11-01T00:00:00Z';
const audit = { createdAt: T, createdBy: 'katan', updatedAt: T, updatedBy: null };
export const REQUIRED = '{"type":"object","required":["k"]}';

/** board() with p1 holding an input schema (definition not read) and a config schema; no output schema. */
export function withSchemas(): BoardState {
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

/** A top Inspector tab by its label; a child tab of Step ("Step tabs") or of Processor ("Processor tabs"). */
export const topTab = (name: string) => within(screen.getByRole('tablist', { name: 'Inspector tabs' })).getByRole('tab', { name });
export const childTab = (row: 'Step' | 'Processor', name: string) => within(screen.getByRole('tablist', { name: `${row} tabs` })).getByRole('tab', { name });
export const childNames = (row: 'Step' | 'Processor') => {
  const l = screen.queryByRole('tablist', { name: `${row} tabs` });
  return l ? within(l).getAllByRole('tab').map((t) => t.textContent) : [];
};

const TOP = new Set(['Workflow', 'Step', 'Processor', 'Cache', 'Link', 'Deleted']);
const SCHEMA = new Set(['Input schema', 'Output schema', 'Config schema']);

/**
 * The Inspector on `fetch` with daily selected, `tab` opened: a top tab by its label, a schema label as Processor then
 * that child, any other label (a workflow's name) as Step then that assignment child.
 */
export function openOn(tab: string, picks: Pick[] = [{ kind: 'step', id: 'fetch' }], state: BoardState = withSchemas()) {
  const store = createBoardStore(createOutputStore(null, () => '00:00:00'), null);
  store.load(state);
  render(<LiveStoreProvider value={liveStub()}>
    <InspectorPanel store={store} ghosts={createGhostStore(store)} selection={{ workflows: [], picks: picks.length === 1 && picks[0]!.kind === 'step' ? [{ kind: 'workflow', id: 'daily' }, ...picks] : picks }} />
  </LiveStoreProvider>);
  if (TOP.has(tab)) fireEvent.click(topTab(tab));
  else if (SCHEMA.has(tab)) { fireEvent.click(topTab('Processor')); fireEvent.click(childTab('Processor', tab)); }
  else { fireEvent.click(topTab('Step')); fireEvent.click(childTab('Step', tab)); }
  return store;
}
