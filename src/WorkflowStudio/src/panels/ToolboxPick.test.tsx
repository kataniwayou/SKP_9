import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { cacheDto, graphDto, processorDto, schemaDto } from '../api/fixtures';
import type { StudioApi } from '../api/client';
import { loadedDocument } from '../app/fixtures';
import { StudioActionsProvider, type StudioActions } from '../app/studioActions';
import { createTextFitter } from '../canvas/fitText';
import { CacheView } from '../canvas/nodes/CacheNode';
import { cacheData, emptyItems } from '../canvas/toFlow';
import { toolDrag } from '../design/toolDrag';
import { INITIAL_STATE, reduce } from '../store/studioState';
import { createStudioStore, StudioStoreProvider } from '../store/studioStore';
import { cacheFromDto, processorFromDto } from '../api/toModel';
import { Inspector } from './Inspector';
import { Toolbox } from './Toolbox';
import { overlayCache, overlayProcessor } from './toolboxView';

const ok = <T,>(value: T) => Promise.resolve({ ok: true as const, value });
const lists = {
  listProcessors: () => ok([processorDto('p1', { name: 'fetcher' }), processorDto('p2', { name: 'parser', configSchemaId: 'sc' })]),
  listCaches: () => ok([cacheDto('k1', { name: 'rates', root: 'rates', items: '{"usd": "3.7"}' })]),
  listSchemas: () => ok([schemaDto('sc')]),
};
const fitter = createTextFitter((t) => t.length * 7);

/** The Toolbox and the Inspector side by side, as the dock shows them; `inspector: false` is the pane hidden (not rendered). */
function setup(inspector = true) {
  const store = createStudioStore();
  const actions = { service: { read: () => undefined } as never, guard: (_: string, go: () => void) => go(), confirmDiscardDesign: () => undefined, api: lists as unknown as StudioApi } as StudioActions;
  const view = render(
    <StudioStoreProvider value={store}><StudioActionsProvider value={actions}>
      <div data-testid="toolbox"><Toolbox /></div>
      {inspector && <div data-testid="inspector"><Inspector /></div>}
    </StudioActionsProvider></StudioStoreProvider>,
  );
  return { store, view };
}
/** A click: pressed and let go where it was (no drag). */
const click = (el: Element) => { fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 10 }); fireEvent.pointerUp(window, { clientX: 11, clientY: 10 }); };

afterEach(() => toolDrag.cancel());

describe('the Toolbox picks one processor or cache for the Inspector, read-only (2026-10-11)', () => {
  it('a click picks the tile (one at a time, highlighted); the Inspector shows it read-only; a template click picks nothing', async () => {
    const { store } = setup();
    const fetcher = await screen.findByRole('button', { name: 'Drag processor fetcher 1.0.0' });
    click(fetcher);
    expect(store.getState().toolboxPick).toMatchObject({ kind: 'processor', processor: { id: 'p1' } });
    expect(fetcher).toHaveClass('picked');
    const pane = within(screen.getByTestId('inspector'));
    expect(pane.getByText('PROCESSOR')).toBeInTheDocument();
    expect(pane.getByText(/From the Toolbox: read-only/)).toBeInTheDocument();
    expect(pane.queryAllByRole('textbox')).toHaveLength(0);
    // the cache: the other tile goes, this one is picked; its items as a read-only table
    const rates = screen.getByRole('button', { name: 'Drag cache rates 1.0.0' });
    click(rates);
    expect(rates).toHaveClass('picked');
    expect(fetcher).not.toHaveClass('picked');
    expect(pane.getByText('CACHE')).toBeInTheDocument();
    expect(pane.getByRole('textbox', { name: 'Key 1' })).toHaveAttribute('readonly');
    expect(pane.queryByRole('button', { name: /Add item/ })).toBeNull();
    // the same tile again keeps it (no toggle); a template picks nothing
    click(rates);
    expect(rates).toHaveClass('picked');
    click(screen.getByRole('button', { name: 'Drag an empty step' }));
    expect(store.getState().toolboxPick).toBeNull();
    expect(rates).not.toHaveClass('picked');
  });

  it('a hidden Inspector stays hidden, but what it shows switches: shown later, it is the last tile clicked', async () => {
    const { store, view } = setup(false);
    click(await screen.findByRole('button', { name: 'Drag processor parser 1.0.0' }));
    expect(screen.queryByTestId('inspector')).toBeNull();
    expect(store.getState().toolboxPick).toMatchObject({ kind: 'processor', processor: { id: 'p2' } });
    view.rerender(
      <StudioStoreProvider value={store}><StudioActionsProvider value={{ service: { read: () => undefined } as never, guard: (_: string, go: () => void) => go(), confirmDiscardDesign: () => undefined, api: lists as unknown as StudioApi } as StudioActions}>
        <div data-testid="inspector"><Inspector /></div>
      </StudioActionsProvider></StudioStoreProvider>,
    );
    expect(within(screen.getByTestId('inspector')).getByText('PROCESSOR')).toBeInTheDocument();
  });

  it('a click on a canvas (a selection or a pick there) or a drop takes the Inspector back from the Toolbox', () => {
    const pick = { kind: 'cache' as const, cache: cacheFromDto(cacheDto('k1')) };
    const s = reduce(INITIAL_STATE, { type: 'toolboxPick', pick });
    expect(s.toolboxPick).toBe(pick);
    expect(reduce(s, { type: 'select', workflowId: 'wf1', selection: null }).toolboxPick).toBeNull();
    expect(reduce(s, { type: 'pick', workflowId: 'wf1', picks: [] }).toolboxPick).toBeNull();
    expect(reduce(s, { type: 'toolDrop', workflowId: 'wf1', item: { kind: 'wire' }, at: { x: 0, y: 0 }, newId: () => 'x' }).toolboxPick).toBeNull();
    // a tab switch keeps it
    expect(reduce(s, { type: 'activate', workflowId: 'wf1' }).toolboxPick).toBe(pick);
  });
});

describe('an entity the active design changed is shown as that design has it, marked unsaved (2026-10-11)', () => {
  it('overlays name, version and items; the same items in another form or order are no change', async () => {
    const doc = await loadedDocument(graphDto({ caches: [cacheDto('k1', { name: 'rates', items: '{"a":"1","b":"2"}' })] }));
    const listed = cacheFromDto(cacheDto('k1', { name: 'rates', items: '{"b": "2", "a": "1"}' }));
    expect(overlayCache(listed, doc.graph).unsaved).toBe(false);
    const edited = { ...doc.graph, caches: new Map([['k1', { ...doc.graph.caches.get('k1')!, name: 'fx', items: '{}' }]]) };
    expect(overlayCache(listed, edited)).toMatchObject({ unsaved: true, value: { name: 'fx', items: '{}' } });
    expect(overlayCache(listed, null).unsaved).toBe(false);
    const p = processorFromDto(processorDto('p1', { name: 'fetcher' }));
    expect(overlayProcessor(p, { ...doc.graph, processors: new Map([['p1', { ...p, version: '2.0.0' }]]) })).toMatchObject({ unsaved: true, value: { version: '2.0.0' } });
  });

  it('the tile and the Toolbox-picked Inspector follow the active document\'s design edit, with the unsaved mark', async () => {
    const { store } = setup();
    const doc = await loadedDocument(graphDto({ caches: [cacheDto('k1', { name: 'rates', root: 'rates', items: '{"usd": "3.7"}' })] }));
    store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
    store.dispatch({ type: 'loaded', workflowId: 'wf1', doc });
    const tile = await screen.findByRole('button', { name: 'Drag cache rates 1.0.0' });
    expect(tile.querySelector('.tb-unsaved')).toBeNull();
    // the cache picked on the canvas and renamed in the Inspector (the design's edit)
    store.dispatch({ type: 'select', workflowId: 'wf1', selection: { kind: 'cache', cacheId: 'k1' } });
    store.dispatch({ type: 'editField', workflowId: 'wf1', key: 'name', value: 'fx', copyId: 'c1' });
    const renamed = await screen.findByRole('button', { name: 'Drag cache fx 1.0.0' });
    expect(renamed.querySelector('.tb-unsaved')).not.toBeNull();
    click(renamed);
    const pane = within(screen.getByTestId('inspector'));
    expect(pane.getByText('● unsaved changes')).toBeInTheDocument();
  });
});

describe('an empty cache is drawn with the empty step\'s dashed amber rectangle and ⚠ (2026-10-11)', () => {
  it('no items: the dashed rectangle instead of the honeycomb and the root plate; with an item: as usual', () => {
    expect([emptyItems('{}'), emptyItems(' '), emptyItems('{"a":"1"}'), emptyItems('not json'), emptyItems('[]')]).toEqual([true, true, false, false, false]);
    const empty = cacheFromDto(cacheDto('k1', { items: '{}' }));
    const { container, rerender } = render(<svg><CacheView {...cacheData(empty, fitter)} /></svg>);
    expect(container.querySelector('.cache-empty-line')).not.toBeNull();
    expect(container.querySelector('.cache-empty-line')).toHaveAttribute('fill', 'none');
    expect(container.querySelector('.nx-hex')).toBeNull();
    expect(container.querySelector('.nx-plate')).toBeNull();
    expect(container.querySelector('.cache-empty-mark')?.textContent).toBe('⚠');
    expect(container.querySelector('.nx-cl')).not.toBeNull();
    rerender(<svg><CacheView {...cacheData({ ...empty, items: '{"a":"1"}' }, fitter)} /></svg>);
    expect(container.querySelector('.cache-empty-line')).toBeNull();
    expect(container.querySelector('.cache-empty-mark')).toBeNull();
    expect(container.querySelector('.nx-hex')).not.toBeNull();
  });
});
