import { describe, expect, it } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { canWire, dropLabel, canJoin } from './rules';
import { applyDraft } from './apply';
import { setShape, EMPTY_DRAFT } from './draft';

const chain = () => loadedDocument(graphDto({
  workflow: workflowDto({ entryStepIds: ['s1'] }),
  steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2', { nextStepIds: ['s3'] }), stepDto('s3')],
}));

describe('canWire', () => {
  it('allows a new forward wire and an entry wire', async () => {
    const doc = await chain();
    expect(canWire(doc, 's1', 's3')).toBe('ok');
    expect(canWire(doc, 'wf', 's2')).toBe('ok');
  });

  it('refuses a self-loop, a duplicate, a cycle and a drop on no step', async () => {
    const doc = await chain();
    expect(canWire(doc, 's2', 's2')).toBe('self');
    expect(canWire(doc, 's1', 's2')).toBe('duplicate');
    expect(canWire(doc, 'wf', 's1')).toBe('duplicate');
    expect(canWire(doc, 's3', 's1')).toBe('cycle');
    expect(canWire(doc, 's1', 'wf')).toBe('notStep');
    expect(canWire(doc, 's1', 'nowhere')).toBe('notStep');
  });

  it('judges a moved wire without itself: dropping it back where it was is allowed', async () => {
    const doc = await chain();
    expect(canWire(doc, 's1', 's2', 's1->s2')).toBe('ok');
    expect(canWire(doc, 's2', 's1', 's2->s3')).toBe('cycle');
  });
});

describe('dropLabel', () => {
  it('says why a drop is refused, and what an allowed drop does', () => {
    expect(dropLabel('cycle', false)).toBe('would make a loop');
    expect(dropLabel('duplicate', false)).toBe('already wired');
    expect(dropLabel('self', true)).toBe('same step');
    expect(dropLabel('notStep', false)).toBe('not a step');
    expect(dropLabel('ok', false)).toBe('re-attach here');
    expect(dropLabel('ok', true)).toBe('connect here');
  });
});

describe('canJoin (plan 7)', () => {
  const four = () => loadedDocument(graphDto({
    workflow: workflowDto({ entryStepIds: ['s1', 's3'] }),
    steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2', { entryCondition: 2 }), stepDto('s3', { nextStepIds: ['s4', 's5'] }), stepDto('s4', { entryCondition: 2 }), stepDto('s5', { entryCondition: 1 })],
  }));

  it('allows the same colour, refuses another colour and the wire itself', async () => {
    const doc = await four();
    expect(canJoin(doc, 's3->s4', 's1->s2')).toBe('ok');
    expect(canJoin(doc, 's3->s5', 's1->s2')).toBe('colour');
    expect(canJoin(doc, 's1->s2', 's1->s2')).toBe('sameWire');
  });

  it('refuses a join that would loop back through hosts', async () => {
    const saved = await four();
    const doc = applyDraft(saved, setShape(EMPTY_DRAFT, 's1->s2', { bends: null, landing: null, contact: { host: 's3->s4', at: 24 } }));
    expect(canJoin(doc, 's3->s4', 's1->s2')).toBe('loop');
  });

  it('labels each verdict', () => {
    expect(dropLabel('ok', false, true)).toBe('join here');
    expect(dropLabel('colour', false, true)).toBe('other colour');
    expect(dropLabel('sameWire', false, true)).toBe('same wire');
    expect(dropLabel('loop', false, true)).toBe('would make a loop');
    expect(dropLabel('start', false, true)).toBe('start stays on a block');
    expect(dropLabel('needStep', true, true)).toBe('drop on a step');
    expect(dropLabel('ok', false)).toBe('re-attach here');
  });
});
