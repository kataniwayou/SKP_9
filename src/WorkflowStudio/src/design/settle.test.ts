import { describe, expect, it } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { plainCircuit, type Circuit, type End } from '../circuit/circuit';
import { expectedLinks, reconcile } from './settle';

const at = (step: string): End => ({ on: 'step', step, y: null });
const on = (host: string, d: number): End => ({ on: 'wire', host, at: d });
const plainOf = (d: Awaited<ReturnType<typeof loadedDocument>>): Circuit => plainCircuit(d.graph.workflow.entryStepIds, d.graph.steps, (id) => d.placement.steps.has(id));

describe('expectedLinks (plan 9 §7)', () => {
  it('is the saved lists with the design\'s own over them, both ends on the canvas', async () => {
    const d = await loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: ['s1'] }), steps: [stepDto('s1', { nextStepIds: ['s2', 'gone'] }), stepDto('s2')] }));
    expect([...expectedLinks(d, {}, null)].sort()).toEqual(['s1->s2', 'wf->s1']);
    expect([...expectedLinks(d, { s1: [] }, ['s1', 's2'])].sort()).toEqual(['wf->s1', 'wf->s2']);
  });
});

describe('reconcile (plan 9 §7, §8; decision 6)', () => {
  it('leaves a circuit that makes exactly the expected links as it is, its junctions included', async () => {
    const d = await loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: ['s1'] }), steps: [stepDto('s1', { nextStepIds: ['s2', 's3'] }), stepDto('s2'), stepDto('s3')] }));
    const c: Circuit = { ...plainOf(d), 's1->s3': { tail: on('s1->s2', 40), head: at('s3') } };
    expect(reconcile(c, expectedLinks(d, {}, null), d)).toEqual(c);
  });

  it('a plan 7 junction whose host leads elsewhere goes back into its own step; a loose wire stays (Review Focus 1)', async () => {
    const d = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1', 's3'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2'), stepDto('s3', { nextStepIds: ['s4'] }), stepDto('s4')],
    }));
    const loose = { tail: at('s1'), head: { on: 'open', x: 900, y: 64 } as End };
    const c: Circuit = { ...plainOf(d), 's3->s4': { tail: at('s3'), head: on('s1->s2', 40) }, 'w:l1': loose };
    const out = reconcile(c, expectedLinks(d, {}, null), d);
    expect(out['s3->s4']).toEqual({ tail: at('s3'), head: at('s4') });
    expect(out['w:l1']).toEqual(loose);
  });

  it('a missing link gets a new automatic wire; an unexpected plain wire goes', async () => {
    const d = await loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: ['s1'] }), steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
    const c: Circuit = { 'wf->s1': plainOf(d)['wf->s1']!, 'w:9': { tail: at('s2'), head: at('s1') } };
    const out = reconcile(c, expectedLinks(d, {}, null), d);
    expect(Object.keys(out)).toEqual(['wf->s1', 's1->s2']);
    expect(out['s1->s2']).toEqual({ tail: at('s1'), head: at('s2') });
  });

  it('an unexpected link through a junction opens that junction where it is drawn', async () => {
    const d = await loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: ['s1'] }), steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')], layout: { parked: ['s3'] } } as never), [stepDto('s3')]);
    const c: Circuit = { ...plainOf(d), 'w:x': { tail: on('s1->s2', 40), head: at('s3') } };
    const out = reconcile(c, expectedLinks(d, {}, null), d);
    expect(out['w:x']!.tail.on).toBe('open');
    expect(out['w:x']!.head).toEqual(at('s3'));
    expect(out['s1->s2']).toEqual(c['s1->s2']);
  });

  it('links through a short-circuited net are neither expected nor repaired (Review Focus 2)', async () => {
    const d = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')], layout: { parked: ['s3'] },
    } as never), [stepDto('s3', { entryCondition: 2 })]);
    const c: Circuit = { ...plainOf(d), 'w:x': { tail: on('s1->s2', 40), head: at('s3') } };
    // after a Save that left the shorted links out: s1 lists nothing
    expect(reconcile(c, expectedLinks(d, { s1: [] }, null), d)).toEqual(c);
    // a session derived before the short: s1 still lists s2 and s3
    expect(reconcile(c, expectedLinks(d, { s1: ['s2', 's3'] }, null), d)).toEqual(c);
  });

  it('a wire with an end on a step off the canvas goes; an end on a wire that is gone opens where it is drawn', async () => {
    const d = await loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: ['s1'] }), steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
    const c: Circuit = { ...plainOf(d), g: { tail: at('s1'), head: at('gone') }, y: { tail: on('nope', 10), head: at('s2') } };
    const out = reconcile(c, expectedLinks(d, {}, null), d);
    expect(Object.keys(out)).toEqual(['wf->s1', 's1->s2', 'y']);
    expect(out.y!.tail.on).toBe('open');
  });

  it('a hidden self-loop is never written, so it is not unexpected either: settle keeps it as Save sees it', async () => {
    const d = await loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: ['s1'] }), steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
    const c: Circuit = { ...plainOf(d), 'w:x': { tail: on('s1->s2', 40), head: at('s1') } };
    expect(reconcile(c, expectedLinks(d, {}, null), d)).toEqual(c);
  });
});
