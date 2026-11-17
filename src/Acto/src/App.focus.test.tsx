import { createElement, type ComponentProps } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// the board's pan, as the chat's focus calls it: React Flow's instance with setCenter spied
const setCenter = vi.fn();
vi.mock('@xyflow/react', async (orig) => {
  const m = await orig<typeof import('@xyflow/react')>();
  type P = ComponentProps<typeof m.ReactFlow>;
  return { ...m, ReactFlow: (p: P) => createElement(m.ReactFlow, { ...p, onInit: (rf) => p.onInit?.({ ...rf, setCenter }) } as P) };
});

import { App } from './App';
import type { StudioApi } from './api/client';
import { processorDto } from './api/fixtures';
import { fakeApi, wf } from './board/testApi';
import { liveStub } from './test/liveStub';
import { memoryStorage } from './test/memoryStorage';
import { chatSettled, scriptedAi, sendChat, toolCall } from './test/scriptedAi';

/** The centre of a node as React Flow draws it (absolute position from its transform, size from its style). */
function centreOf(el: HTMLElement): { x: number; y: number } {
  const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(el.style.transform)!;
  return { x: Number(m[1]) + parseFloat(el.style.width) / 2, y: Number(m[2]) + parseFloat(el.style.height) / 2 };
}

const frames = () => [...document.querySelectorAll<HTMLElement>('[data-testid^="rf__node-wf:"]')];

function renderApp(api: StudioApi, aiFetch: ReturnType<typeof scriptedAi>) {
  render(<App api={api} live={liveStub()} storage={memoryStorage()} session={memoryStorage()} aiFetch={aiFetch as unknown as typeof fetch} />);
}

afterEach(() => setCenter.mockClear());

describe('App chat: the board follows what the chat changed', () => {
  it('new_workflow pans the board to the new frame (Must 2)', async () => {
    renderApp(fakeApi({ workflows: [wf('w1')] }), scriptedAi([toolCall(0, 'c1', 'new_workflow', {})]));
    expect(await screen.findByText('Board loaded: 1 workflow')).toBeInTheDocument();
    await sendChat('make a workflow');
    await chatSettled();
    await waitFor(() => expect(frames()).toHaveLength(2));
    const made = frames().find((f) => f.dataset.testid !== 'rf__node-wf:w1')!;
    const c = centreOf(made);
    expect(setCenter).toHaveBeenCalledWith(c.x, c.y, expect.objectContaining({ duration: 300 }));
  });

  it('two new_workflow calls in one answer get two different slots (Must 2)', async () => {
    renderApp(fakeApi({ workflows: [wf('w1')] }), scriptedAi([toolCall(0, 'c1', 'new_workflow', {}), toolCall(1, 'c2', 'new_workflow', {})]));
    expect(await screen.findByText('Board loaded: 1 workflow')).toBeInTheDocument();
    await sendChat('make two');
    await chatSettled();
    await waitFor(() => expect(frames()).toHaveLength(3));
    const made = frames().filter((f) => f.dataset.testid !== 'rf__node-wf:w1');
    expect(made[0]!.style.transform).not.toBe(made[1]!.style.transform);
  });

  it('add_step without x and y pans to the new step, not to the frame (Must 2)', async () => {
    const api = { ...fakeApi({ workflows: [wf('w1')] }), listProcessors: vi.fn().mockResolvedValue({ ok: true, value: [processorDto('p1', { name: 'Cruncher' })] }) } as StudioApi;
    renderApp(api, scriptedAi([toolCall(0, 'c1', 'add_step', { workflow_id: 'w1', processor_id: 'p1' })]));
    expect(await screen.findByText('Board loaded: 1 workflow')).toBeInTheDocument();
    expect((await screen.findAllByText('Cruncher')).length).toBeGreaterThan(0);
    await sendChat('add a cruncher');
    await chatSettled();
    const steps = () => [...document.querySelectorAll<HTMLElement>('[data-testid^="rf__node-st:w1:"]')];
    await waitFor(() => expect(steps()).toHaveLength(2));
    const added = steps().find((s) => s.dataset.testid !== 'rf__node-st:w1:s1')!;
    const c = centreOf(added);
    expect(setCenter).toHaveBeenLastCalledWith(c.x, c.y, expect.objectContaining({ duration: 300 }));
  });
});
