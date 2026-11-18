import { fireEvent, render, screen } from '@testing-library/react';
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

/** The Inspector on `fetch` with daily selected, `tab` opened. */
export function openOn(tab: string, picks: Pick[] = [{ kind: 'step', id: 'fetch' }], state: BoardState = withSchemas()) {
  const store = createBoardStore(createOutputStore(null, () => '00:00:00'), null);
  store.load(state);
  render(<LiveStoreProvider value={liveStub()}>
    <InspectorPanel store={store} ghosts={createGhostStore(store)} selection={{ workflows: ['daily'], picks }} />
  </LiveStoreProvider>);
  fireEvent.click(screen.getByRole('tab', { name: tab }));
  return store;
}
