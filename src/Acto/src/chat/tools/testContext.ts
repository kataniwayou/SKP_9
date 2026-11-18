import { vi } from 'vitest';
import type { StudioApi } from '../../api/client';
import type { Pick } from '../../board/selection';
import { fakeApi } from '../../board/testApi';
import { board } from '../../design/boardFixtures';
import { createBoardStore } from '../../design/boardStore';
import { createOutputStore } from '../../output/outputStore';
import { liveStub } from '../../test/liveStub';
import { memoryStorage } from '../../test/memoryStorage';
import { runTool } from '../runTool';
import type { ToolContext, ToolOutcome } from '../toolTypes';
import '../tools';

/** Tests only: a tool context over the fixture board, with the page's picks kept in a variable. */
export function setup(live: ReturnType<typeof liveStub> = liveStub()) {
  const output = createOutputStore(null, () => '00:00:00');
  const store = createBoardStore(output, null);
  store.load(board());
  const api = fakeApi();
  Object.assign(api, {
    startWorkflow: vi.fn().mockResolvedValue({ ok: true, value: null }),
    stopWorkflow: vi.fn().mockResolvedValue({ ok: true, value: null }),
  });
  let n = 0;
  let picked: Pick[] = [];
  const focus = vi.fn();
  const ctx: ToolContext = {
    store, api: api as StudioApi, output, live,
    commands: { focus, setPicks: (p) => { picked = p; }, picks: () => picked, newWorkflowAt: () => ({ x: 700, y: 40 }) },
    processors: () => Object.values(store.state().processors), caches: () => [], session: memoryStorage(), newId: () => `n${++n}`,
  };
  return { ctx, live, api: api as unknown as Record<string, ReturnType<typeof vi.fn>>, store, output, focus };
}

export const call = (ctx: ToolContext, name: string, args: object = {}, answer?: string, pin?: string) =>
  runTool(ctx, { id: 'c', name, arguments: JSON.stringify(args) }, answer, pin);
export const done = (o: ToolOutcome) => { if (o.kind !== 'done') throw new Error('asked'); return o; };
