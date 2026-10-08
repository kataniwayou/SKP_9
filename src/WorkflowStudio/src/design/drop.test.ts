import { describe, expect, it } from 'vitest';
import { cacheDto, graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { plainCircuit, setEnd, type Circuit } from '../circuit/circuit';
import { contactOn } from '../layout/circuitRoute';
import { SPHERE_R, STEP_W } from '../layout/geometry';
import { dropLabel, endOf, judgeDrop, pointOfTarget, targetOf, toneOf, type DropTarget, type Verdict } from './drop';

// s1 -> s2 -> s3 (Completed) and s4 -> s5 (Failed); entries s1, s4
const doc = () => loadedDocument(graphDto({
  workflow: workflowDto({ entryStepIds: ['s1', 's4'] }),
  steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2', { nextStepIds: ['s3'] }), stepDto('s3'), stepDto('s4', { nextStepIds: ['s5'] }), stepDto('s5', { entryCondition: 2 })],
  caches: [cacheDto('c1')],
}));
const circuitOfDoc = (d: Awaited<ReturnType<typeof doc>>): Circuit => plainCircuit(d.graph.workflow.entryStepIds, d.graph.steps, (id) => d.placement.steps.has(id));
const step = (id: string, side: 'in' | 'out', y = 96): DropTarget => ({ on: 'step', step: id, side, y });
const wire = (host: string, at = 40): DropTarget => ({ on: 'wire', host, at });

describe('judgeDrop (plan 9 §3, §4, §6)', () => {
  it('connects a head to a step\'s input and a tail to a step\'s output or the hub; anywhere else the end is open', async () => {
    const d = await doc(), c = circuitOfDoc(d);
    expect(judgeDrop(d, c, 's1->s2', 'head', step('s3', 'in'))).toBe('connect');
    expect(judgeDrop(d, c, 's2->s3', 'tail', step('s1', 'out'))).toBe('connect');
    expect(judgeDrop(d, c, 's2->s3', 'tail', { on: 'hub', angle: 270 })).toBe('connect');
    expect(judgeDrop(d, c, 's1->s2', 'head', { on: 'open', x: 0, y: 0 })).toBe('move');
  });

  it('refuses the wrong side, a head on the hub, and both ends on one step', async () => {
    const d = await doc(), c = circuitOfDoc(d);
    expect(judgeDrop(d, c, 's1->s2', 'head', step('s3', 'out'))).toBe('wrongSide');
    expect(judgeDrop(d, c, 's2->s3', 'tail', step('s1', 'in'))).toBe('wrongSide');
    expect(judgeDrop(d, c, 's1->s2', 'head', { on: 'hub', angle: 0 })).toBe('hubTail');
    expect(judgeDrop(d, c, 's1->s2', 'head', step('s1', 'in'))).toBe('sameStep');
  });

  it('allows a cycle through steps', async () => {
    const d = await doc(), c = circuitOfDoc(d);
    expect(judgeDrop(d, c, 's2->s3', 'head', step('s1', 'in'))).toBe('connect');
  });

  it('joins a wire of the same family; refuses its own wire and both ends on one wire', async () => {
    const d = await doc(), c = circuitOfDoc(d);
    expect(judgeDrop(d, c, 'wf->s1', 'tail', wire('s1->s2'))).toBe('sameStep');
    const tapped = setEnd(c, 's2->s3', 'tail', { on: 'wire', host: 's1->s2', at: 40 });
    expect(judgeDrop(d, c, 's2->s3', 'tail', wire('s1->s2'))).toBe('join');
    expect(judgeDrop(d, c, 's1->s2', 'head', wire('s1->s2'))).toBe('sameWire');
    expect(judgeDrop(d, tapped, 's2->s3', 'head', wire('s1->s2'))).toBe('sameWire');
  });

  it('refuses a step fed its own input through junctions (a hidden self-loop) as "same step"', async () => {
    const d = await doc(), c = circuitOfDoc(d);
    expect(judgeDrop(d, c, 's2->s3', 'head', wire('s1->s2'))).toBe('sameStep');
  });

  it('refuses a junction that closes a loop of wires as a short circuit', async () => {
    const d = await doc();
    const c = setEnd(circuitOfDoc(d), 's4->s5', 'head', { on: 'wire', host: 's1->s2', at: 40 });
    expect(judgeDrop(d, c, 's1->s2', 'head', wire('s4->s5'))).toBe('short');
  });

  it('refuses bringing two families together: a head of a decided net onto a step of another family, a tail onto a wire of another family', async () => {
    const d = await doc();
    const c = circuitOfDoc(d);
    // s2 -> s3 taps s1 -> s2: one net that s2 and s3 (Completed) decide
    const net = setEnd(c, 's2->s3', 'tail', { on: 'wire', host: 's1->s2', at: 40 });
    expect(judgeDrop(d, net, 's1->s2', 'head', step('s5', 'in'))).toBe('short');
    expect(judgeDrop(d, c, 's2->s3', 'tail', wire('s4->s5'))).toBe('short');
    // a lone wire's own head is its only decider: it may move to a step of another family
    expect(judgeDrop(d, c, 's1->s2', 'head', step('s5', 'in'))).toBe('connect');
  });

  describe('in a net already short-circuited (an Inspector edit, plan 9 §2.2-7)', () => {
    // s3 is Failed, s5 Cancelled: s2 -> s3 tapping s1 -> s2 makes a net of Completed (s2) and Failed (s3)
    const shorted = async () => {
      const d = await loadedDocument(graphDto({
        workflow: workflowDto({ entryStepIds: ['s1', 's4'] }),
        steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2', { nextStepIds: ['s3'] }), stepDto('s3', { entryCondition: 2 }), stepDto('s4', { nextStepIds: ['s5'] }), stepDto('s5', { entryCondition: 3 })],
      }));
      return { d, c: setEnd(circuitOfDoc(d), 's2->s3', 'tail', { on: 'wire', host: 's1->s2', at: 40 }) };
    };

    it('lets an end slide along its own side or its own host: no family is brought in', async () => {
      const { d, c } = await shorted();
      expect(judgeDrop(d, c, 's1->s2', 'head', step('s2', 'in', 120))).toBe('connect');
      expect(judgeDrop(d, c, 's1->s2', 'tail', step('s1', 'out', 40))).toBe('connect');
      expect(judgeDrop(d, c, 's2->s3', 'tail', wire('s1->s2', 56))).toBe('join');
      expect(judgeDrop(d, c, 's2->s3', 'head', step('s3', 'in', 120))).toBe('connect');
    });

    it('refuses a drop that brings it a further family', async () => {
      const { d, c } = await shorted();
      expect(judgeDrop(d, c, 's1->s2', 'head', step('s5', 'in'))).toBe('short');
    });

    it('refuses joining it to another net whose wires would gain a family', async () => {
      const d = await loadedDocument(graphDto({
        workflow: workflowDto({ entryStepIds: ['s1', 's4'] }),
        steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2', { nextStepIds: ['s3'] }), stepDto('s3', { entryCondition: 2 }), stepDto('s4', { nextStepIds: ['s5'] }), stepDto('s5')],
      }));
      const c = setEnd(circuitOfDoc(d), 's2->s3', 'tail', { on: 'wire', host: 's1->s2', at: 40 });
      // s4 -> s5 (Completed only) would take Failed too
      expect(judgeDrop(d, c, 's1->s2', 'tail', wire('s4->s5'))).toBe('short');
    });
  });

  it('labels and tones every verdict', () => {
    const all: Verdict[] = ['connect', 'join', 'move', 'wrongSide', 'sameStep', 'sameWire', 'short', 'hubTail'];
    expect(all.map(dropLabel)).toEqual(['connect here', 'join here', 'move here', 'wrong side', 'same step', 'same wire', 'short circuit', 'only a tail on the workflow']);
    expect(all.map(toneOf)).toEqual(['ok', 'ok', 'move', 'no', 'no', 'no', 'no', 'no']);
  });
});

describe('drop targets', () => {
  it('a step\'s half decides its side; the hub gives the angle round its ring; a cache or nothing leaves the end open; a line gives how far along', async () => {
    const d = await doc();
    const s2 = d.placement.steps.get('s2')!;
    const { cx, cy } = d.placement.sphere;
    expect(targetOf(d, { x: s2.x + 20, y: s2.y + 4 }, 's2', null)).toEqual({ on: 'step', step: 's2', side: 'in', y: 16 });
    expect(targetOf(d, { x: s2.x + STEP_W - 20, y: s2.y + 150 }, 's2', null)).toEqual({ on: 'step', step: 's2', side: 'out', y: 144 });
    expect(targetOf(d, { x: cx - 3, y: cy - 60 }, 'wf', null)).toEqual({ on: 'hub', angle: 270 });
    expect(targetOf(d, { x: 13, y: 21 }, 'cache:c1', null)).toEqual({ on: 'open', x: 16, y: 24 });
    expect(targetOf(d, { x: 13, y: 21 }, null, { id: 's1->s2', at: 37 })).toEqual({ on: 'wire', host: 's1->s2', at: 40 });
    expect(targetOf(d, { x: 13, y: 21 }, null, null)).toEqual({ on: 'open', x: 16, y: 24 });
  });

  it('draws a dragged end on the step side, on the ring, on the line, or where it is', async () => {
    const d = await doc();
    const s2 = d.placement.steps.get('s2')!;
    const { cx, cy } = d.placement.sphere;
    expect(pointOfTarget(d, step('s2', 'in'))).toEqual({ x: s2.x, y: s2.y + 96 });
    expect(pointOfTarget(d, step('s2', 'out'))).toEqual({ x: s2.x + STEP_W, y: s2.y + 96 });
    const top = pointOfTarget(d, { on: 'hub', angle: 270 });
    expect([Math.round(top.x), Math.round(top.y)]).toEqual([cx, cy - SPHERE_R]);
    const p = contactOn(d.wires.find((w) => w.id === 's1->s2')!.points, 40).p;
    expect(pointOfTarget(d, wire('s1->s2'))).toEqual({ x: p[0], y: p[1] });
    expect(endOf({ on: 'open', x: 8, y: 16 })).toEqual({ on: 'open', x: 8, y: 16 });
    expect(endOf(step('s2', 'in'))).toEqual({ on: 'step', step: 's2', y: 96 });
  });
});
