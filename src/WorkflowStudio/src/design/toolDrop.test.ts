import { describe, expect, it } from 'vitest';
import { cacheDto, graphDto, processorDto, schemaDto, stepDto, workflowDto } from '../api/fixtures';
import { cacheFromDto, processorFromDto, schemaFromDto } from '../api/toModel';
import { loadedDocument } from '../app/fixtures';
import { buildDesignRequest } from '../app/saveDesign';
import { STEP_H, STEP_W } from '../layout/geometry';
import { applyDesign } from './apply';
import { parseBlocks } from './blocks';
import { deletePicked } from './clipboard';
import { EMPTY_EDITS, storedDesignOf } from './design';
import { addCircuitWire } from '../circuit/circuit';
import { circuitOf, EMPTY_DRAFT, withCircuit } from './draft';
import { layoutOf } from './layoutDesign';
import { dropTool, judgeTool, toolLabel, uniqueName, type ToolItem } from './toolDrop';

// s1 (processor p1), wired from the hub; cache k1 in the workflow
const doc = () => loadedDocument(graphDto({
  workflow: workflowDto({ entryStepIds: ['s1'], cacheIds: ['k1'] }),
  steps: [stepDto('s1', { name: 'step' })],
  caches: [cacheDto('k1', { root: 'cache' })],
}));
// s1 (entry) -> s2; s3 a second entry step, its output free
const three = () => loadedDocument(graphDto({
  workflow: workflowDto({ entryStepIds: ['s1', 's3'] }),
  steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2'), stepDto('s3')],
}));
let n = 0;
const ids = () => `n${++n}`;
const at = { x: 1000, y: 600 };
const p2 = processorFromDto(processorDto('p2', { name: 'parser', configSchemaId: 'sc' }));
const procItem: ToolItem = { kind: 'processor', processor: p2, schemas: [schemaFromDto(schemaDto('sc'))] };

describe('Toolbox drops (the user\'s rules, 2026-10-11)', () => {
  it('an empty step: a new virtual step centred on the pointer, named step-2 (step is taken), no processor, picked', async () => {
    const base = await doc();
    const r = dropTool(base, EMPTY_EDITS, EMPTY_DRAFT, { kind: 'step' }, at, ids)!;
    const [id, made] = Object.entries(r.draft.blocks.steps)[0]!;
    expect(made).toMatchObject({ copyOf: null, name: 'step-2', version: '1.0.0', processorId: null, at: { x: at.x - STEP_W / 2, y: at.y - STEP_H / 2 } });
    expect(r.picks).toEqual([{ kind: 'node', id }]);
    // drawn with the empty slot; Save sends it as a new step with no processor (BaseApi's dry run refuses it)
    const shown = applyDesign(base, r.draft, EMPTY_EDITS);
    expect(shown.graph.steps.get(id)!.processorId).toBeNull();
    expect(buildDesignRequest(base, shown, { draft: r.draft, edits: EMPTY_EDITS }).newSteps).toEqual([expect.objectContaining({ id, processorId: null })]);
  });

  it('a wire: a new free wire, open at both ends, its head at the tip, 96 px horizontal, picked', async () => {
    const base = await doc();
    const r = dropTool(base, EMPTY_EDITS, EMPTY_DRAFT, { kind: 'wire' }, at, ids)!;
    const id = r.picks[0]!.id;
    expect(r.picks[0]!.kind).toBe('wire');
    const w = circuitOf(base, r.draft)[id]!;
    expect([w.tail, w.head]).toEqual([{ on: 'open', x: 904, y: 600 }, { on: 'open', x: 1000, y: 600 }]);
    const drawn = applyDesign(base, r.draft, EMPTY_EDITS).wires.find((x) => x.id === id)!;
    expect(drawn.points).toEqual([[904, 600], [1000, 600]]);
  });

  it('an empty cache: a new virtual cache with no root yet (drawn dashed with a ⚠ until one is set), saved as a new cache', async () => {
    const base = await doc();
    const r = dropTool(base, EMPTY_EDITS, EMPTY_DRAFT, { kind: 'newCache' }, at, ids)!;
    const [id, made] = Object.entries(r.draft.blocks.caches)[0]!;
    expect(made).toMatchObject({ copyOf: null, name: 'cache', version: '1.0.0', root: '', items: '{}' });
    const shown = applyDesign(base, r.draft, EMPTY_EDITS);
    expect(shown.graph.workflow.cacheIds).toEqual(['k1', id]);
    expect(buildDesignRequest(base, shown, { draft: r.draft, edits: EMPTY_EDITS }).newCaches).toEqual([expect.objectContaining({ id })]);
  });

  it('an existing cache: the same entity linked (no new cache), saved in the workflow\'s cache list; one already here is refused', async () => {
    const base = await doc();
    const other = cacheFromDto(cacheDto('k9', { name: 'rates', root: 'rates' }));
    const r = dropTool(base, EMPTY_EDITS, EMPTY_DRAFT, { kind: 'cache', cache: other }, at, ids)!;
    expect(r.picks).toEqual([{ kind: 'node', id: 'cache:k9' }]);
    const shown = applyDesign(base, r.draft, EMPTY_EDITS);
    expect(shown.graph.caches.get('k9')!.name).toBe('rates');
    const body = buildDesignRequest(base, shown, { draft: r.draft, edits: EMPTY_EDITS });
    expect(body.workflow.cacheIds).toEqual(['k1', 'k9']);
    expect(body.newCaches).toBeUndefined();
    // already in this workflow: refused
    const here = cacheFromDto(cacheDto('k1'));
    expect(judgeTool(base, { kind: 'cache', cache: here }, at)).toEqual({ kind: 'linked', cacheId: 'k1' });
    expect(dropTool(base, EMPTY_EDITS, EMPTY_DRAFT, { kind: 'cache', cache: here }, at, ids)).toBeNull();
    // Delete of the linked cache drops only the link
    const gone = deletePicked(base, EMPTY_EDITS, r.draft, [{ kind: 'node', id: 'cache:k9' }])!;
    expect(gone.draft.blocks.linked).toEqual({});
    expect(gone.draft.blocks.removed.caches).toEqual([]);
  });

  it('a processor: only on a step; there the step points at it (the same entity, never a copy), replacing its own', async () => {
    const base = await doc();
    const step = base.placement.steps.get('s1')!;
    const on = { x: step.x + 20, y: step.y + 20 };
    expect(judgeTool(base, procItem, on)).toEqual({ kind: 'replace', stepId: 's1' });
    expect(judgeTool(base, procItem, at)).toEqual({ kind: 'noStep' });
    expect(dropTool(base, EMPTY_EDITS, EMPTY_DRAFT, procItem, at, ids)).toBeNull();
    const r = dropTool(base, EMPTY_EDITS, EMPTY_DRAFT, procItem, on, ids)!;
    expect(r.draft.blocks.assigned).toEqual({ s1: 'p2' });
    expect(r.draft.blocks.refs.processors.p2).toBe(p2);
    const shown = applyDesign(base, r.draft, EMPTY_EDITS);
    expect(shown.graph.steps.get('s1')!.processorId).toBe('p2');
    expect(shown.graph.processors.get('p2')).toBe(p2);
    const body = buildDesignRequest(base, shown, { draft: r.draft, edits: EMPTY_EDITS });
    expect(body.steps).toEqual([expect.objectContaining({ id: 's1', fields: { processorId: 'p2' } })]);
    // the processor it was loaded with again: no change left
    const back = dropTool(base, EMPTY_EDITS, r.draft, { kind: 'processor', processor: processorFromDto(processorDto('p1')), schemas: [] }, on, ids)!;
    expect(back.draft.blocks.assigned).toEqual({});
  });

  it('a processor on a step with none (removed, or a new empty step) assigns it; a new step keeps it as its own', async () => {
    const base = await doc();
    const empty = dropTool(base, EMPTY_EDITS, EMPTY_DRAFT, { kind: 'step' }, at, ids)!;
    const id = empty.picks[0]!.id;
    const shown = applyDesign(base, empty.draft, EMPTY_EDITS);
    const p = shown.placement.steps.get(id)!;
    expect(judgeTool(shown, procItem, { x: p.x + 10, y: p.y + 10 })).toEqual({ kind: 'assign', stepId: id });
    const r = dropTool(base, EMPTY_EDITS, empty.draft, procItem, { x: p.x + 10, y: p.y + 10 }, ids)!;
    expect(r.draft.blocks.steps[id]!.processorId).toBe('p2');
    expect(r.draft.blocks.assigned).toEqual({});
    // a workflow step whose processor was removed takes it again: unassigned no more
    const cleared = deletePicked(base, EMPTY_EDITS, EMPTY_DRAFT, [{ kind: 'processor', id: 's1' }])!;
    const s1 = base.placement.steps.get('s1')!;
    const again = dropTool(base, EMPTY_EDITS, cleared.draft, procItem, { x: s1.x + 10, y: s1.y + 10 }, ids)!;
    expect(again.draft.blocks.unassigned).toEqual([]);
    expect(again.draft.blocks.assigned).toEqual({ s1: 'p2' });
  });

  it('a refused Save\'s stored design brings the drops back: the assigned processor, the linked cache and the refs', async () => {
    const base = await doc();
    const s1 = base.placement.steps.get('s1')!;
    let draft = dropTool(base, EMPTY_EDITS, EMPTY_DRAFT, procItem, { x: s1.x + 10, y: s1.y + 10 }, ids)!.draft;
    draft = dropTool(base, EMPTY_EDITS, draft, { kind: 'cache', cache: cacheFromDto(cacheDto('k9', { root: 'rates' })) }, at, ids)!.draft;
    const shown = applyDesign(base, draft, EMPTY_EDITS);
    const { layout, ...stored } = buildDesignRequest(base, shown, { draft, edits: EMPTY_EDITS });
    const read = storedDesignOf(JSON.parse(JSON.stringify(stored)), JSON.parse(JSON.stringify(layoutOf(shown, draft))));
    expect(read.draft.blocks.assigned).toEqual({ s1: 'p2' });
    expect(Object.keys(read.draft.blocks.linked)).toEqual(['k9']);
    expect(read.draft.blocks.refs.processors.p2?.name).toBe('parser');
    expect(applyDesign(base, read.draft, read.edits).graph.workflow.cacheIds).toEqual(['k1', 'k9']);
    // and the session's copy of the blocks reads back the same
    expect(parseBlocks(JSON.parse(JSON.stringify(draft.blocks)))).toEqual(draft.blocks);
  });

  it('names: the first of base, base-2, base-3 … not taken', () => {
    expect(uniqueName('step', new Set())).toBe('step');
    expect(uniqueName('step', new Set(['step', 'step-2']))).toBe('step-3');
  });
});

describe("a Wire tile dropped straight on a contact (the user's request, 2026-10-20)", () => {
  const judge = (base: Awaited<ReturnType<typeof three>>, p: { x: number; y: number }) => judgeTool(base, { kind: 'wire' }, p, { circuit: circuitOf(base, EMPTY_DRAFT), reach: 8 });

  it("on a step's input: \"connect here\"; dropped, its head is on that input and its tail open 96 px to the left", async () => {
    const base = await three();
    const s3 = base.placement.steps.get('s3')!;
    // above the hub's wire, which takes the input's centre
    const p = { x: s3.x + 4, y: s3.y + 48 };
    expect(judge(base, p)).toMatchObject({ kind: 'wire', why: 'connect', target: { on: 'step', step: 's3', side: 'in' } });
    expect(toolLabel(judge(base, p))).toEqual({ text: 'connect here', tone: 'ok' });
    const r = dropTool(base, EMPTY_EDITS, EMPTY_DRAFT, { kind: 'wire' }, p, ids, 8)!;
    const w = circuitOf(base, r.draft)[r.picks[0]!.id]!;
    expect(w.head).toEqual({ on: 'step', step: 's3', y: 48 });
    expect(w.tail).toEqual({ on: 'open', x: s3.x - 96, y: s3.y + 48 });
    expect(w.bends).toBeUndefined();
  });

  it("on a step's output: its tail there, its head open 96 px to the right; on the hub: its tail on the ring", async () => {
    const base = await three();
    const s3 = base.placement.steps.get('s3')!;
    const r = dropTool(base, EMPTY_EDITS, EMPTY_DRAFT, { kind: 'wire' }, { x: s3.x + STEP_W - 4, y: s3.y + 96 }, ids, 8)!;
    const w = circuitOf(base, r.draft)[r.picks[0]!.id]!;
    expect(w.tail).toEqual({ on: 'step', step: 's3', y: 96 });
    expect(w.head).toEqual({ on: 'open', x: s3.x + STEP_W + 96, y: s3.y + 96 });
    const { cx, cy } = base.placement.sphere;
    expect(judge(base, { x: cx, y: cy - 90 })).toMatchObject({ kind: 'wire', why: 'connect', target: { on: 'hub' } });
    const h = dropTool(base, EMPTY_EDITS, EMPTY_DRAFT, { kind: 'wire' }, { x: cx, y: cy - 90 }, ids, 8)!;
    expect(circuitOf(base, h.draft)[h.picks[0]!.id]!.tail).toMatchObject({ on: 'hub' });
  });

  it('on the hub anywhere round its ring: out of the ring and straight on to the right, never back round the hub (2026-10-21)', async () => {
    // a workflow with room beside its hub (no step yet)
    const base = await loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: [] }), steps: [] }));
    const { cx, cy } = base.placement.sphere;
    // the left side, the top, the bottom, low on the left, high on the right, the right
    for (const deg of [180, -90, 90, 135, -45, 0]) {
      const r = (deg * Math.PI) / 180;
      const p = { x: cx + 90 * Math.cos(r), y: cy + 90 * Math.sin(r) };
      const v = judge(base, p);
      expect(v, `${deg}°`).toMatchObject({ kind: 'wire', why: 'connect', target: { on: 'hub' } });
      if (v.kind !== 'wire' || v.points === null) throw new Error(`${deg}°: no drawing`);
      const pts = v.points;
      // the ring lead (one point from the right half, two from the left), then one run to the right, ending at the head
      expect(pts.length, `${deg}° ${JSON.stringify(pts)}`).toBeLessThanOrEqual(3);
      const [a, z] = [pts.at(-2)!, pts.at(-1)!];
      expect(a[1], `${deg}°`).toBe(z[1]);
      expect(z[0] - a[0], `${deg}°`).toBeGreaterThan(0);
      expect(Math.min(...pts.map((q) => q[0])), `${deg}°`).toBeGreaterThanOrEqual(cx - 96);
      const h = dropTool(base, EMPTY_EDITS, EMPTY_DRAFT, { kind: 'wire' }, p, ids, 8)!;
      const w = circuitOf(base, h.draft)[h.picks[0]!.id]!;
      expect(w.tail).toMatchObject({ on: 'hub' });
      expect(applyDesign(base, h.draft, EMPTY_EDITS).wires.find((x) => x.id === h.picks[0]!.id)!.points).toEqual(pts);
    }
  });

  it("on a wire's line: \"join here\", a junction there; on empty canvas a free wire as before", async () => {
    const base = await three();
    const host = base.wires.find((x) => x.id === 's1->s2')!;
    const run = host.points.findIndex((q, i) => i > 0 && q[1] === host.points[i - 1]![1] && Math.abs(q[0] - host.points[i - 1]![0]) >= 32);
    const p = { x: (host.points[run]![0] + host.points[run - 1]![0]) / 2, y: host.points[run]![1] };
    expect(judge(base, p)).toMatchObject({ kind: 'wire', why: 'join', target: { on: 'wire', host: 's1->s2' } });
    const r = dropTool(base, EMPTY_EDITS, EMPTY_DRAFT, { kind: 'wire' }, p, ids, 8)!;
    expect(circuitOf(base, r.draft)[r.picks[0]!.id]!.head).toMatchObject({ on: 'wire', host: 's1->s2' });
    expect(judge(base, at)).toEqual({ kind: 'place' });
  });

  it('a stub that would lie on a wire of another net is a short circuit: red, and released there nothing is dropped', async () => {
    const base = await three();
    const s2 = base.placement.steps.get('s2')!;
    // s2's input already takes s1 -> s2 at its centre; a new stub into s2's input at the same height runs back along it
    const p = { x: s2.x + 4, y: s2.y + 96 };
    const v = judge(base, p);
    expect(v).toMatchObject({ kind: 'wire', why: 'short' });
    expect(toolLabel(v)).toEqual({ text: 'short circuit', tone: 'no' });
    expect(dropTool(base, EMPTY_EDITS, EMPTY_DRAFT, { kind: 'wire' }, p, ids, 8)).toBeNull();
  });
});

describe('an empty step dropped on a wire splits it (Visio, plan 10 §4.6)', () => {
  it('an empty step over a wire\'s run: "insert here"; dropped, the wire splits through it, one draft (plan 10 §4.6)', async () => {
    const base = await three();
    const host = base.wires.find((x) => x.id === 's1->s2')!;
    const run = host.points.findIndex((q, i) => i > 0 && q[1] === host.points[i - 1]![1] && Math.abs(q[0] - host.points[i - 1]![0]) >= 32);
    const p = { x: (host.points[run]![0] + host.points[run - 1]![0]) / 2, y: host.points[run]![1] };
    const v = judgeTool(base, { kind: 'step' }, p, { circuit: circuitOf(base, EMPTY_DRAFT), reach: 8 });
    expect(v).toEqual({ kind: 'split', wire: 's1->s2', why: 'insert' });
    expect(toolLabel(v)).toEqual({ text: 'insert here', tone: 'ok' });
    const r = dropTool(base, EMPTY_EDITS, EMPTY_DRAFT, { kind: 'step' }, p, ids, 8)!;
    const id = r.picks[0]!.id;
    expect(r.draft.blocks.steps[id]).toBeDefined();
    const c = circuitOf(base, r.draft);
    expect(c['s1->s2']!.head).toEqual({ on: 'step', step: id, y: null });
    const added = Object.entries(c).find(([k]) => k.startsWith('w:'))!;
    expect(added[1]).toEqual({ tail: { on: 'step', step: id, y: null }, head: { on: 'step', step: 's2', y: null } });
    const shown = applyDesign(base, r.draft, EMPTY_EDITS);
    expect(shown.graph.steps.get('s1')!.nextStepIds).toEqual([id]);
    expect(shown.graph.steps.get(id)!.nextStepIds).toEqual(['s2']);
    // off any wire: placed, as before
    expect(judgeTool(base, { kind: 'step' }, at, { circuit: circuitOf(base, EMPTY_DRAFT), reach: 8 })).toEqual({ kind: 'place' });
  });

  it('an empty step over a wire that refuses a split: red, and released there nothing is dropped', async () => {
    const base = await three();
    const host = base.wires.find((x) => x.id === 's1->s2')!;
    const run = host.points.findIndex((q, i) => i > 0 && q[1] === host.points[i - 1]![1] && Math.abs(q[0] - host.points[i - 1]![0]) >= 32);
    const p = { x: (host.points[run]![0] + host.points[run - 1]![0]) / 2, y: host.points[run]![1] };
    // a free wire joined on s1 -> s2's line: s1 -> s2 hosts a junction
    const draft = withCircuit(EMPTY_DRAFT, base, addCircuitWire(circuitOf(base, EMPTY_DRAFT), 'w:j', { tail: { on: 'wire', host: 's1->s2', at: 8 }, head: { on: 'open', x: 0, y: 0 } }));
    const shown = applyDesign(base, draft, EMPTY_EDITS);
    const v = judgeTool(shown, { kind: 'step' }, p, { circuit: circuitOf(base, draft), reach: 8 });
    expect(v).toEqual({ kind: 'split', wire: 's1->s2', why: 'junctionWire' });
    expect(toolLabel(v)).toEqual({ text: 'wires join this wire', tone: 'no' });
    expect(dropTool(base, EMPTY_EDITS, draft, { kind: 'step' }, p, ids, 8)).toBeNull();
  });
});
