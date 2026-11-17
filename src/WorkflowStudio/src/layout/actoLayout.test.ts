import { describe, expect, it } from 'vitest';
import { cacheDto, graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { EMPTY_DRAFT } from '../design/draft';
import { layoutOf } from '../design/layoutDesign';

// Written by Acto's layoutOf (src/Acto/src/design/request.ts, Acto commit 62cef351) for workflow a->b with step a
// moved to (120,80), step b to (520,200) and one linked cache c1. Spec §13/§14: a layout saved by Acto must still
// open in WorkflowStudio while the two run side by side.
const ACTO_LAYOUT = {
  v: 2,
  sphere: { x: -150, y: 126 },
  steps: { a: { x: 120, y: 80 }, b: { x: 520, y: 200 } },
  caches: { c1: { x: 28, y: 94 } },
  parked: ['a', 'b'],
  wires: {
    'wf->a': { tail: { on: 'hub', angle: null }, head: { on: 'step', step: 'a', y: null } },
    'a->b': { tail: { on: 'step', step: 'a', y: null }, head: { on: 'step', step: 'b', y: null } },
  },
  board: { x: 0, y: 0, w: 546, h: 196 },
};

const open = () => loadedDocument(graphDto({
  workflow: workflowDto({ entryStepIds: ['a'], cacheIds: ['c1'] }),
  steps: [stepDto('a', { nextStepIds: ['b'] }), stepDto('b')],
  caches: [cacheDto('c1')],
  layout: ACTO_LAYOUT,
} as never));

describe('a layout saved by Acto opens in WorkflowStudio', () => {
  it('places every step and the cache where Acto put them, and the sphere at layout.sphere (grid-snapped)', async () => {
    const doc = await open();
    expect(doc.placement.steps.get('a')).toMatchObject({ x: 120, y: 80 });
    expect(doc.placement.steps.get('b')).toMatchObject({ x: 520, y: 200 });
    // WorkflowStudio snaps a cache tag to its 8px grid (28,94 -> 32,96); it is still the tag's own place
    expect(doc.placement.caches.get('c1')).toMatchObject({ x: 32, y: 96 });
    expect(doc.placement.sphere).toMatchObject({ cx: -152, cy: 128 }); // likewise snapped to the grid from (-150,126)
  });

  it('draws wf->a and a->b', async () => {
    const doc = await open();
    expect(doc.wires.map((w) => w.id).sort()).toEqual(['a->b', 'wf->a']);
  });

  it('a save through layoutOf keeps board unchanged', async () => {
    const saved = layoutOf(await open(), EMPTY_DRAFT);
    expect(saved.board).toEqual(ACTO_LAYOUT.board);
    expect(saved.steps).toEqual(ACTO_LAYOUT.steps);
    expect(Object.keys(saved.wires).sort()).toEqual(['a->b', 'wf->a']);
  });
});
