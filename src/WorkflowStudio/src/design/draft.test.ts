import { describe, expect, it } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { addCircuitWire, setEnd } from '../circuit/circuit';
import { EMPTY_DESIGN, EMPTY_EDITS, hasGraphChanges, sameDesign } from './design';
import { circuitOf, EMPTY_DRAFT, isEmptyDraft, listsOf, moveBlocks, parseDraft, removeWires, resetShape, setShape, withCircuit } from './draft';

const chain = () => loadedDocument(graphDto({
  workflow: workflowDto({ entryStepIds: ['s1'] }),
  steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2', { nextStepIds: ['s3'] }), stepDto('s3')],
}));
const at = (step: string) => ({ on: 'step' as const, step, y: null });

describe('draft', () => {
  it('moves the hub (by its centre), a cache and a step; a move back to the saved place leaves nothing', async () => {
    const saved = await chain();
    const s1 = saved.placement.steps.get('s1')!;
    let d = moveBlocks(EMPTY_DRAFT, saved, new Map([['wf', { x: 0, y: 8 }], ['cache:c1', { x: 16, y: 24 }], ['s1', { x: s1.x + 32, y: s1.y }]]));
    expect(d.sphere).toEqual({ x: 96, y: 104 });
    expect(d.caches).toEqual({ c1: { x: 16, y: 24 } });
    expect(d.steps).toEqual({ s1: { x: s1.x + 32, y: s1.y } });
    d = moveBlocks(d, saved, new Map([['s1', s1]]));
    expect(d.steps).toEqual({});
  });

  it('with no circuit of its own shows the saved workflow\'s wires, automatic', async () => {
    const saved = await chain();
    expect(Object.keys(circuitOf(saved, EMPTY_DRAFT))).toEqual(['wf->s1', 's1->s2', 's2->s3']);
    expect(listsOf(saved, circuitOf(saved, EMPTY_DRAFT)).entries).toEqual(['s1']);
  });

  it('derives the lists from the circuit, keeping only those that differ from the saved workflow (plan 9 §7)', async () => {
    const saved = await chain();
    // s2 -> s3 taps s1 -> s2: s1's current reaches s2 and s3; s2 feeds nothing
    const d = withCircuit(EMPTY_DRAFT, saved, setEnd(circuitOf(saved, EMPTY_DRAFT), 's2->s3', 'tail', { on: 'wire', host: 's1->s2', at: 40 }));
    expect(d.next).toEqual({ s1: ['s2', 's3'], s2: [] });
    expect(d.entries).toBeNull();
    const back = withCircuit(d, saved, circuitOf(saved, EMPTY_DRAFT));
    expect([back.next, back.entries]).toEqual([{}, null]);
  });

  it('an entry list follows a tail on the hub', async () => {
    const saved = await chain();
    const d = withCircuit(EMPTY_DRAFT, saved, setEnd(circuitOf(saved, EMPTY_DRAFT), 's2->s3', 'tail', { on: 'hub', angle: 90 }));
    expect(d.entries).toEqual(['s1', 's3']);
    expect(d.next).toEqual({ s2: [] });
  });

  it('removing a wire takes its links away; a wire joined on it keeps its place, open', async () => {
    const saved = await chain();
    const joined = withCircuit(EMPTY_DRAFT, saved, addCircuitWire(circuitOf(saved, EMPTY_DRAFT), 'w:1', { tail: at('s3'), head: { on: 'wire', host: 's1->s2', at: 40 } }));
    const d = removeWires(joined, saved, ['s1->s2'], () => ({ x: 400, y: 120 }));
    expect(d.next).toEqual({ s1: [] });
    expect(d.wires!['w:1']!.head).toEqual({ on: 'open', x: 400, y: 120 });
    expect(removeWires(EMPTY_DRAFT, saved, ['gone'], () => null)).toBe(EMPTY_DRAFT);
  });

  it('a shape sets a wire\'s bends and its head\'s height; Reset route makes it automatic, keeping what it is connected to', async () => {
    const saved = await chain();
    const d = setShape(EMPTY_DRAFT, saved, 's1->s2', { bends: { xs: [600], ys: [] }, landing: 80 });
    expect(d.wires!['s1->s2']).toEqual({ tail: at('s1'), head: { on: 'step', step: 's2', y: 80 }, bends: { xs: [600], ys: [] } });
    expect(d.next).toEqual({});
    // back to the workflow's own wires: the draft holds no circuit, nothing to save
    expect(resetShape(d, saved, 's1->s2')).toEqual(EMPTY_DRAFT);
    // what it is connected to stays: a tail on the hub at its angle
    const hub = withCircuit(EMPTY_DRAFT, saved, setEnd(circuitOf(saved, EMPTY_DRAFT), 'wf->s1', 'tail', { on: 'hub', angle: 90 }));
    const reset = resetShape(setShape(hub, saved, 'wf->s1', { bends: { xs: [400], ys: [] }, landing: 80 }), saved, 'wf->s1');
    expect(reset.wires!['wf->s1']).toEqual({ tail: { on: 'hub', angle: 90 }, head: at('s1') });
    expect(resetShape(EMPTY_DRAFT, saved, 's1->s2')).toBe(EMPTY_DRAFT);
    expect([isEmptyDraft(EMPTY_DRAFT), isEmptyDraft(d)]).toEqual([true, false]);
  });

  it('a shape undone by Reset route is no design at all: the same as nothing designed (no false "design draft")', async () => {
    const saved = await chain();
    const reset = resetShape(setShape(EMPTY_DRAFT, saved, 's1->s2', { bends: { xs: [600], ys: [] }, landing: 80 }), saved, 's1->s2');
    expect(sameDesign({ draft: reset, edits: EMPTY_EDITS }, EMPTY_DESIGN)).toBe(true);
    // a tail moved round the hub is a visible change: it stays
    const angled = withCircuit(EMPTY_DRAFT, saved, setEnd(circuitOf(saved, EMPTY_DRAFT), 'wf->s1', 'tail', { on: 'hub', angle: 90 }));
    expect(sameDesign({ draft: angled, edits: EMPTY_EDITS }, EMPTY_DESIGN)).toBe(false);
  });

  it('a shape-only edit never rewrites a list: a next step the circuit cannot draw (not loaded) keeps its place', async () => {
    const saved = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1', 'gone'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2', 'gone'] }), stepDto('s2')],
    }));
    const d = setShape(EMPTY_DRAFT, saved, 's1->s2', { bends: { xs: [600], ys: [] }, landing: 80 });
    expect([d.next, d.entries]).toEqual([{}, null]);
    expect(hasGraphChanges({ draft: d, edits: EMPTY_EDITS })).toBe(false);
    expect(listsOf(saved, d.wires!).next.get('s1')).toEqual(['s2', 'gone']);
    // a real change keeps the id it cannot draw, in its place
    const cut = removeWires(d, saved, ['s1->s2'], () => null);
    expect(cut.next).toEqual({ s1: ['gone'] });
  });

  it('parses its own JSON and drops what is not its shape', async () => {
    const saved = await chain();
    const d = setShape(EMPTY_DRAFT, saved, 's1->s2', { bends: { xs: [8, 16], ys: [40] }, landing: null });
    expect(parseDraft(JSON.parse(JSON.stringify(d)))).toEqual(d);
    expect(parseDraft('nope')).toBeNull();
    expect(parseDraft({ sphere: { x: 'a' }, steps: { s1: { x: 1, y: 2 }, s2: 5 }, wires: null })).toEqual({ ...EMPTY_DRAFT, steps: { s1: { x: 1, y: 2 } } });
  });

  it('reads a plan 7 / plan 8 draft as a circuit; one that only rewired gets an empty circuit, settled on load (spec §8)', () => {
    const d = parseDraft({ next: { s1: ['s2'] }, routes: { 's1->s2': { bends: null, landing: 72, contact: null } }, loose: { l1: { source: 's1', end: { x: 8, y: 8 } } } })!;
    expect(d.wires).toEqual({ 's1->s2': { tail: at('s1'), head: { on: 'step', step: 's2', y: 72 } }, 'w:l1': { tail: at('s1'), head: { on: 'open', x: 8, y: 8 } } });
    expect(d.next).toEqual({ s1: ['s2'] });
    expect(parseDraft({ next: { s1: [] } })!.wires).toEqual({});
    expect(parseDraft({ steps: {} })!.wires).toBeNull();
  });
});
