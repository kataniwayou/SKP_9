import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cacheDto, processorDto, schemaDto } from '../api/fixtures';
import type { StudioApi } from '../api/client';
import { loadedDocument } from '../app/fixtures';
import { StudioActionsProvider, type StudioActions } from '../app/studioActions';
import { registerDropTarget, toolDrag } from '../design/toolDrag';
import { createStudioStore, StudioStoreProvider } from '../store/studioStore';
import { Toolbox } from './Toolbox';

const ok = <T,>(value: T) => Promise.resolve({ ok: true as const, value });

function setup(api: Partial<StudioApi>) {
  const store = createStudioStore();
  const actions = { service: {} as never, guard: (_: string, go: () => void) => go(), confirmDiscardDesign: () => undefined, api: api as StudioApi } as StudioActions;
  render(<StudioStoreProvider value={store}><StudioActionsProvider value={actions}><Toolbox /></StudioActionsProvider></StudioStoreProvider>);
  return store;
}

const lists = {
  listProcessors: () => ok([processorDto('p1', { name: 'fetcher' }), processorDto('p2', { name: 'parser', configSchemaId: 'sc' })]),
  listCaches: () => ok([cacheDto('k1', { name: 'rates', root: 'rates' })]),
  listSchemas: () => ok([schemaDto('sc')]),
};

afterEach(() => toolDrag.cancel());

describe('Toolbox (2026-10-11)', () => {
  it('lists the blocks, every processor drawn with its liveness ring, an empty cache and every cache; search filters them', async () => {
    setup(lists);
    expect(await screen.findByRole('button', { name: 'Drag processor fetcher 1.0.0' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Drag an empty step' })).toHaveAttribute('data-tool', 'step');
    expect(screen.getByRole('button', { name: 'Drag an undecided wire' })).toHaveAttribute('data-tool', 'wire');
    expect(screen.getByRole('button', { name: 'Drag an empty cache' })).toHaveAttribute('data-tool', 'newCache');
    expect(screen.getByRole('button', { name: 'Drag cache rates 1.0.0' })).toHaveAttribute('data-id', 'k1');
    // the processor image with its ring, its health (nothing known yet: undetermined)
    const proc = screen.getByRole('button', { name: 'Drag processor parser 1.0.0' });
    expect(proc.querySelector('[data-health]')).toHaveAttribute('data-health', 'undetermined');
    expect(proc.querySelector('.nx-spinner')).not.toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search the toolbox' }), { target: { value: 'pars' } });
    expect(screen.queryByRole('button', { name: 'Drag processor fetcher 1.0.0' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Drag processor parser 1.0.0' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Drag cache rates 1.0.0' })).toBeNull();
  });

  it('says so when BaseApi cannot list them', async () => {
    setup({ ...lists, listCaches: () => Promise.resolve({ ok: false as const, error: { kind: 'network' as const, message: 'down' } }) });
    expect(await screen.findByText(/Could not read the lists/)).toBeInTheDocument();
  });

  it('a tile pressed, moved over a canvas and let go drops it there (the store\'s toolDrop); off every canvas it does nothing', async () => {
    const store = setup(lists);
    const doc = await loadedDocument();
    store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
    store.dispatch({ type: 'loaded', workflowId: 'wf1', doc });
    // a canvas covering the page: the pointer at (500, 300) is over it, at flow (1000, 600)
    const el = document.createElement('div');
    document.body.appendChild(el);
    const unregister = registerDropTarget({ workflowId: 'wf1', el, shown: () => doc, toFlow: (c) => ({ x: c.x * 2, y: c.y * 2 }) });
    // jsdom has no layout: the element under a point is the canvas right of x 100
    const had = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn((x: number) => (x > 100 ? el : document.body)) });
    const spy = { mockRestore: () => { if (had) Object.defineProperty(document, 'elementFromPoint', had); else delete (document as unknown as Record<string, unknown>).elementFromPoint; } };
    try {
      const tile = await screen.findByRole('button', { name: 'Drag an empty step' });
      fireEvent.pointerDown(tile, { button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(window, { clientX: 500, clientY: 300 });
      expect(toolDrag.get()?.over?.verdict).toEqual({ kind: 'place' });
      fireEvent.pointerUp(window, { clientX: 500, clientY: 300 });
      await waitFor(() => expect(Object.values(store.getState().docs[0]!.design.draft.blocks.steps)).toHaveLength(1));
      expect(Object.values(store.getState().docs[0]!.design.draft.blocks.steps)[0]!.at).toEqual({ x: 888, y: 520 });
      // let go off every canvas: nothing
      fireEvent.pointerDown(tile, { button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerUp(window, { clientX: 20, clientY: 20 });
      expect(Object.values(store.getState().docs[0]!.design.draft.blocks.steps)).toHaveLength(1);
      // Escape cancels a drag in progress
      fireEvent.pointerDown(tile, { button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(window, { clientX: 500, clientY: 300 });
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(toolDrag.get()).toBeNull();
      fireEvent.pointerUp(window, { clientX: 500, clientY: 300 });
      expect(Object.values(store.getState().docs[0]!.design.draft.blocks.steps)).toHaveLength(1);
    } finally {
      spy.mockRestore();
      unregister();
      el.remove();
    }
  });

  it("the Wire tile shows Visio's crosshair while over a canvas, and the cursor comes back off it and on release (plan 10 phase 2)", async () => {
    setup(lists);
    const doc = await loadedDocument();
    const el = document.createElement('div');
    document.body.appendChild(el);
    const unregister = registerDropTarget({ workflowId: 'wf1', el, shown: () => doc, toFlow: (c) => ({ x: c.x * 2, y: c.y * 2 }) });
    const had = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn((x: number) => (x > 100 ? el : document.body)) });
    try {
      const tile = await screen.findByRole('button', { name: 'Drag an undecided wire' });
      fireEvent.pointerDown(tile, { button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(window, { clientX: 500, clientY: 300 });
      expect(document.body.classList.contains('tool-cross')).toBe(true);
      fireEvent.pointerMove(window, { clientX: 20, clientY: 20 });
      expect(document.body.classList.contains('tool-cross')).toBe(false);
      fireEvent.pointerMove(window, { clientX: 500, clientY: 300 });
      fireEvent.pointerUp(window, { clientX: 500, clientY: 300 });
      expect(document.body.classList.contains('tool-cross')).toBe(false);
      // a block tile never takes it
      fireEvent.pointerDown(await screen.findByRole('button', { name: 'Drag an empty step' }), { button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(window, { clientX: 500, clientY: 300 });
      expect(document.body.classList.contains('tool-cross')).toBe(false);
      fireEvent.keyDown(window, { key: 'Escape' });
    } finally {
      if (had) Object.defineProperty(document, 'elementFromPoint', had); else delete (document as unknown as Record<string, unknown>).elementFromPoint;
      unregister();
      el.remove();
    }
  });
});
