import { describe, expect, it } from 'vitest';
import { assignmentDto, graphDto, processorDto, schemaDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { addCircuitWire, setEnd } from '../circuit/circuit';
import { PMID, STEP_W } from '../layout/geometry';
import { circuitOf, EMPTY_DRAFT, moveBlocks, removeWires, setShape, withCircuit, type Draft } from './draft';
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
    const shown = applyDraft(saved, removeWires(EMPTY_DRAFT, saved, ['s1->s2'], () => null));
    expect(shown.parkedIds).toEqual(['s2', 's3']);
    expect(shown.wires.map((w) => w.id)).toEqual(['wf->s1', 's2->s3']);
    expect(saved.parkedIds).toEqual([]);
  });

  it('rewires the shown graph from the circuit: a tail junction fans out, a tail on the hub makes an entry step (plan 9 §7)', async () => {
    const saved = await chain();
    let shown = applyDraft(saved, withCircuit(EMPTY_DRAFT, saved, setEnd(circuitOf(saved, EMPTY_DRAFT), 's2->s3', 'tail', { on: 'wire', host: 's1->s2', at: 40 })));
    expect(shown.graph.steps.get('s1')!.nextStepIds).toEqual(['s2', 's3']);
    expect(shown.graph.steps.get('s2')!.nextStepIds).toEqual([]);
    shown = applyDraft(saved, withCircuit(EMPTY_DRAFT, saved, setEnd(circuitOf(saved, EMPTY_DRAFT), 's2->s3', 'tail', { on: 'hub', angle: 180 })));
    expect(shown.graph.workflow.entryStepIds).toEqual(['s1', 's3']);
    expect(shown.wires.find((w) => w.id === 's2->s3')).toMatchObject({ source: 'wf', tailOn: 'terminal' });
  });

  it('ignores ids the saved document does not have (review focus 1)', async () => {
    const saved = await chain();
    const draft: Draft = {
      ...EMPTY_DRAFT,
      steps: { gone: { x: 0, y: 0 } },
      caches: { gone: { x: 0, y: 0 } },
      wires: { ...circuitOf(saved, EMPTY_DRAFT), 'gone->s1': { tail: { on: 'step', step: 'gone', y: null }, head: { on: 'step', step: 's1', y: null } } },
    };
    const shown = applyDraft(saved, draft);
    expect(shown.placement.steps.has('gone')).toBe(false);
    expect(shown.graph.steps.get('s1')!.nextStepIds).toEqual(['s2']);
    expect(shown.graph.workflow.entryStepIds).toEqual(['s1']);
    expect(shown.wires.find((w) => w.id === 'gone->s1')!.tailOn).toBe('open');
  });

  it('applies a manual shape by wire id', async () => {
    const saved = await chain();
    const w = saved.wires.find((x) => x.id === 's1->s2')!;
    const shown = applyDraft(saved, setShape(EMPTY_DRAFT, saved, 's1->s2', { bends: null, landing: 128 }));
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

  it('draws a wire open at its head from its source\'s port to its open end, grey and dashed; it is never part of the wiring', async () => {
    const base = await loadedDocument(graphDto({ steps: [stepDto('s1')] }));
    const at = base.placement.steps.get('s1')!;
    const draft = withCircuit(EMPTY_DRAFT, base, addCircuitWire(circuitOf(base, EMPTY_DRAFT), 'w:l1', { tail: { on: 'step', step: 's1', y: null }, head: { on: 'open', x: at.x + 600, y: at.y + 240 } }));
    const shown = applyDesign(base, draft, EMPTY_EDITS);
    const l1 = shown.wires.find((w) => w.id === 'w:l1')!;
    expect(l1.points[0]).toEqual([at.x + STEP_W, at.y + PMID]);
    expect(l1.points.at(-1)).toEqual([at.x + 600, at.y + 240]);
    expect(l1).toMatchObject({ condition: null, solid: false, headOn: 'open' });
    expect(shown.graph.steps.get('s1')!.nextStepIds).toEqual([]);
  });
});
