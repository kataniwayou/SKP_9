import { describe, expect, it } from 'vitest';
import { cacheDto, graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { CACHE_H, LAYOUT_GAP, PMID, SPHERE_R, STEP_H, STEP_W } from '../layout/geometry';
import { applyDesign } from './apply';
import { arrowsOf, autoConnect, autoTarget } from './autoConnect';
import { EMPTY_EDITS } from './design';
import { circuitOf, EMPTY_DRAFT, type Draft } from './draft';
import { dropTool } from './toolDrop';

// s1 (entry) -> s2; s3 a second entry step, its output free. s1 at (352, 320), s2 (704, 320), s3 (352, 32).
const three = () => loadedDocument(graphDto({
  workflow: workflowDto({ entryStepIds: ['s1', 's3'], cacheIds: ['k1'] }),
  steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2'), stepDto('s3')],
  caches: [cacheDto('k1')],
}));
let n = 0;
const ids = () => `n${++n}`;
const gap = STEP_W + LAYOUT_GAP;

/** `three` with an empty step e1 from the Toolbox far away (no wires: every arrow shows). */
async function withLone() {
  const base = await three();
  const r = dropTool(base, EMPTY_EDITS, EMPTY_DRAFT, { kind: 'step' }, { x: 2000, y: 1200 }, () => 'e1')!;
  return { base, draft: r.draft };
}
const shownOf = (base: Awaited<ReturnType<typeof three>>, draft: Draft) => applyDesign(base, draft, EMPTY_EDITS);

describe('which arrows a block shows (Visio: a side with a wire shows none)', () => {
  it('a step: right only with its output free, left only with its input free, up and down always', async () => {
    const base = await three();
    const c = circuitOf(base, EMPTY_DRAFT);
    expect(arrowsOf(base, c, 's1')).toEqual(['up', 'down']);
    expect(arrowsOf(base, c, 's2')).toEqual(['right', 'up', 'down']);
    const { draft } = await withLone();
    expect(arrowsOf(shownOf(base, draft), circuitOf(shownOf(base, draft), draft), 'e1')).toEqual(['right', 'left', 'up', 'down']);
  });

  it('the hub: its right arrow only while it has no tail; a cache: none', async () => {
    const base = await three();
    expect(arrowsOf(base, circuitOf(base, EMPTY_DRAFT), 'wf')).toEqual([]);
    expect(arrowsOf(base, circuitOf(base, EMPTY_DRAFT), 'cache:k1')).toEqual([]);
    const empty = await loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: [] }), steps: [] }));
    expect(arrowsOf(empty, circuitOf(empty, EMPTY_DRAFT), 'wf')).toEqual(['right']);
  });
});

describe('a click on an arrow (Visio, measured 2026-10-22)', () => {
  it('right, on an empty spot: a new empty step one gap right, level; a wire from the output into it; picked; one draft', async () => {
    const base = await three();
    const s2 = base.placement.steps.get('s2')!;
    const r = autoConnect(base, EMPTY_EDITS, EMPTY_DRAFT, 's2', 'right', ids)!;
    const id = r.picks[0]!.id;
    const shown = shownOf(base, r.draft);
    expect(shown.placement.steps.get(id)).toEqual({ x: s2.x + gap, y: s2.y });
    expect(shown.graph.steps.get(id)!.processorId).toBeNull();
    expect(shown.graph.steps.get('s2')!.nextStepIds).toEqual([id]);
    expect(r.picks).toEqual([{ kind: 'node', id }]);
  });

  it('down and up: one gap below or above, in the column, wired from the output', async () => {
    const base = await three();
    const s2 = base.placement.steps.get('s2')!;
    const d = autoConnect(base, EMPTY_EDITS, EMPTY_DRAFT, 's2', 'down', ids)!;
    expect(shownOf(base, d.draft).placement.steps.get(d.picks[0]!.id)).toEqual({ x: s2.x, y: s2.y + STEP_H + LAYOUT_GAP });
    const u = autoConnect(base, EMPTY_EDITS, EMPTY_DRAFT, 's2', 'up', ids)!;
    expect(shownOf(base, u.draft).placement.steps.get(u.picks[0]!.id)).toEqual({ x: s2.x, y: s2.y - STEP_H - LAYOUT_GAP });
    expect(shownOf(base, u.draft).graph.steps.get('s2')!.nextStepIds).toEqual([u.picks[0]!.id]);
  });

  it('left: one gap left, level; "the step before": the new step\'s output wired into the block\'s input', async () => {
    const { base, draft } = await withLone();
    const e1 = shownOf(base, draft).placement.steps.get('e1')!;
    const r = autoConnect(base, EMPTY_EDITS, draft, 'e1', 'left', ids)!;
    const id = r.picks[0]!.id;
    const shown = shownOf(base, r.draft);
    expect(shown.placement.steps.get(id)).toEqual({ x: e1.x - gap, y: e1.y });
    expect(shown.graph.steps.get(id)!.nextStepIds).toEqual(['e1']);
  });

  it("the hub's right arrow: one gap right of the ring, the processor middle level with its centre; the new step an entry", async () => {
    const empty = await loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: [] }), steps: [] }));
    const { cx, cy } = empty.placement.sphere;
    const r = autoConnect(empty, EMPTY_EDITS, EMPTY_DRAFT, 'wf', 'right', ids)!;
    const id = r.picks[0]!.id;
    const shown = shownOf(empty, r.draft);
    expect(shown.placement.steps.get(id)).toEqual({ x: cx + SPHERE_R + LAYOUT_GAP, y: cy - PMID });
    expect(shown.graph.workflow.entryStepIds).toEqual([id]);
  });

  it('a step on the spot (level or half off): no new step, the block wired to it; picks cleared', async () => {
    const base = await three();
    const s3 = base.placement.steps.get('s3')!;
    // s2 moved to s3's right-arrow spot, half a step lower
    const draft: Draft = { ...EMPTY_DRAFT, steps: { s2: { x: s3.x + gap, y: s3.y + STEP_H / 2 } } };
    const shown = shownOf(base, draft);
    expect(autoTarget(shown, circuitOf(base, draft), 's3', 'right')).toMatchObject({ kind: 'step', step: 's2', ok: true });
    const r = autoConnect(base, EMPTY_EDITS, draft, 's3', 'right', ids)!;
    expect(Object.keys(r.draft.blocks.steps)).toEqual([]);
    expect(shownOf(base, r.draft).graph.steps.get('s3')!.nextStepIds).toEqual(['s2']);
    expect(r.picks).toEqual([]);
  });

  it('a cache on the spot: refused, nothing happens', async () => {
    const base = await three();
    const s2 = base.placement.steps.get('s2')!;
    const draft: Draft = { ...EMPTY_DRAFT, caches: { k1: { x: s2.x + gap, y: s2.y + STEP_H - CACHE_H } } };
    expect(autoTarget(shownOf(base, draft), circuitOf(base, draft), 's2', 'right')).toEqual({ kind: 'blocked' });
    expect(autoConnect(base, EMPTY_EDITS, draft, 's2', 'right', ids)).toBeNull();
  });

  it('an arrow the block does not show does nothing (its side already has a wire)', async () => {
    const base = await three();
    expect(autoConnect(base, EMPTY_EDITS, EMPTY_DRAFT, 's1', 'right', ids)).toBeNull();
  });
});
