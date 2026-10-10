import { describe, expect, it } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { buildDesignRequest } from '../app/saveDesign';
import { withPicks, selectionForPicks, DIE_SELECTED_CLASS } from '../canvas/selection';
import { createTextFitter } from '../canvas/fitText';
import { toFlow } from '../canvas/toFlow';
import { applyDesign } from './apply';
import { parseBlocks } from './blocks';
import { copyClip, deletePicked, pasteClip } from './clipboard';
import { EMPTY_EDITS, hasGraphChanges, storedDesignOf } from './design';
import { circuitOf, EMPTY_DRAFT, type Draft } from './draft';

/** wf -> s1 -> s2 -> s3, all on processor p1. */
const chain = () => loadedDocument(graphDto({
  workflow: workflowDto({ id: 'wf1', entryStepIds: ['s1'] }),
  steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2', { nextStepIds: ['s3'] }), stepDto('s3')],
}));
const proc = (id: string) => ({ kind: 'processor' as const, id });
const node = (id: string) => ({ kind: 'node' as const, id });
const ids = () => { let n = 0; return () => `n${++n}`; };

describe('Delete on a picked processor (2026-10-10): the step stops pointing at it, the processor entity stays', () => {
  it('the step stays with its wires and next steps; its processorId is null; the processor is still in the graph; the step is picked', async () => {
    const base = await chain();
    const pid = base.graph.steps.get('s2')!.processorId!;
    const r = deletePicked(base, EMPTY_EDITS, EMPTY_DRAFT, [proc('s2')])!;
    expect(r.draft.blocks.unassigned).toEqual(['s2']);
    const shown = applyDesign(base, r.draft, EMPTY_EDITS);
    expect(shown.graph.steps.get('s2')).toMatchObject({ processorId: null, nextStepIds: ['s3'] });
    expect(shown.graph.steps.get('s1')!.nextStepIds).toEqual(['s2']);
    expect(shown.graph.processors.has(pid)).toBe(true);
    expect(shown.graph.steps.get('s1')!.processorId).toBe(pid);
    expect(Object.keys(circuitOf(shown, r.draft)).sort()).toEqual(Object.keys(circuitOf(base, EMPTY_DRAFT)).sort());
    expect(r.picks).toEqual([node('s2')]);
    expect(hasGraphChanges({ draft: r.draft, edits: EMPTY_EDITS })).toBe(true);
  });

  it('several processors at once; mixed with a deleted step, a deleted step\'s processor is moot; a step already without one is nothing to do', async () => {
    const base = await chain();
    const r = deletePicked(base, EMPTY_EDITS, EMPTY_DRAFT, [proc('s1'), proc('s3'), node('s3')])!;
    expect(r.draft.blocks.unassigned).toEqual(['s1']);
    expect(r.draft.blocks.removed.steps).toEqual(['s3']);
    expect(deletePicked(base, EMPTY_EDITS, r.draft, [proc('s1')])).toBeNull();
  });

  it('a pasted step\'s processor goes from its own record; copied, a step without one pastes without one', async () => {
    const base = await chain();
    const pasted = pasteClip(base, EMPTY_EDITS, EMPTY_DRAFT, copyClip(base, EMPTY_EDITS, EMPTY_DRAFT, [node('s1')], 'wf1')!, ids(), 'wf1')!;
    const r = deletePicked(base, EMPTY_EDITS, pasted.draft, [proc('n1')])!;
    expect(r.draft.blocks.steps.n1!.processorId).toBeNull();
    expect(r.draft.blocks.unassigned).toEqual([]);
    const clip = copyClip(base, EMPTY_EDITS, r.draft, [node('n1')], 'wf1')!;
    expect(clip.steps[0]!.processorId).toBeNull();
    const again = pasteClip(base, EMPTY_EDITS, r.draft, clip, () => 'm1', 'wf1')!;
    expect(applyDesign(base, again.draft, EMPTY_EDITS).graph.steps.get('m1')!.processorId).toBeNull();
  });

  it('survives the session (parseBlocks) and the stored design a Save leaves (storedDesignOf)', async () => {
    const base = await chain();
    const r = deletePicked(base, EMPTY_EDITS, EMPTY_DRAFT, [proc('s2')])!;
    expect(parseBlocks(JSON.parse(JSON.stringify(r.draft.blocks))).unassigned).toEqual(['s2']);
    const shown = applyDesign(base, r.draft, EMPTY_EDITS);
    const req = buildDesignRequest(base, shown, { draft: r.draft, edits: EMPTY_EDITS });
    const back = storedDesignOf(JSON.parse(JSON.stringify({ ...req, layout: undefined })), req.layout);
    expect(back.draft.blocks.unassigned).toEqual(['s2']);
    expect(back.edits.steps.s2?.fields ?? {}).toEqual({});
  });
});

describe('Save sends the step with no processor; BaseApi refuses it on the step (the dry run fails)', () => {
  it('a workflow step: a step change with processorId null and its stamp; a pasted one: newSteps with processorId null', async () => {
    const base = await chain();
    let draft: Draft = deletePicked(base, EMPTY_EDITS, EMPTY_DRAFT, [proc('s2')])!.draft;
    draft = pasteClip(base, EMPTY_EDITS, draft, copyClip(base, EMPTY_EDITS, draft, [node('s2')], 'wf1')!, ids(), 'wf1')!.draft;
    const req = buildDesignRequest(base, applyDesign(base, draft, EMPTY_EDITS), { draft, edits: EMPTY_EDITS });
    expect(req.steps.find((s) => s.id === 's2')).toMatchObject({ updatedAt: base.graph.steps.get('s2')!.updatedAt, fields: { processorId: null } });
    expect(req.steps.find((s) => s.id === 's1')).toBeUndefined();
    expect(req.newSteps).toEqual([expect.objectContaining({ id: 'n1', processorId: null })]);
  });
});

describe('the step art without a processor', () => {
  it('toFlow gives no processor view for it', async () => {
    const base = await chain();
    const draft = deletePicked(base, EMPTY_EDITS, EMPTY_DRAFT, [proc('s2')])!.draft;
    const { nodes } = toFlow(applyDesign(base, draft, EMPTY_EDITS), createTextFitter((t) => t.length * 7));
    expect((nodes.find((n) => n.id === 's2')!.data as { processor: unknown }).processor).toBeNull();
    expect((nodes.find((n) => n.id === 's1')!.data as { processor: unknown }).processor).not.toBeNull();
  });
});

describe('the processor pick on the canvas', () => {
  it('marks its step\'s die (not the block), and one picked shows the processor in the Inspector', async () => {
    const base = await chain();
    const flow = toFlow(base, createTextFitter((t) => t.length * 7));
    const { nodes } = withPicks(flow.nodes, flow.edges, [proc('s2')]);
    const s2 = nodes.find((n) => n.id === 's2')!;
    expect(s2.className).toContain(DIE_SELECTED_CLASS);
    expect(s2.selected).toBe(false);
    expect(selectionForPicks([proc('s2')], null, base.graph)).toEqual({ kind: 'processor', processorId: base.graph.steps.get('s2')!.processorId, stepId: 's2' });
  });
});
