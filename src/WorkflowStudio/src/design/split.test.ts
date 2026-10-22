import { describe, expect, it } from 'vitest';
import { cacheDto, graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { addCircuitWire, plainCircuit, type Circuit } from '../circuit/circuit';
import { CACHE_H, CACHE_W, LAYOUT_GAP, PMID, SPHERE_R, STEP_H, STEP_W } from '../layout/geometry';
import { applyDraft } from './apply';
import { EMPTY_DRAFT } from './draft';
import { judgeSplit, splitAt, splitCircuit, splitLabel, splitPlace, splitTone, wireUnder } from './split';

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

  it('a wire with junctions on it splits too (the user\'s ruling, 2026-10-22): judged by family like any connection', async () => {
    const d = await doc();
    // a branch off s1 -> s2's line, 40 along it, into s3 (family 1, as s2)
    const c = addCircuitWire(circuitOfDoc(d), 'w:b', { tail: { on: 'wire', host: 's1->s2', at: 40 }, head: { on: 'step', step: 's3', y: null } });
    expect(judgeSplit(d, c, 's1->s2', 'n', 1, { at: 80 })).toBe('insert');
    // a step of family 2 inserted past the junction: the branch stays on the half into the step, family 2 meets s3's 1
    expect(judgeSplit(d, c, 's1->s2', 'n', 2, { at: 80 })).toBe('short');
    // inserted before the junction: the branch goes with the half out of the step, into s2 (family 1): no clash
    expect(judgeSplit(d, c, 's1->s2', 'n', 2, { at: 20 })).toBe('insert');
  });

  it('the junctions before the insertion point stay on the old wire, those after it go to the new one', () => {
    const c: Circuit = {
      h: { tail: { on: 'step', step: 's1', y: null }, head: { on: 'step', step: 's2', y: null } },
      x: { tail: { on: 'wire', host: 'h', at: 16 }, head: { on: 'step', step: 's3', y: null } },
      y: { tail: { on: 'step', step: 's4', y: null }, head: { on: 'wire', host: 'h', at: 96 } },
    };
    const out = splitCircuit(c, 'h', 'n', 'w:n', 48);
    expect(out.x!.tail).toEqual({ on: 'wire', host: 'h', at: 16 });
    expect(out.y!.head).toMatchObject({ on: 'wire', host: 'w:n' });
    expect(out.h!.head).toEqual({ on: 'step', step: 'n', y: null });
  });

  it('refused: a half that cannot help lying on a wire of another net (rule 2, a short circuit)', async () => {
    // s2 moved far right, so a step fits between it and s1
    const loaded = await doc();
    const d = applyDraft(loaded, { ...EMPTY_DRAFT, steps: { s2: { x: 1400, y: loaded.placement.steps.get('s2')!.y } } });
    const s1 = d.placement.steps.get('s1')!;
    const box = { x: s1.x + STEP_W + 400, y: s1.y, w: STEP_W, h: STEP_H };
    // free wires laid level off the new step's output at every height it could leave at: the router has no free track
    const blocked = (dy: number) => {
      let c = circuitOfDoc(d);
      for (let y = box.y; y <= box.y + STEP_H; y += 8) {
        c = addCircuitWire(c, `w:o${y}`, { tail: { on: 'open', x: box.x + STEP_W + 8, y: y + dy }, head: { on: 'open', x: box.x + STEP_W + 56, y: y + dy }, bends: { xs: [box.x + STEP_W + 8], ys: [] } });
      }
      return { c, shown: applyDraft(d, { ...EMPTY_DRAFT, steps: { s2: { x: 1400, y: d.placement.steps.get('s2')!.y } }, wires: c }) };
    };
    const on = blocked(0);
    expect(judgeSplit(on.shown, on.c, 's1->s2', 'n', 1, { at: 100, box })).toBe('short');
    // families alone see nothing wrong: only drawing the halves finds it
    expect(judgeSplit(on.shown, on.c, 's1->s2', 'n', 1, { at: 100 })).toBe('insert');
    // the same wires well below the step: inserted
    const off = blocked(600);
    expect(judgeSplit(off.shown, off.c, 's1->s2', 'n', 1, { at: 100, box })).toBe('insert');
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
    expect(splitAt(d, c, boxOn(d, 's1->s2'), 'n', 1)).toMatchObject({ wire: 's1->s2', why: 'insert' });
    expect(splitAt(d, c, { x: -5000, y: -5000, w: STEP_W, h: STEP_H }, 'n', 1)).toBeNull();
  });
});

describe("where the split's step lands (Visio, measured 2026-10-22; the user's choice (a))", () => {
  const at = (x: number, y: number) => ({ x, y });

  it('one layout gap past the source step, level with it, wherever it was released; the head and all it feeds move right to keep one gap', async () => {
    const d = await doc();
    const s1 = d.placement.steps.get('s1')!, s2 = d.placement.steps.get('s2')!, s3 = d.placement.steps.get('s3')!;
    const p = splitPlace(d, circuitOfDoc(d), 's1->s2', 'n');
    expect(p.box).toEqual({ x: s1.x + STEP_W + LAYOUT_GAP, y: s1.y, w: STEP_W, h: STEP_H });
    // s2 must start one gap past the new step: s2 and s3 (fed by s2) move by the same amount, rows kept
    const dx = p.box.x + STEP_W + LAYOUT_GAP - s2.x;
    expect(dx).toBeGreaterThan(0);
    expect(p.moved).toEqual(new Map([['s2', at(s2.x + dx, s2.y)], ['s3', at(s3.x + dx, s3.y)]]));
  });

  it('with room already, nothing moves', async () => {
    const loaded = await doc();
    const d = applyDraft(loaded, { ...EMPTY_DRAFT, steps: { s2: { x: 1400, y: 64 }, s3: { x: 1752, y: 64 } } });
    const p = splitPlace(d, circuitOfDoc(d), 's1->s2', 'n');
    expect(p.box.x).toBe(d.placement.steps.get('s1')!.x + STEP_W + LAYOUT_GAP);
    expect(p.moved.size).toBe(0);
  });

  it('from the hub: one gap right of its ring, its processor middle level with the hub\'s centre', async () => {
    const d = await doc();
    const { cx, cy } = d.placement.sphere;
    const p = splitPlace(d, circuitOfDoc(d), 'wf->s1', 'n');
    expect(p.box).toMatchObject({ x: cx + SPHERE_R + LAYOUT_GAP, y: cy - PMID });
    expect(p.moved.get('s1')!.x).toBe(p.box.x + STEP_W + LAYOUT_GAP);
  });

  it('a block that stays in the way (choice (a)): the group goes on right, in its rows, until it is one gap clear of it', async () => {
    // the same workflow with a cache k1
    const loaded = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1'], cacheIds: ['k1'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2', { nextStepIds: ['s3'] }), stepDto('s3')],
      caches: [cacheDto('k1')],
    }));
    const first = splitPlace(loaded, circuitOfDoc(loaded), 's1->s2', 'n');
    // a cache parked where s3 would land
    const k = first.moved.get('s3')!;
    const d = applyDraft(loaded, { ...EMPTY_DRAFT, caches: { k1: { x: k.x + 40, y: k.y } } });
    const p = splitPlace(d, circuitOfDoc(d), 's1->s2', 'n');
    const cache = { x: k.x + 40, y: k.y, w: CACHE_W, h: CACHE_H };
    const clear = (b: { x: number; y: number }) => b.x >= cache.x + cache.w + LAYOUT_GAP || b.x + STEP_W <= cache.x - LAYOUT_GAP;
    for (const [id, b] of p.moved) {
      expect(b.y, id).toBe(d.placement.steps.get(id)!.y);
      expect(clear(b), id).toBe(true);
    }
    // the least such push, on the grid
    const dx = p.moved.get('s2')!.x - d.placement.steps.get('s2')!.x;
    expect(dx % 8).toBe(0);
    expect([...p.moved.values()].every((b) => clear({ x: b.x - 8, y: b.y }))).toBe(false);
  });
  it('source and head in different rows (Visio, measured): one gap past the source, in the head\'s row; the head moves on, the other branch stays', async () => {
    // s1 feeds s2 and s3: one column, two rows
    const d = await loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: ['s1'] }), steps: [stepDto('s1', { nextStepIds: ['s2', 's3'] }), stepDto('s2'), stepDto('s3')] }));
    const s1 = d.placement.steps.get('s1')!, s2 = d.placement.steps.get('s2')!, s3 = d.placement.steps.get('s3')!;
    expect(s3.y).not.toBe(s1.y);
    const p = splitPlace(d, circuitOfDoc(d), 's1->s3', 'n');
    expect(p.box).toMatchObject({ x: s1.x + STEP_W + LAYOUT_GAP, y: s3.y });
    expect(p.moved).toEqual(new Map([['s3', at(p.box.x + STEP_W + LAYOUT_GAP, s3.y)]]));
    expect(s2).toEqual(d.placement.steps.get('s2'));
  });

  it("the step's own spot too near a block that stays (choice (a)): it goes on right in its row until clear, its head after it", async () => {
    const loaded = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1'], cacheIds: ['k1'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')],
      caches: [cacheDto('k1')],
    }));
    const s1 = loaded.placement.steps.get('s1')!;
    // a cache parked just under where the step would land, closer than a gap
    const d = applyDraft(loaded, { ...EMPTY_DRAFT, caches: { k1: { x: s1.x + STEP_W + LAYOUT_GAP, y: s1.y + STEP_H + 64 } } });
    const p = splitPlace(d, circuitOfDoc(d), 's1->s2', 'n');
    expect(p.box.y).toBe(s1.y);
    expect(p.box.x).toBe(s1.x + STEP_W + LAYOUT_GAP + CACHE_W + LAYOUT_GAP);
    expect(p.moved.get('s2')!.x).toBe(p.box.x + STEP_W + LAYOUT_GAP);
  });
});
