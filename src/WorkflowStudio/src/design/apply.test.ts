import { describe, expect, it } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { addWire, EMPTY_DRAFT, moveBlocks, removeWires, setShape } from './draft';
import { applyDraft } from './apply';

const chain = () => loadedDocument(graphDto({
  workflow: workflowDto({ entryStepIds: ['s1'] }),
  steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2', { nextStepIds: ['s3'] }), stepDto('s3')],
}));

describe('applyDraft', () => {
  it('returns the saved document itself for an empty draft', async () => {
    const saved = await chain();
    expect(applyDraft(saved, EMPTY_DRAFT)).toBe(saved);
  });

  it('draws moved blocks where the draft has them, and re-routes their wires', async () => {
    const saved = await chain();
    const s2 = saved.placement.steps.get('s2')!;
    const shown = applyDraft(saved, moveBlocks(EMPTY_DRAFT, saved, new Map([['s2', { x: s2.x, y: s2.y + 160 }]])));
    expect(shown.placement.steps.get('s2')).toEqual({ x: s2.x, y: s2.y + 160 });
    expect(shown.wires.find((w) => w.id === 's1->s2')!.points).not.toEqual(saved.wires.find((w) => w.id === 's1->s2')!.points);
  });

  it('parks a step nothing reaches any more, and what only it reached', async () => {
    const saved = await chain();
    const shown = applyDraft(saved, removeWires(EMPTY_DRAFT, saved, ['s1->s2']));
    expect(shown.parkedIds).toEqual(['s2', 's3']);
    expect(shown.wires.map((w) => w.id)).toEqual(['wf->s1', 's2->s3']);
    expect(saved.parkedIds).toEqual([]);
  });

  it('wires a new edge in, and a re-wired wire is not broken', async () => {
    const saved = await chain();
    const shown = applyDraft(saved, addWire(EMPTY_DRAFT, saved, 'wf', 's3'));
    expect(shown.graph.workflow.entryStepIds).toEqual(['s1', 's3']);
    expect(shown.wires.find((w) => w.id === 'wf->s3')!.broken).toBe(false);
  });

  it('ignores ids the saved document does not have (review focus 1)', async () => {
    const saved = await chain();
    const draft = {
      ...EMPTY_DRAFT,
      steps: { gone: { x: 0, y: 0 } },
      caches: { gone: { x: 0, y: 0 } },
      next: { gone: ['s1'], s1: ['s2', 'gone'] },
      entries: ['s1', 'gone'],
      routes: { 'gone->s1': { bends: null, landing: 80 } },
    };
    const shown = applyDraft(saved, draft);
    expect(shown.placement.steps.has('gone')).toBe(false);
    expect(shown.graph.steps.get('s1')!.nextStepIds).toEqual(['s2']);
    expect(shown.graph.workflow.entryStepIds).toEqual(['s1']);
    expect(shown.wires.map((w) => w.id)).toEqual(saved.wires.map((w) => w.id));
  });

  it('applies a manual shape by wire id', async () => {
    const saved = await chain();
    const w = saved.wires.find((x) => x.id === 's1->s2')!;
    const shown = applyDraft(saved, setShape(EMPTY_DRAFT, 's1->s2', { bends: null, landing: 128 }));
    const p = shown.placement.steps.get('s2')!;
    expect(shown.wires.find((x) => x.id === 's1->s2')!.points.at(-1)).toEqual([w.points.at(-1)![0], p.y + 128]);
  });
});
