import { describe, expect, it } from 'vitest';
import { cacheDto, graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { CACHE_H, CACHE_W, SPHERE_R } from '../layout/geometry';
import { applyDraft } from './apply';
import { EMPTY_DRAFT, setShape } from './draft';
import { blockAt, itemsInRect, rectOf, topLeftOf, wireAt } from './hit';

const two = () => loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: ['s1'] }), steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));

describe('hit', () => {
  it('a rectangle picks only blocks and wires lying wholly inside it', async () => {
    const doc = await two();
    const s1 = doc.placement.steps.get('s1')!;
    expect(itemsInRect(doc, rectOf({ x: s1.x - 8, y: s1.y - 8 }, { x: s1.x + 232, y: s1.y + 168 }))).toEqual([{ kind: 'node', id: 's1' }]);
    const all = itemsInRect(doc, rectOf({ x: -1e4, y: -1e4 }, { x: 1e4, y: 1e4 }));
    expect(all).toEqual(expect.arrayContaining([{ kind: 'node', id: 'wf' }, { kind: 'node', id: 's2' }, { kind: 'wire', id: 's1->s2' }, { kind: 'wire', id: 'wf->s1' }]));
  });

  it('finds the step or the hub under a point, and a block corner by node id', async () => {
    const doc = await two();
    const s2 = doc.placement.steps.get('s2')!;
    expect(blockAt(doc, { x: s2.x + 10, y: s2.y + 10 })).toBe('s2');
    expect(blockAt(doc, { x: doc.placement.sphere.cx, y: doc.placement.sphere.cy })).toBe('wf');
    expect(blockAt(doc, { x: -500, y: -500 })).toBeNull();
    expect(topLeftOf(doc, 'wf')).toEqual({ x: doc.placement.sphere.cx - 96, y: doc.placement.sphere.cy - 96 });
  });
});

describe('wireAt (plan 7)', () => {
  it('finds the wire line under a point within the tolerance, with the distance along it', async () => {
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
    const w = doc.wires.find((x) => x.id === 's1->s2')!;
    const [ax, ay] = w.points[0]!;
    const [bx] = w.points[1]!;
    const mid = { x: (ax + bx) / 2, y: ay + 3 };
    expect(wireAt(doc, mid, 6)).toEqual({ id: 's1->s2', at: (bx - ax) / 2 });
    expect(wireAt(doc, { x: mid.x, y: ay + 40 }, 6)).toBeNull();
    expect(wireAt(doc, mid, 6, { id: 's1->s2', side: 'head' })).toBeNull(); // a straight wire is all its end run
  });

  it('counts a dragged end\'s own wire, except its run at that end (plan 9; Review Focus 5)', async () => {
    const doc = await loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: ['s1'] }), steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
    const s2 = doc.placement.steps.get('s2')!;
    const shown = applyDraft(doc, setShape(EMPTY_DRAFT, doc, 's1->s2', { bends: { xs: [s2.x - 32], ys: [] }, landing: 128 }));
    const pts = shown.wires.find((w) => w.id === 's1->s2')!.points;
    const mid = (i: number) => ({ x: (pts[i]![0] + pts[i + 1]![0]) / 2, y: (pts[i]![1] + pts[i + 1]![1]) / 2 });
    const last = pts.length - 2;
    expect(wireAt(shown, mid(last), 2, { id: 's1->s2', side: 'head' })).toBeNull();
    expect(wireAt(shown, mid(0), 2, { id: 's1->s2', side: 'head' })?.id).toBe('s1->s2');
    expect(wireAt(shown, mid(0), 2, { id: 's1->s2', side: 'tail' })).toBeNull();
  });
});

describe('blockAt reach (plan 7, one drop reach)', () => {
  it('counts a point just outside a step or the hub only with a reach', async () => {
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1'), stepDto('s2')] }));
    const s1 = doc.placement.steps.get('s1')!;
    const left = { x: s1.x - 5, y: s1.y + 40 };
    expect(blockAt(doc, left)).toBeNull();
    expect(blockAt(doc, left, 8)).toBe('s1');
    const { cx, cy } = doc.placement.sphere;
    expect(blockAt(doc, { x: cx + SPHERE_R + 5, y: cy })).toBeNull();
    expect(blockAt(doc, { x: cx + SPHERE_R + 5, y: cy }, 8)).toBe('wf');
  });
});

describe('blockAt caches (plan 7, one hit test)', () => {
  it('names a cache node inside its box and within the reach, so a dragged end over it is refused out loud', async () => {
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1')], caches: [cacheDto('c1')] }));
    const c = doc.placement.caches.get('c1')!;
    expect(blockAt(doc, { x: c.x + CACHE_W / 2, y: c.y + CACHE_H / 2 })).toBe('cache:c1');
    expect(blockAt(doc, { x: c.x - 5, y: c.y + CACHE_H / 2 })).toBeNull();
    expect(blockAt(doc, { x: c.x - 5, y: c.y + CACHE_H / 2 }, 8)).toBe('cache:c1');
    expect(blockAt(doc, { x: c.x + CACHE_W + 5, y: c.y + CACHE_H + 5 }, 8)).toBe('cache:c1');
  });
});
