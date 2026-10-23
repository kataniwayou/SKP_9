import { describe, expect, it } from 'vitest';
import { graphDto, processorDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { createStudioStore } from '../store/studioStore';
import type { OpenDocument } from '../store/studioState';
import { findCache, findProcessor, findStep, findWire, findWorkflow } from './resolve';

async function open(steps = [stepDto('s1', { name: 'fetch' }), stepDto('s2', { name: 'Parse', version: '2.0.0' })]) {
  const store = createStudioStore();
  store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
  store.dispatch({ type: 'loaded', workflowId: 'wf1', doc: await loadedDocument(graphDto({
    workflow: workflowDto({ entryStepIds: ['s1'] }),
    steps: steps.map((s, i) => (i === 0 ? { ...s, nextStepIds: steps.slice(1).map((n) => n.id!) } : s)), processors: [processorDto('p1')],
  })) });
  return { store, doc: (): OpenDocument => store.getState().docs[0]! };
}

describe('findStep', () => {
  it('finds a step by name (case-insensitive) or by id', async () => {
    const { doc } = await open();
    expect(findStep(doc(), 'fetch')).toEqual({ ok: true, value: 's1' });
    expect(findStep(doc(), 'PARSE')).toEqual({ ok: true, value: 's2' });
    expect(findStep(doc(), 's2')).toEqual({ ok: true, value: 's2' });
  });

  it('lists every step of one name with id and version, and says to ask the user', async () => {
    const { doc } = await open([stepDto('s1', { name: 'fetch' }), stepDto('s2', { name: 'fetch', version: '2.0.0' })]);
    expect(findStep(doc(), 'fetch')).toEqual({ ok: false, ambiguous: true, error: '2 steps are named fetch: fetch (id s1, version 1.0.0), fetch (id s2, version 2.0.0); ask the user which one' });
  });

  it('says which workflow lacks the step', async () => {
    const { doc } = await open();
    expect(findStep(doc(), 'nope')).toEqual({ ok: false, error: 'no step named nope in orders' });
  });

  it('does not find a step the draft deleted (the design as shown)', async () => {
    const { store, doc } = await open();
    store.dispatch({ type: 'pick', workflowId: 'wf1', picks: [{ kind: 'node', id: 's2' }] });
    store.dispatch({ type: 'deletePicks', workflowId: 'wf1' });
    expect(findStep(doc(), 'Parse').ok).toBe(false);
    expect(findStep(doc(), 'fetch').ok).toBe(true);
  });
});

describe('findWorkflow', () => {
  const list = [workflowDto({ id: 'a', name: 'feed', version: '1.0.0' }), workflowDto({ id: 'b', name: 'feed', version: '2.0.0' }), workflowDto({ id: 'c', name: 'solo', version: '1.0.0' })];

  it('picks the version when the ref is "name version"', () => {
    expect(findWorkflow(list, [], 'feed 1.0.0')).toEqual({ ok: true, value: 'a' });
    expect(findWorkflow(list, [], 'feed 2.0.0')).toEqual({ ok: true, value: 'b' });
  });

  it('takes a name, an id, and asks when a name has several versions', () => {
    expect(findWorkflow(list, [], 'solo')).toEqual({ ok: true, value: 'c' });
    expect(findWorkflow(list, [], 'b')).toEqual({ ok: true, value: 'b' });
    expect(findWorkflow(list, [], 'feed')).toEqual({ ok: false, ambiguous: true, error: '2 workflows are named feed: feed (id a, version 1.0.0), feed (id b, version 2.0.0); ask the user which one' });
  });

  it('finds a new workflow only the open documents know', async () => {
    const { doc } = await open();
    expect(findWorkflow([], [doc()], 'orders')).toEqual({ ok: true, value: 'wf1' });
    expect(findWorkflow([], [], 'orders')).toEqual({ ok: false, error: 'no workflow named orders' });
  });
});

describe('findProcessor and findCache', () => {
  it('resolve by name or id, and ask on a duplicate name', () => {
    const ps = [processorDto('p1', { name: 'fetcher' }), processorDto('p2', { name: 'fetcher', version: '2.0.0' }), processorDto('p3', { name: 'parser' })];
    expect(findProcessor(ps, 'parser')).toEqual({ ok: true, value: ps[2] });
    expect(findProcessor(ps, 'fetcher 2.0.0')).toEqual({ ok: true, value: ps[1] });
    expect(findProcessor(ps, 'fetcher').ok).toBe(false);
    expect(findCache([], 'x')).toEqual({ ok: false, error: 'no cache named x' });
  });
});

describe('findWire', () => {
  it('takes a wire id or "from -> to" by step names', async () => {
    const { doc } = await open();
    expect(findWire(doc(), 's1->s2')).toEqual({ ok: true, value: 's1->s2' });
    expect(findWire(doc(), 'fetch -> parse')).toEqual({ ok: true, value: 's1->s2' });
    expect(findWire(doc(), 'workflow → fetch').ok).toBe(true);
    expect(findWire(doc(), 'parse -> fetch')).toEqual({ ok: false, error: 'no wire from parse to fetch in orders' });
  });
});
