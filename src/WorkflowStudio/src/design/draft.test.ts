import { describe, expect, it } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import {
  addLoose, addWire, attachLoose, EMPTY_DRAFT, isEmptyDraft, loosen, moveBlocks, moveLoose, removeLoose, nextOf, entriesOf, parseDraft, reattach, removeWires, resetRoute, setShape, wireEnds, wireId,
  resourceLoose, shapeLoose, storedBends,
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

describe('loose wires (plan 8 §5)', () => {
  it('adds, moves, removes and reads back a loose wire; a malformed one is dropped', () => {
    let d = addLoose(EMPTY_DRAFT, 'l1', 's1', { x: 600, y: 80 });
    expect(d.loose['l1']).toEqual({ source: 's1', end: { x: 600, y: 80 } });
    expect(isEmptyDraft(d)).toBe(false);
    d = moveLoose(d, 'l1', { x: 640, y: 96 });
    expect(parseDraft(JSON.parse(JSON.stringify(d)))!.loose['l1']).toEqual({ source: 's1', end: { x: 640, y: 96 } });
    expect(parseDraft({ loose: { bad: { source: 7 }, worse: { source: 's1', end: { x: 'a', y: 1 } } } })!.loose).toEqual({});
    expect(removeLoose(d, ['l1']).loose).toEqual({});
  });

  it('a released head takes the wire out of the wiring, loose from its source; attached again it is an ordinary wire', async () => {
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2'), stepDto('s3')] }));
    const loose = loosen(EMPTY_DRAFT, doc, 's1->s2', 'l1', { x: 900, y: 400 });
    expect(loose.next['s1']).toEqual([]);
    expect(loose.loose['l1']).toEqual({ source: 's1', end: { x: 900, y: 400 } });
    const wired = attachLoose(loose, doc, 'l1', 's3');
    expect(wired.next['s1']).toEqual(['s3']);
    expect(wired.loose).toEqual({});
  });

  it('keeps a shape of its own (bends and end), read back from a session; a moved open end or a new source drops it (an end re-attached is automatic)', () => {
    const bends = { xs: [400, 520], ys: [200] };
    let d = shapeLoose(addLoose(EMPTY_DRAFT, 'l1', 's1', { x: 600, y: 80 }), 'l1', bends, { x: 600, y: 96 });
    expect(d.loose['l1']).toEqual({ source: 's1', end: { x: 600, y: 96 }, bends });
    expect(storedBends(d, 'loose:l1')).toEqual(bends);
    expect(parseDraft(JSON.parse(JSON.stringify(d)))!.loose['l1']).toEqual({ source: 's1', end: { x: 600, y: 96 }, bends });
    // malformed bends are dropped, the loose wire stays
    expect(parseDraft({ loose: { l1: { source: 's1', end: { x: 1, y: 2 }, bends: { xs: [1, 2], ys: [] } } } })!.loose['l1']).toEqual({ source: 's1', end: { x: 1, y: 2 } });
    expect(moveLoose(d, 'l1', { x: 640, y: 120 }).loose['l1']).toEqual({ source: 's1', end: { x: 640, y: 120 } });
    expect(resourceLoose(d, 'l1', 's2').loose['l1']).toEqual({ source: 's2', end: { x: 600, y: 96 } });
    expect(resourceLoose(d, 'gone', 's2')).toBe(d);
    // a straight shape is no shape
    d = shapeLoose(d, 'l1', null, { x: 600, y: 96 });
    expect(d.loose['l1']).toEqual({ source: 's1', end: { x: 600, y: 96 } });
    expect(storedBends(d, 'loose:l1')).toBeUndefined();
    expect(storedBends(setShape(EMPTY_DRAFT, 's1->s2', { bends, landing: null }), 's1->s2')).toEqual(bends);
  });
});
