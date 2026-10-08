import { describe, expect, it } from 'vitest';
import { graphDto, stepDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { parseLayout } from '../layout/layoutDoc';
import { applyDraft } from './apply';
import { storedDesignOf } from './design';
import { addLoose, EMPTY_DRAFT, setShape, shapeLoose } from './draft';
import { layoutOf } from './layoutDesign';

describe('layoutOf (plan 8 §4.2)', () => {
  it('writes every block where it is shown, every canvas step as parked, the shapes of wires that exist and the loose wires', async () => {
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
    const shaped = setShape(setShape(EMPTY_DRAFT, 's1->s2', { bends: null, landing: 40 }), 'gone->s2', { bends: null, landing: 8 });
    const draft = addLoose(shaped, 'l1', 's1', { x: 900, y: 64 });
    const shown = applyDraft(doc, draft);

    const layout = layoutOf(shown, draft);

    expect(layout.sphere).toEqual({ x: shown.placement.sphere.cx, y: shown.placement.sphere.cy });
    expect(Object.keys(layout.steps).sort()).toEqual(['s1', 's2']);
    expect([...layout.parked].sort()).toEqual(['s1', 's2']);
    expect(Object.keys(layout.routes)).toEqual(['s1->s2']);
    expect(layout.loose).toEqual({ l1: { source: 's1', end: { x: 900, y: 64 } } });
    // what it writes reads back: positions through the loader's parser, shapes through the stored design
    expect(parseLayout(JSON.parse(JSON.stringify(layout))).steps['s1']).toEqual(shown.placement.steps.get('s1'));
    expect(storedDesignOf(null, JSON.parse(JSON.stringify(layout))).draft.routes['s1->s2']).toEqual({ bends: null, landing: 40, contact: null });
  });

  it("writes a loose wire's own bends, and the stored design reads them back", async () => {
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1'), stepDto('s2')] }));
    const bends = { xs: [640, 720], ys: [400] };
    const draft = shapeLoose(addLoose(EMPTY_DRAFT, 'l1', 's1', { x: 900, y: 64 }), 'l1', bends, { x: 900, y: 64 });
    const layout = layoutOf(applyDraft(doc, draft), draft);
    expect(layout.loose).toEqual({ l1: { source: 's1', end: { x: 900, y: 64 }, bends } });
    expect(storedDesignOf(null, JSON.parse(JSON.stringify(layout))).draft.loose['l1']).toEqual({ source: 's1', end: { x: 900, y: 64 }, bends });
  });
});
