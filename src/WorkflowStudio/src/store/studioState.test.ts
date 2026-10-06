import { describe, expect, it } from 'vitest';
import type { StudioDocument } from '../app/document';
import { activeDocument, INITIAL_STATE, inspectorKey, reduce, type StudioAction, type StudioState } from './studioState';

const doc = {} as StudioDocument;
const run = (...actions: StudioAction[]): StudioState => actions.reduce(reduce, INITIAL_STATE);
const open = (workflowId: string): StudioAction => ({ type: 'open', workflowId, name: `wf-${workflowId}`, version: '1.0.0' });

describe('reduce', () => {
  it('opens a document as loading, activates it, and keeps the open order', () => {
    const state = run(open('a'), open('b'));
    expect(state.docs.map((d) => [d.workflowId, d.status.kind, d.name])).toEqual([['a', 'loading', 'wf-a'], ['b', 'loading', 'wf-b']]);
    expect(state.activeId).toBe('b');
  });

  it('opening a document that is already open only activates it', () => {
    const state = run(open('a'), open('b'), { type: 'select', workflowId: 'a', selection: { kind: 'workflow' } }, open('a'));
    expect(state.docs).toHaveLength(2);
    expect(state.activeId).toBe('a');
    expect(state.docs[0]!.selection).toEqual({ kind: 'workflow' });
  });

  it('records a load and a failure', () => {
    const state = run(open('a'), open('b'), { type: 'loaded', workflowId: 'a', doc }, { type: 'failed', workflowId: 'b', message: 'Not found.' });
    expect(state.docs[0]!.status).toEqual({ kind: 'ready', doc });
    expect(state.docs[1]!.status).toEqual({ kind: 'failed', message: 'Not found.' });
  });

  it('closing the active document activates the next one, else the previous, else none', () => {
    expect(run(open('a'), open('b'), open('c'), { type: 'activate', workflowId: 'b' }, { type: 'close', workflowId: 'b' }).activeId).toBe('c');
    expect(run(open('a'), open('b'), { type: 'close', workflowId: 'b' }).activeId).toBe('a');
    expect(run(open('a'), { type: 'close', workflowId: 'a' }).activeId).toBeNull();
  });

  it('closing another document keeps the active one', () => {
    const state = run(open('a'), open('b'), { type: 'close', workflowId: 'a' });
    expect(state.activeId).toBe('b');
    expect(state.docs.map((d) => d.workflowId)).toEqual(['b']);
  });

  it('keeps a selection per document', () => {
    const state = run(open('a'), open('b'),
      { type: 'select', workflowId: 'a', selection: { kind: 'step', stepId: 's1' } },
      { type: 'select', workflowId: 'b', selection: { kind: 'cache', cacheId: 'c1' } },
      { type: 'select', workflowId: 'b', selection: null });
    expect(state.docs.map((d) => d.selection)).toEqual([{ kind: 'step', stepId: 's1' }, null]);
  });

  it('returns the same state for an unknown id or an unchanged selection, so nothing re-renders', () => {
    const state = run(open('a'), { type: 'select', workflowId: 'a', selection: { kind: 'workflow' } });
    expect(reduce(state, { type: 'select', workflowId: 'zz', selection: null })).toBe(state);
    expect(reduce(state, { type: 'select', workflowId: 'a', selection: { kind: 'workflow' } })).toBe(state);
    expect(reduce(state, { type: 'close', workflowId: 'zz' })).toBe(state);
    expect(reduce(state, { type: 'activate', workflowId: 'a' })).toBe(state);
    expect(reduce(state, { type: 'loaded', workflowId: 'zz', doc })).toBe(state);
  });

  it('flips the shared show-all switch', () => {
    expect(run({ type: 'toggleDetails' }).showDetails).toBe(true);
    expect(run({ type: 'toggleDetails' }, { type: 'toggleDetails' }).showDetails).toBe(false);
  });
});

describe('activeDocument and inspectorKey', () => {
  it('follow the active document, its load and its selection', () => {
    const loading = run(open('a'));
    const loaded = reduce(loading, { type: 'loaded', workflowId: 'a', doc });
    const selected = reduce(loaded, { type: 'select', workflowId: 'a', selection: { kind: 'step', stepId: 's1' } });

    expect(activeDocument(INITIAL_STATE)).toBeNull();
    expect(activeDocument(selected)?.workflowId).toBe('a');
    expect(inspectorKey(INITIAL_STATE)).toBe('none');
    expect(new Set([inspectorKey(loading), inspectorKey(loaded), inspectorKey(selected)]).size).toBe(3);
    expect(inspectorKey(reduce(selected, { type: 'toggleDetails' }))).toBe(inspectorKey(selected));
  });
});
