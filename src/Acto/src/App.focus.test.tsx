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
import { boardApi } from './board/testApi';
import { liveStub } from './test/liveStub';
import { memoryStorage } from './test/memoryStorage';
import { chatSettled, scriptedAi, sendChat, toolCall } from './test/scriptedAi';

/** The centre of a node as React Flow draws it (absolute position from its transform, size from its style). */
function centreOf(el: HTMLElement): { x: number; y: number } {
  const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(el.style.transform)!;
  return { x: Number(m[1]) + parseFloat(el.style.width) / 2, y: Number(m[2]) + parseFloat(el.style.height) / 2 };
}

const OLD = ['rf__node-wf:daily', 'rf__node-wf:hourly'];
/** The triangles the chat made. */
const made = () => [...document.querySelectorAll<HTMLElement>('[data-testid^="rf__node-wf:"]')].filter((f) => !OLD.includes(f.dataset.testid!));

function renderApp(api: StudioApi, aiFetch: ReturnType<typeof scriptedAi>) {
  render(<App api={api} live={liveStub()} storage={memoryStorage()} session={memoryStorage()} aiFetch={aiFetch as unknown as typeof fetch} />);
}

afterEach(() => setCenter.mockClear());

describe('App chat: the board follows what the chat changed', () => {
  it('new_workflow pans the board to the new triangle (Must 2)', async () => {
    renderApp(boardApi(), scriptedAi([toolCall(0, 'c1', 'new_workflow', {})]));
    expect(await screen.findByText('Board loaded: 2 workflows')).toBeInTheDocument();
    await sendChat('make a workflow');
    await chatSettled();
    await waitFor(() => expect(made()).toHaveLength(1));
    await waitFor(() => expect(made()[0]!.style.transform).not.toBe(''));
    const c = centreOf(made()[0]!);
    expect(setCenter).toHaveBeenCalledWith(c.x, c.y, expect.objectContaining({ duration: 300 }));
  });

  it('two new_workflow calls in one answer get two different spots (Must 2)', async () => {
    renderApp(boardApi(), scriptedAi([toolCall(0, 'c1', 'new_workflow', {}), toolCall(1, 'c2', 'new_workflow', {})]));
    expect(await screen.findByText('Board loaded: 2 workflows')).toBeInTheDocument();
    await sendChat('make two');
    await chatSettled();
    await waitFor(() => expect(made()).toHaveLength(2));
    await waitFor(() => expect(made().every((f) => f.style.transform !== '')).toBe(true));
    expect(made()[0]!.style.transform).not.toBe(made()[1]!.style.transform);
  });
});
