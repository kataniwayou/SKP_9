import { describe, expect, it } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { plainCircuit, type Circuit, type End } from '../circuit/circuit';
import { linkKeys, trace } from '../circuit/trace';
import { EMPTY_EDITS, setField } from './design';
import { EMPTY_DRAFT, withCircuit } from './draft';
import { expectedLinks, reconcile, settleDesign, settleDraft } from './settle';

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

  it('a wire turned round that keeps a plain id `s->t` (its tail now on t) is never put back on t: its junction head opens (review 2026-10-09)', async () => {
    const d = await loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: ['s1'] }), steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
    const c: Circuit = { ...plainOf(d), 's1->s2#2': { tail: at('s2'), head: on('w:gone', 40) } };
    const out = reconcile(c, expectedLinks(d, {}, null), d);
    const w = out['s1->s2#2'];
    expect(w === undefined || !(w.head.on === 'step' && w.tail.on === 'step' && w.head.step === w.tail.step)).toBe(true);
    expect(trace(out).links.get('s2') ?? []).not.toContain('s2');
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

  it('a junction carrying an expected link stays when one joined downstream of it makes an unexpected link (chain)', async () => {
    const d = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2', 's3'] }), stepDto('s2'), stepDto('s3')], layout: { parked: ['s4'] },
    } as never), [stepDto('s4')]);
    const p = plainOf(d);
    const b = { tail: on('s1->s2', 40), head: at('s3') };
    const c: Circuit = { 'wf->s1': p['wf->s1']!, 's1->s2': p['s1->s2']!, 'w:b': b, 'w:c': { tail: on('w:b', 40), head: at('s4') } };
    const expected = expectedLinks(d, {}, null);
    const out = reconcile(c, expected, d);
    expect(out['w:b']).toEqual(b);
    expect(Object.keys(out).sort()).toEqual(['s1->s2', 'w:b', 'w:c', 'wf->s1']);
    expect(out['w:c']!.tail.on).toBe('open');
    expect(out['w:c']!.head).toEqual(at('s4'));
    expect([...linkKeys(trace(out).links)].sort()).toEqual([...expected].sort());
  });

  it('a junction carrying an expected link stays when a wire poured into it makes an unexpected link (fan-in)', async () => {
    const d = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2', 's3'] }), stepDto('s2'), stepDto('s3')], layout: { parked: ['s4'] },
    } as never), [stepDto('s4')]);
    const p = plainOf(d);
    const y = { tail: on('s1->s2', 40), head: at('s3') };
    const c: Circuit = { 'wf->s1': p['wf->s1']!, 's1->s2': p['s1->s2']!, 'w:y': y, 'w:x': { tail: at('s4'), head: on('w:y', 40) } };
    const expected = expectedLinks(d, {}, null);
    const out = reconcile(c, expected, d);
    expect(out['w:y']).toEqual(y);
    expect(out['w:x']!.tail).toEqual(at('s4'));
    expect(out['w:x']!.head.on).toBe('open');
    expect(Object.keys(out).sort()).toEqual(['s1->s2', 'w:x', 'w:y', 'wf->s1']);
    expect([...linkKeys(trace(out).links)].sort()).toEqual([...expected].sort());
  });

  it('settles once: settling a settled circuit changes nothing', async () => {
    const d1 = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1', 's3'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2'), stepDto('s3', { nextStepIds: ['s4'] }), stepDto('s4')],
    }));
    const c1: Circuit = { ...plainOf(d1), 's3->s4': { tail: at('s3'), head: on('s1->s2', 40) }, 'w:l1': { tail: at('s1'), head: { on: 'open', x: 900, y: 64 } } };
    const once1 = reconcile(c1, expectedLinks(d1, {}, null), d1);
    expect(reconcile(once1, expectedLinks(d1, {}, null), d1)).toEqual(once1);
    const d2 = await loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: ['s1'] }), steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
    const c2: Circuit = { 'wf->s1': plainOf(d2)['wf->s1']!, 'w:9': { tail: at('s2'), head: at('s1') } };
    const once2 = reconcile(c2, expectedLinks(d2, {}, null), d2);
    expect(reconcile(once2, expectedLinks(d2, {}, null), d2)).toEqual(once2);
  });

  it('an entry link through a junction on a hub wire: kept when the workflow has it, opened when not', async () => {
    const both = await loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: ['s1', 's2'] }), steps: [stepDto('s1'), stepDto('s2')] }));
    const j = { tail: on('wf->s1', 40), head: at('s2') };
    const made: Circuit = { 'wf->s1': plainOf(both)['wf->s1']!, 'w:j': j };
    expect(reconcile(made, expectedLinks(both, {}, null), both)).toEqual(made);
    const one = await loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: ['s1'] }), steps: [stepDto('s1')], layout: { parked: ['s2'] } } as never), [stepDto('s2')]);
    const broken: Circuit = { 'wf->s1': plainOf(one)['wf->s1']!, 'w:j': j };
    const out = reconcile(broken, expectedLinks(one, {}, null), one);
    expect(out['wf->s1']).toEqual(broken['wf->s1']);
    expect(out['w:j']!.tail.on).toBe('open');
    expect(out['w:j']!.head).toEqual(at('s2'));
  });

  it('a plan 7 head whose own link is unexpected too goes back into its step, then the plain wire goes', async () => {
    const d = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1', 's3'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2'), stepDto('s3')], layout: { parked: ['s4'] },
    } as never), [stepDto('s4')]);
    const c: Circuit = { ...plainOf(d), 's3->s4': { tail: at('s3'), head: on('s1->s2', 40) } };
    const out = reconcile(c, expectedLinks(d, {}, null), d);
    expect(out).toEqual(plainOf(d));
  });

  it('a wire addPlain named `s->t#n` goes back into its own step too', async () => {
    const d = await loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: ['s1'] }), steps: [stepDto('s1', { nextStepIds: ['s2', 's3'] }), stepDto('s2'), stepDto('s3')] }));
    const p = plainOf(d);
    const c: Circuit = { 'wf->s1': p['wf->s1']!, 's1->s3': p['s1->s3']!, 's1->s2#2': { tail: at('s1'), head: on('s1->s3', 40) } };
    const out = reconcile(c, expectedLinks(d, {}, null), d);
    expect(Object.keys(out)).toEqual(['wf->s1', 's1->s3', 's1->s2#2']);
    expect(out['s1->s2#2']).toEqual({ tail: at('s1'), head: at('s2') });
  });

  it('a source a short circuit holds back keeps its whole drawing: no link of it is unexpected or missing (plan 9 §7)', async () => {
    const d = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1', 's4'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2', 's3', 's5'] }), stepDto('s2'), stepDto('s3', { entryCondition: 2 }), stepDto('s4'), stepDto('s5')],
    }));
    const c: Circuit = { ...plainOf(d), 's1->s3': { tail: on('s1->s2', 40), head: at('s3') }, 'w:n': { tail: at('s1'), head: at('s4') } };
    delete c['s1->s5'];
    const expected = expectedLinks(d, {}, null);
    expect(reconcile(c, expected, d)).toEqual(c);
  });
});

describe('settleDraft and settleDesign', () => {
  it('leave a draft with no circuit of its own alone, and settle one against its own lists', async () => {
    const d = await loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: ['s1'] }), steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
    expect(settleDraft(EMPTY_DRAFT, d)).toBe(EMPTY_DRAFT);
    // a plan 8 session that removed s1 -> s2 and shaped nothing: an empty circuit and its lists
    const settled = settleDraft({ ...EMPTY_DRAFT, next: { s1: [] }, wires: {} }, d);
    expect(Object.keys(settled.wires!)).toEqual(['wf->s1']);
    expect(settled.next).toEqual({ s1: [] });
  });

  it('settle a design with its own entry-condition edits, so its families are the edited ones', async () => {
    const d = await loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: ['s1'] }), steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')], layout: { parked: ['s3'] } } as never), [stepDto('s3')]);
    const c = { ...plainOf(d), 'w:x': { tail: on('s1->s2', 40), head: at('s3') } };
    const draft = withCircuit(EMPTY_DRAFT, d, c);
    const edits = setField(EMPTY_EDITS, { kind: 'step', id: 's3' }, stepDto('s3'), 'entryCondition', 2, () => 'x');
    // s3 Failed in the design: the net is shorted, its links are not expected, the junction stays
    const out = settleDesign({ draft: { ...draft, next: { s1: [] } }, edits }, d);
    expect(out.draft.wires!['w:x']!.tail).toEqual(on('s1->s2', 40));
  });
});
