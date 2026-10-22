import { describe, expect, it } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { addCircuitWire, plainCircuit, setEnd, type Circuit } from '../circuit/circuit';
import { STEP_H, STEP_W } from '../layout/geometry';
import { judgeSplit, splitAt, splitLabel, splitTone, wireUnder } from './split';

// wf -> s1 -> s2 -> s3, and s4 -> s5 (s5 of family 2)
const doc = () => loadedDocument(graphDto({
  workflow: workflowDto({ entryStepIds: ['s1'] }),
  steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2', { nextStepIds: ['s3'] }), stepDto('s3'), stepDto('s4', { nextStepIds: ['s5'] }), stepDto('s5', { entryCondition: 2 })],
}));
type Doc = Awaited<ReturnType<typeof doc>>;
const circuitOfDoc = (d: Doc): Circuit => plainCircuit(d.graph.workflow.entryStepIds, d.graph.steps, (id) => d.placement.steps.has(id));

/** A step's box centred on the middle of the longest run of wire `id` as drawn. */
function boxOn(d: Doc, id: string) {
  const pts = d.wires.find((w) => w.id === id)!.points;
  let best = { x: 0, y: 0, len: -1 };
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1]!, [bx, by] = pts[i]!;
    const len = Math.hypot(bx - ax, by - ay);
    if (len > best.len) best = { x: (ax + bx) / 2, y: (ay + by) / 2, len };
  }
  return { x: best.x - STEP_W / 2, y: best.y - STEP_H / 2, w: STEP_W, h: STEP_H };
}

describe('the wire a step covers (plan 10 §4.6)', () => {
  it('finds the wire whose run the box covers; none on empty canvas', async () => {
    const d = await doc();
    const c = circuitOfDoc(d);
    expect(wireUnder(d, c, boxOn(d, 's1->s2'))).toBe('s1->s2');
    expect(wireUnder(d, c, { x: -5000, y: -5000, w: STEP_W, h: STEP_H })).toBeNull();
  });

  it('skips the wires on a step it is told to skip (the dragged step itself)', async () => {
    const d = await doc();
    const c = circuitOfDoc(d);
    expect(wireUnder(d, c, boxOn(d, 's1->s2'), 's1')).toBeNull();
  });
});

describe('judging a split (plan 10 §4.6)', () => {
  it('a wire with a direction and nothing joined on it: insert here', async () => {
    const d = await doc();
    expect(judgeSplit(d, circuitOfDoc(d), 's1->s2', 'n', 1)).toBe('insert');
    expect(splitLabel('insert')).toBe('insert here');
    expect(splitTone('insert')).toBe('ok');
  });

  it('refused: a wire with junctions on it (the step would sit among them)', async () => {
    const d = await doc();
    const c = setEnd(circuitOfDoc(d), 's2->s3', 'tail', { on: 'wire', host: 's1->s2', at: 40 });
    expect(judgeSplit(d, c, 's1->s2', 'n', 1)).toBe('junctionWire');
    expect(splitTone('junctionWire')).toBe('no');
  });

  it('refused: a direction-less wire', async () => {
    const d = await doc();
    const c = addCircuitWire(circuitOfDoc(d), 'w:f', { tail: { on: 'open', x: 0, y: 0 }, head: { on: 'open', x: 200, y: 0 } });
    expect(judgeSplit(d, c, 'w:f', 'n', 1)).toBe('noDirection');
  });

  it('refused: the new step brings a second family into a net (a short circuit)', async () => {
    const d = await doc();
    // a branch off s1 -> s2's line into s3: one net, family 1 (s2 and s3)
    const c = addCircuitWire(circuitOfDoc(d), 'w:b', { tail: { on: 'wire', host: 's1->s2', at: 40 }, head: { on: 'step', step: 's3', y: null } });
    // splitting the branch with a step of family 2 puts family 2 into the net of s1->s2 (family 1)
    expect(judgeSplit(d, c, 'w:b', 'n', 2)).toBe('short');
    expect(judgeSplit(d, c, 'w:b', 'n', 1)).toBe('insert');
    expect(splitLabel('short')).toBe('short circuit');
  });

  it('in a net shorted already (an Inspector edit), a split that brings no new family is let through, as judgeDrop does', async () => {
    const d = await doc();
    // s1 -> s2's net holds family 1 (s2) and family 2 (s5, by a branch); s3 feeds into its line by w:y
    let c = addCircuitWire(circuitOfDoc(d), 'w:x', { tail: { on: 'wire', host: 's1->s2', at: 40 }, head: { on: 'step', step: 's5', y: null } });
    c = addCircuitWire(c, 'w:y', { tail: { on: 'step', step: 's3', y: null }, head: { on: 'wire', host: 's1->s2', at: 80 } });
    expect(judgeSplit(d, c, 'w:y', 'n', 1)).toBe('insert');
  });

  it('splitAt: the covered wire and its verdict, or null', async () => {
    const d = await doc();
    const c = circuitOfDoc(d);
    expect(splitAt(d, c, boxOn(d, 's1->s2'), 'n', 1)).toEqual({ wire: 's1->s2', why: 'insert' });
    expect(splitAt(d, c, { x: -5000, y: -5000, w: STEP_W, h: STEP_H }, 'n', 1)).toBeNull();
  });
});
