import { describe, expect, it } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { canWire, dropLabel } from './rules';

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
