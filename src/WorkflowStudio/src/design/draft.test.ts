import { describe, expect, it } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import {
  addWire, EMPTY_DRAFT, isEmptyDraft, moveBlocks, nextOf, entriesOf, parseDraft, reattach, removeWires, resetRoute, setShape, wireEnds, wireId,
} from './draft';

const chain = () => loadedDocument(graphDto({
  workflow: workflowDto({ entryStepIds: ['s1'] }),
  steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2', { nextStepIds: ['s3'] }), stepDto('s3')],
}));

describe('draft', () => {
  it('names a wire by its ends and reads them back', () => {
    expect(wireId('wf', 's1')).toBe('wf->s1');
    expect(wireEnds('s1->s2')).toEqual({ source: 's1', target: 's2' });
  });

  it('moves the hub (by its centre), a cache and a step; a move back to the saved place leaves nothing', async () => {
    const saved = await chain();
    const s1 = saved.placement.steps.get('s1')!;
    let d = moveBlocks(EMPTY_DRAFT, saved, new Map([['wf', { x: 0, y: 8 }], ['cache:c1', { x: 16, y: 24 }], ['s1', { x: s1.x + 32, y: s1.y }]]));
    expect(d.sphere).toEqual({ x: 96, y: 104 });
    expect(d.caches).toEqual({ c1: { x: 16, y: 24 } });
    expect(d.steps).toEqual({ s1: { x: s1.x + 32, y: s1.y } });
    d = moveBlocks(d, saved, new Map([['s1', s1]]));
    expect(d.steps).toEqual({});
  });

  it('adds a wire from a step and from the hub, and removing it again leaves an empty draft', async () => {
    const saved = await chain();
    let d = addWire(EMPTY_DRAFT, saved, 's1', 's3');
    expect(nextOf(saved, d, 's1')).toEqual(['s2', 's3']);
    d = addWire(d, saved, 'wf', 's2');
    expect(entriesOf(saved, d)).toEqual(['s1', 's2']);
    d = removeWires(d, saved, ['s1->s3', 'wf->s2']);
    expect(isEmptyDraft(d)).toBe(true);
  });

  it('removing a wire drops its shape', async () => {
    const saved = await chain();
    let d = setShape(EMPTY_DRAFT, 's1->s2', { bends: { xs: [600], ys: [] }, landing: 80 });
    d = removeWires(d, saved, ['s1->s2']);
    expect(d.routes).toEqual({});
    expect(nextOf(saved, d, 's1')).toEqual([]);
  });

  it('re-attaches either end', async () => {
    const saved = await chain();
    const t = reattach(EMPTY_DRAFT, saved, 's1->s2', 'target', 's3');
    expect(nextOf(saved, t, 's1')).toEqual(['s3']);
    const s = reattach(EMPTY_DRAFT, saved, 's2->s3', 'source', 'wf');
    expect(nextOf(saved, s, 's2')).toEqual([]);
    expect(entriesOf(saved, s)).toEqual(['s1', 's3']);
  });

  it('a shape with nothing set is no shape; reset route forgets it', () => {
    expect(setShape(EMPTY_DRAFT, 'a->b', { bends: null, landing: null }).routes).toEqual({});
    const d = setShape(EMPTY_DRAFT, 'a->b', { bends: null, landing: 72 });
    expect(resetRoute(d, 'a->b').routes).toEqual({});
  });

  it('parses its own JSON and drops what is not its shape', () => {
    const d = setShape(addWire(EMPTY_DRAFT, { graph: { workflow: { entryStepIds: [] }, steps: new Map() } } as never, 'wf', 's1'), 'wf->s1', { bends: { xs: [8, 16], ys: [40] }, landing: null, contact: null });
    expect(parseDraft(JSON.parse(JSON.stringify(d)))).toEqual(d);
    expect(parseDraft('nope')).toBeNull();
    expect(parseDraft({ sphere: { x: 'a' }, steps: { s1: { x: 1, y: 2 }, s2: 5 }, next: { s1: ['s2', 3] }, routes: { 'a->b': { bends: { xs: [1], ys: [1] }, landing: null, contact: null } } }))
      .toEqual({ ...EMPTY_DRAFT, steps: { s1: { x: 1, y: 2 } }, next: { s1: ['s2'] } });
  });
});

describe('junction contacts in the draft', () => {
  it('keeps a shape that has only a contact, and drops one with nothing', () => {
    const d = setShape(EMPTY_DRAFT, 'a->b', { bends: null, landing: null, contact: { host: 'c->d', at: 40 } });
    expect(d.routes['a->b']).toEqual({ bends: null, landing: null, contact: { host: 'c->d', at: 40 } });
    expect(setShape(d, 'a->b', { bends: null, landing: null, contact: null }).routes['a->b']).toBeUndefined();
  });

  it('reads a contact back from the session and drops a malformed one', () => {
    const ok = parseDraft({ routes: { 'a->b': { bends: null, landing: null, contact: { host: 'c->d', at: 40 } } } })!;
    expect(ok.routes['a->b']!.contact).toEqual({ host: 'c->d', at: 40 });
    const bad = parseDraft({ routes: { 'a->b': { contact: { host: 7, at: 'x' } } } })!;
    expect(bad.routes['a->b']).toBeUndefined();
  });

  it('re-attaching a host moves the wires joined onto it to its new id', async () => {
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2'), stepDto('s3')] }));
    const joined = setShape(EMPTY_DRAFT, 'wf->s3', { bends: null, landing: null, contact: { host: 's1->s2', at: 40 } });
    const d = reattach(joined, doc, 's1->s2', 'target', 's3');
    expect(d.routes['wf->s3']!.contact).toEqual({ host: 's1->s3', at: 40 });
  });
});
