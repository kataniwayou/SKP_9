import { describe, expect, it } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { addCircuitWire, moveWire, setEnd } from '../circuit/circuit';
import { applyDesign } from './apply';
import { EMPTY_EDITS, setField } from './design';
import { circuitOf, EMPTY_DRAFT, withCircuit } from './draft';
import { heldSourcesOf, isShortCircuitError, shortCircuitErrors } from './shortCircuits';

describe('shortCircuitErrors (plan 9 §2.2-7, §7)', () => {
  it('reports each net whose families disagree once, on a step of its last family', async () => {
    const base = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2', 's3'] }), stepDto('s2'), stepDto('s3', { entryCondition: 2 })],
    }));
    // s1 -> s3 taps s1 -> s2: one net that s2 (Completed) and s3 (Failed) decide
    const draft = withCircuit(EMPTY_DRAFT, base, setEnd(circuitOf(base, EMPTY_DRAFT), 's1->s3', 'tail', { on: 'wire', host: 's1->s2', at: 40 }));
    const errors = shortCircuitErrors(applyDesign(base, draft, EMPTY_EDITS), draft);
    expect(errors).toEqual([{ kind: 'step', id: 's3', stage: 'wires', field: null, message: 'short circuit: Completed meets Failed' }]);
    expect(isShortCircuitError(errors[0]!)).toBe(true);
    expect(isShortCircuitError({ kind: 'step', id: 's1', stage: 'steps', field: 'version', message: 'bad' })).toBe(false);
    expect(shortCircuitErrors(base, EMPTY_DRAFT)).toEqual([]);
  });

  it('an Inspector entry-condition edit that makes a net disagree is a short circuit; undoing it clears it (§2.2-7)', async () => {
    const base = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2', 's3'] }), stepDto('s2'), stepDto('s3')],
    }));
    const draft = withCircuit(EMPTY_DRAFT, base, setEnd(circuitOf(base, EMPTY_DRAFT), 's1->s3', 'tail', { on: 'wire', host: 's1->s2', at: 40 }));
    expect(shortCircuitErrors(applyDesign(base, draft, EMPTY_EDITS), draft)).toEqual([]);

    const edits = setField(EMPTY_EDITS, { kind: 'step', id: 's3' }, stepDto('s3'), 'entryCondition', 3, () => 'x');
    expect(shortCircuitErrors(applyDesign(base, draft, edits), draft)).toEqual([
      { kind: 'step', id: 's3', stage: 'wires', field: null, message: 'short circuit: Completed meets Cancelled' },
    ]);
  });

  it('heldSourcesOf: the steps and the hub whose tails feed a short-circuited net, none for an agreeing one', async () => {
    const base = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1', 's4'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2', 's3'] }), stepDto('s2'), stepDto('s3', { entryCondition: 2 }), stepDto('s4', { nextStepIds: ['s5'] }), stepDto('s5')],
    }));
    const plain = circuitOf(base, EMPTY_DRAFT);
    const draft = withCircuit(EMPTY_DRAFT, base, setEnd(plain, 's1->s3', 'tail', { on: 'wire', host: 's1->s2', at: 40 }));
    expect(heldSourcesOf(applyDesign(base, draft, EMPTY_EDITS), draft)).toEqual({ steps: new Set(['s1']), hub: false });
    expect(heldSourcesOf(base, EMPTY_DRAFT)).toEqual({ steps: new Set(), hub: false });
    // the hub's own wire tapped into a net of two families
    const hub = withCircuit(EMPTY_DRAFT, base, setEnd(plain, 's1->s3', 'tail', { on: 'wire', host: 'wf->s1', at: 40 }));
    expect(heldSourcesOf(applyDesign(base, hub, EMPTY_EDITS), hub)).toEqual({ steps: new Set(), hub: true });
  });
});

describe('overlap short circuits (the user\'s rule 2, 2026-10-09)', () => {
  const twoSteps = () => loadedDocument(graphDto({
    workflow: workflowDto({ entryStepIds: ['s1'] }),
    steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')],
  }));
  const open = { on: 'open', x: 0, y: 0 } as const;

  it('a both-open wire laid exactly on a live wire: one error naming both wires as the Inspector does; the live wire\'s source is held back', async () => {
    const base = await twoSteps();
    const host = base.wires.find((w) => w.id === 's1->s2')!.points;
    const c = moveWire(addCircuitWire(circuitOf(base, EMPTY_DRAFT), 'w:f', { tail: open, head: open }), 'w:f', host, () => null);
    const draft = withCircuit(EMPTY_DRAFT, base, c);
    const shown = applyDesign(base, draft, EMPTY_EDITS);
    const errors = shortCircuitErrors(shown, draft);
    expect(errors).toEqual([{
      kind: 'wire', id: 's1->s2', stage: 'wires', field: null,
      message: 'short circuit: step-s1_1.0.0-s1 → step-s2_1.0.0-s2 overlaps an open end → an open end',
    }]);
    expect(isShortCircuitError(errors[0]!)).toBe(true);
    expect(heldSourcesOf(shown, draft)).toEqual({ steps: new Set(['s1']), hub: false });
    // the shown lists leave the link through the shorted net out, as for any short circuit
    expect(shown.graph.steps.get('s1')!.nextStepIds).toEqual([]);
  });

  it('a wire crossing a live wire, or lying beside it, is no short circuit', async () => {
    const base = await twoSteps();
    const [a, b] = [base.wires.find((w) => w.id === 's1->s2')!.points[0]!, base.wires.find((w) => w.id === 's1->s2')!.points.at(-1)!];
    const mid = (a[0] + b[0]) / 2;
    const cross = moveWire(addCircuitWire(circuitOf(base, EMPTY_DRAFT), 'w:f', { tail: open, head: open }), 'w:f', [[mid - 16, a[1] - 40], [mid, a[1] - 40], [mid, a[1] + 40], [mid + 16, a[1] + 40]], () => null);
    const beside = moveWire(addCircuitWire(circuitOf(base, EMPTY_DRAFT), 'w:f', { tail: open, head: open }), 'w:f', [[a[0], a[1] + 8], [b[0], b[1] + 8]], () => null);
    for (const c of [cross, beside]) {
      const draft = withCircuit(EMPTY_DRAFT, base, c);
      const shown = applyDesign(base, draft, EMPTY_EDITS);
      expect(shortCircuitErrors(shown, draft)).toEqual([]);
      expect(heldSourcesOf(shown, draft)).toEqual({ steps: new Set(), hub: false });
    }
  });
});
