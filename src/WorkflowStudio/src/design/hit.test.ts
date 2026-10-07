import { describe, expect, it } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { blockAt, itemsInRect, rectOf, topLeftOf } from './hit';

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
