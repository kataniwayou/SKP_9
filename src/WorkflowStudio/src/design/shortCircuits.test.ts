import { describe, expect, it } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { setEnd } from '../circuit/circuit';
import { applyDesign } from './apply';
import { EMPTY_EDITS, setField } from './design';
import { circuitOf, EMPTY_DRAFT, withCircuit } from './draft';
import { isShortCircuitError, shortCircuitErrors, shortedSources } from './shortCircuits';

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

  it('shortedSources: the steps and the hub whose tails feed a short-circuited net, none for an agreeing one', async () => {
    const base = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1', 's4'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2', 's3'] }), stepDto('s2'), stepDto('s3', { entryCondition: 2 }), stepDto('s4', { nextStepIds: ['s5'] }), stepDto('s5')],
    }));
    const plain = circuitOf(base, EMPTY_DRAFT);
    const draft = withCircuit(EMPTY_DRAFT, base, setEnd(plain, 's1->s3', 'tail', { on: 'wire', host: 's1->s2', at: 40 }));
    expect(shortedSources(applyDesign(base, draft, EMPTY_EDITS), draft)).toEqual({ steps: new Set(['s1']), hub: false });
    expect(shortedSources(base, EMPTY_DRAFT)).toEqual({ steps: new Set(), hub: false });
    // the hub's own wire tapped into a net of two families
    const hub = withCircuit(EMPTY_DRAFT, base, setEnd(plain, 's1->s3', 'tail', { on: 'wire', host: 'wf->s1', at: 40 }));
    expect(shortedSources(applyDesign(base, hub, EMPTY_EDITS), hub)).toEqual({ steps: new Set(), hub: true });
  });
});
