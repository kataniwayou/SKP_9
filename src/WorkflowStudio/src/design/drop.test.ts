import { describe, expect, it } from 'vitest';
import { cacheDto, graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { addCircuitWire, plainCircuit, setEnd, type Circuit } from '../circuit/circuit';
import { contactOn } from '../layout/circuitRoute';
import { SPHERE_R, STEP_W } from '../layout/geometry';
import { applyDrop, beforeDrop, dropLabel, endOf, judgeDrop, pointOfTarget, targetOf, toneOf, type DropTarget, type Verdict } from './drop';

// s1 -> s2 -> s3 (Completed) and s4 -> s5 (Failed); entries s1, s4
const doc = () => loadedDocument(graphDto({
  workflow: workflowDto({ entryStepIds: ['s1', 's4'] }),
  steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2', { nextStepIds: ['s3'] }), stepDto('s3'), stepDto('s4', { nextStepIds: ['s5'] }), stepDto('s5', { entryCondition: 2 })],
  caches: [cacheDto('c1')],
}));
const circuitOfDoc = (d: Awaited<ReturnType<typeof doc>>): Circuit => plainCircuit(d.graph.workflow.entryStepIds, d.graph.steps, (id) => d.placement.steps.has(id));
const step = (id: string, side: 'in' | 'out', y = 96): DropTarget => ({ on: 'step', step: id, side, y });
const wire = (host: string, at = 40): DropTarget => ({ on: 'wire', host, at });

describe('beforeDrop (final review M2)', () => {
  it('works the state before the drop out once per circuit and document: every move of one drag reuses it', async () => {
    const d = await doc(), c = circuitOfDoc(d);
    const first = beforeDrop(d, c);
    expect(beforeDrop(d, c)).toBe(first);
    expect(beforeDrop(d, setEnd(c, 's1->s2', 'head', { on: 'open', x: 0, y: 0 }))).not.toBe(first);
    expect(beforeDrop(await doc(), c)).not.toBe(first);
    expect(first.looped.size).toBe(0);
    expect(first.links.get('s1')).toEqual(['s2']);
  });
});

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
    const tapped = setEnd(c, 's2->s3', 'tail', { on: 'wire', host: 's1->s2', at: 40 });
    expect(judgeDrop(d, c, 's2->s3', 'tail', wire('s1->s2'))).toBe('join');
    expect(judgeDrop(d, c, 's1->s2', 'head', wire('s1->s2'))).toBe('sameWire');
    expect(judgeDrop(d, tapped, 's2->s3', 'head', wire('s1->s2'))).toBe('sameWire');
    expect(judgeDrop(d, c, 's1->s2', 'tail', wire('s1->s2'))).toBe('sameWire');
    const headOn = setEnd(c, 's4->s5', 'head', { on: 'wire', host: 's1->s2', at: 40 });
    expect(judgeDrop(d, headOn, 's4->s5', 'tail', wire('s1->s2', 80))).toBe('sameWire');
  });

  it('refuses a tail on the output of the step its own head is on', async () => {
    const d = await doc(), c = circuitOfDoc(d);
    expect(judgeDrop(d, c, 's1->s2', 'tail', step('s2', 'out'))).toBe('sameStep');
  });

  it('joins a head onto a wire of its family', async () => {
    const d = await doc(), c = circuitOfDoc(d);
    expect(judgeDrop(d, c, 'wf->s4', 'head', wire('s2->s3'))).toBe('join');
  });

  it('refuses a step fed its own input through junctions (a hidden self-loop) as "same step"', async () => {
    const d = await doc(), c = circuitOfDoc(d);
    expect(judgeDrop(d, c, 's2->s3', 'head', wire('s1->s2'))).toBe('sameStep');
    expect(judgeDrop(d, c, 'wf->s1', 'tail', wire('s1->s2'))).toBe('sameStep');
  });

  it('refuses a junction that closes a loop of wires as a short circuit', async () => {
    const d = await doc();
    const c = setEnd(circuitOfDoc(d), 's4->s5', 'head', { on: 'wire', host: 's1->s2', at: 40 });
    expect(judgeDrop(d, c, 's1->s2', 'head', wire('s4->s5'))).toBe('short');
  });

  it('refuses a loop of wires closed by a tail', async () => {
    const d = await doc();
    // the hub -> s4 -> s5 at 40; s4 -> s5 -> s1 -> s2 at 20; the hub wire's tail onto s1 -> s2 at 60 comes back round
    const c = setEnd(setEnd(circuitOfDoc(d), 'wf->s1', 'head', { on: 'wire', host: 's4->s5', at: 40 }), 's4->s5', 'head', { on: 'wire', host: 's1->s2', at: 20 });
    expect(judgeDrop(d, c, 'wf->s1', 'tail', wire('s1->s2', 60))).toBe('short');
  });

  it('refuses a new loop of wires while another, unrelated one is already there; an end may still move inside the old one', async () => {
    const d = await doc();
    const looped = setEnd(setEnd(circuitOfDoc(d), 's4->s5', 'head', { on: 'wire', host: 's1->s2', at: 40 }), 's1->s2', 'head', { on: 'wire', host: 's4->s5', at: 40 });
    const c = addCircuitWire(addCircuitWire(looped, 'w:x', { tail: { on: 'open', x: 0, y: 0 }, head: { on: 'wire', host: 'w:y', at: 40 } }), 'w:y', { tail: { on: 'open', x: 0, y: 80 }, head: { on: 'open', x: 200, y: 80 } });
    expect(judgeDrop(d, c, 'w:y', 'head', wire('w:x'))).toBe('short');
    expect(judgeDrop(d, c, 's4->s5', 'tail', step('s4', 'out', 120))).toBe('connect');
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
    // the net keeps Completed through s3 and would take Failed from s4 -> s5
    expect(judgeDrop(d, net, 's1->s2', 'head', wire('s4->s5'))).toBe('short');
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
    expect(targetOf(d, circuitOfDoc(d), { x: s2.x + 20, y: s2.y + 4 }, 's2', null)).toEqual({ on: 'step', step: 's2', side: 'in', y: 16 });
    expect(targetOf(d, circuitOfDoc(d), { x: s2.x + STEP_W - 20, y: s2.y + 150 }, 's2', null)).toEqual({ on: 'step', step: 's2', side: 'out', y: 144 });
    expect(targetOf(d, circuitOfDoc(d), { x: cx - 3, y: cy - 60 }, 'wf', null)).toEqual({ on: 'hub', angle: 270 });
    expect(targetOf(d, circuitOfDoc(d), { x: 13, y: 21 }, 'cache:c1', null)).toEqual({ on: 'open', x: 16, y: 24 });
    expect(targetOf(d, circuitOfDoc(d), { x: 13, y: 21 }, null, { id: 's1->s2', at: 37 })).toEqual({ on: 'wire', host: 's1->s2', at: 40 });
    expect(targetOf(d, circuitOfDoc(d), { x: 13, y: 21 }, null, null)).toEqual({ on: 'open', x: 16, y: 24 });
  });

  it('a line whose wire is not in the circuit leaves the end open where the pointer is, never on a missing host', async () => {
    const d = await doc();
    const c = circuitOfDoc(d);
    expect(targetOf(d, c, { x: 213, y: 101 }, null, { id: 'w:gone', at: 37 })).toEqual({ on: 'open', x: 216, y: 104 });
    const without: Circuit = Object.fromEntries(Object.entries(c).filter(([k]) => k !== 's1->s2'));
    expect(targetOf(d, without, { x: 213, y: 101 }, null, { id: 's1->s2', at: 37 })).toEqual({ on: 'open', x: 216, y: 104 });
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

describe('direction-less wires (the user\'s rule D, 2026-10-09)', () => {
  const free = (c: Circuit, id: string, tail: Parameters<typeof addCircuitWire>[2]['tail'], head: Parameters<typeof addCircuitWire>[2]['head']) => addCircuitWire(c, id, { tail, head });
  const open = (x: number, y: number) => ({ on: 'open' as const, x, y });

  it('a wire open at both ends is never told the wrong side or "only a tail": the side or the hub decides which end it is', async () => {
    const d = await doc();
    const c = free(circuitOfDoc(d), 'w:f', open(0, 0), open(100, 0));
    // its "head" end onto an output, the hub; its "tail" end onto an input
    expect(judgeDrop(d, c, 'w:f', 'head', step('s3', 'out'))).toBe('connect');
    expect(judgeDrop(d, c, 'w:f', 'head', { on: 'hub', angle: 90 })).toBe('connect');
    expect(judgeDrop(d, c, 'w:f', 'tail', step('s3', 'in'))).toBe('connect');
    expect(judgeDrop(d, c, 'w:f', 'tail', step('s3', 'out'))).toBe('connect');
    expect(judgeDrop(d, c, 'w:f', 'tail', wire('s1->s2'))).toBe('join');
    expect(judgeDrop(d, c, 'w:f', 'head', wire('s1->s2'))).toBe('join');
  });

  it('a wire with a direction is judged as before', async () => {
    const d = await doc();
    const c = free(circuitOfDoc(d), 'w:g', { on: 'step', step: 's1', y: null }, open(100, 0));
    expect(judgeDrop(d, c, 'w:g', 'head', step('s3', 'out'))).toBe('wrongSide');
    expect(judgeDrop(d, c, 'w:g', 'head', { on: 'hub', angle: 0 })).toBe('hubTail');
  });

  it('joined on one line, its other end onto another line is "needs a step first"; onto the same line "same wire"; onto a step it gets a direction', async () => {
    const d = await doc();
    const c = free(circuitOfDoc(d), 'w:j', { on: 'wire', host: 's1->s2', at: 40 }, open(300, 300));
    expect(judgeDrop(d, c, 'w:j', 'head', wire('s2->s3'))).toBe('needsStep');
    expect(judgeDrop(d, c, 'w:j', 'head', wire('s1->s2', 80))).toBe('sameWire');
    expect(judgeDrop(d, c, 'w:j', 'head', step('s3', 'in'))).toBe('connect');
    // onto an output: that end is its tail, so the junction becomes its head: s3's current into s1 -> s2 (allowed)
    expect(judgeDrop(d, c, 'w:j', 'head', step('s3', 'out'))).toBe('connect');
    expect(dropLabel('needsStep')).toBe('needs a step first');
    expect(toneOf('needsStep')).toBe('no');
  });

  it('the checks that need a direction are made on the wire turned: a short circuit, a step fed its own input', async () => {
    const d = await doc();
    // joined on s1 -> s2 (Completed), its other end onto s5 (Failed) as a head: a short circuit
    const c = free(circuitOfDoc(d), 'w:j', { on: 'wire', host: 's1->s2', at: 40 }, open(300, 300));
    expect(judgeDrop(d, c, 'w:j', 'head', step('s5', 'in'))).toBe('short');
    // joined on s1 -> s2, its other end onto s2's output: its tail on s2, its head into s1 -> s2, so s2 feeds itself
    expect(judgeDrop(d, c, 'w:j', 'head', step('s2', 'out'))).toBe('sameStep');
  });

  it('applyDrop turns a direction-less wire round when the end dropped becomes the other one, its bends with it; same id', async () => {
    const d = await doc();
    const bends = { xs: [40, 80], ys: [50] };
    const c = addCircuitWire(circuitOfDoc(d), 'w:f', { tail: open(0, 0), head: open(120, 100), bends });
    // the "tail" end onto an input: it is the head now
    const a = applyDrop(c, 'w:f', 'tail', step('s3', 'in'));
    expect(a.side).toBe('head');
    expect(a.circuit['w:f']).toEqual({ tail: open(120, 100), head: { on: 'step', step: 's3', y: 96 } });
    // a shape kept: reversed with the wire
    const k = applyDrop(c, 'w:f', 'tail', step('s3', 'in'), bends);
    expect(k.circuit['w:f']!.bends).toEqual({ xs: [80, 40], ys: [50] });
    // the "head" end onto an output: its tail now
    const b = applyDrop(c, 'w:f', 'head', step('s3', 'out'));
    expect(b.side).toBe('tail');
    expect(b.circuit['w:f']!.tail).toEqual({ on: 'step', step: 's3', y: 96 });
    expect(b.circuit['w:f']!.head).toEqual(open(0, 0));
    // the right end already: not turned
    const e = applyDrop(c, 'w:f', 'head', step('s3', 'in'));
    expect(e.side).toBe('head');
    expect(e.circuit['w:f']!.tail).toEqual(open(0, 0));
    // a directed wire is never turned
    const g = addCircuitWire(c, 'w:g', { tail: { on: 'step', step: 's1', y: null }, head: open(0, 0) });
    expect(applyDrop(g, 'w:g', 'head', step('s3', 'in')).circuit['w:g']!.tail).toEqual({ on: 'step', step: 's1', y: null });
  });
});
