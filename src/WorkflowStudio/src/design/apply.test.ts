import { describe, expect, it } from 'vitest';
import { assignmentDto, graphDto, processorDto, schemaDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { PMID, STEP_W } from '../layout/geometry';
import { addLoose, addWire, EMPTY_DRAFT, moveBlocks, removeWires, setShape } from './draft';
import { applyDesign, applyDraft } from './apply';
import { createAssignment, EMPTY_EDITS, removeAssignment, setField } from './design';

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

describe('applyDesign (plan 8 §3.1: what the canvas, the Inspector and the panels show)', () => {
  it('lays the entity edits over the base: names, an entry condition and its wire colour, a schema copy, assignments', async () => {
    const base = await loadedDocument(graphDto({
      steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2', { entryCondition: 1 })],
      processors: [processorDto('p1', { configSchemaId: 'sc1' })],
      schemas: [schemaDto('sc1')],
      assignments: [assignmentDto('a1', { stepId: 's2' })],
    }));
    let edits = setField(EMPTY_EDITS, { kind: 'step', id: 's2' }, stepDto('s2'), 'entryCondition', 2, () => 'x');
    edits = setField(edits, { kind: 'workflow' }, workflowDto(), 'name', 'renamed', () => 'x');
    edits = setField(edits, { kind: 'schema', processorId: 'p1', slot: 'config' }, schemaDto('sc1'), 'definition', '{"type":"string"}', () => 'copy1');
    edits = createAssignment(removeAssignment(edits, 's2', { id: 'a1', updatedAt: '' }), 's1', 'step-s1', 'n1');

    const shown = applyDesign(base, EMPTY_DRAFT, edits);

    expect(shown.graph.workflow.name).toBe('renamed');
    expect(shown.graph.steps.get('s2')!.entryCondition).toBe(2);
    expect(shown.wires.find((w) => w.id === 's1->s2')!.condition).toBe(2);
    expect(shown.graph.processors.get('p1')!.configSchemaId).toBe('copy1');
    expect(shown.graph.schemas.get('copy1')!.name).toBe('schema-sc1');
    expect(shown.graph.assignments.map((a) => a.id)).toEqual(['n1']);
    expect(base.graph.workflow.name).toBe('orders'); // the base is untouched
  });

  it('gives back the base itself when nothing is designed', async () => {
    const base = await loadedDocument();
    expect(applyDesign(base, EMPTY_DRAFT, EMPTY_EDITS)).toBe(base);
  });

  it('routes a loose wire from the port of its source to its open end, and drops one whose source is not on the canvas', async () => {
    const base = await loadedDocument(graphDto({ steps: [stepDto('s1')] }));
    const at = base.placement.steps.get('s1')!;
    const draft = addLoose(addLoose(EMPTY_DRAFT, 'l1', 's1', { x: at.x + 600, y: at.y + 240 }), 'l2', 'gone', { x: 0, y: 0 });

    const shown = applyDesign(base, draft, EMPTY_EDITS);

    expect(shown.loose.map((l) => l.id)).toEqual(['l1']);
    const pts = shown.loose[0]!.points;
    expect(pts[0]).toEqual([at.x + STEP_W, at.y + PMID]);
    expect(pts[pts.length - 1]).toEqual([at.x + 600, at.y + 240]);
    expect(shown.graph.steps.get('s1')!.nextStepIds).toEqual([]); // never part of the wiring
  });
});
