import { describe, expect, it } from 'vitest';
import { assignmentDto, cacheDto, graphDto, processorDto, stepDto, workflowDto } from '../api/fixtures';
import type { StudioDocument } from '../app/document';
import { loadedDocument } from '../app/fixtures';
import { buildDesignRequest } from '../app/saveDesign';
import { readSession, restoredState, sessionOf, SESSION_KEY } from '../app/session';
import { setBends, setEnd, type Circuit } from '../circuit/circuit';
import { CACHE_H, CACHE_W, STEP_H, STEP_W } from '../layout/geometry';
import { cacheNodeId, SPHERE_NODE_ID } from '../layout/nodeIds';
import { INITIAL_STATE, reduce, type StudioAction, type StudioState } from '../store/studioState';
import { memoryStorage } from '../test/memoryStorage';
import { applyDesign, applyEdits } from './apply';
import { applyBlocks, EMPTY_BLOCKS } from './blocks';
import { blockBoxes, copyClip, deletePicked, freeOffset, pasteClip, PASTE_MARGIN, PASTE_STEP, type Clip } from './clipboard';
import { EMPTY_EDITS, storedDesignOf, type EntityEdits } from './design';
import { circuitOf, EMPTY_DRAFT, moveGroup, parseDraft, withCircuit, type Draft } from './draft';
import { commit, historyOf, redo, undo } from './history';

/** wf -> s1 -> s2 -> s3; s1 has an assignment; one cache. */
const chain = (id = 'wf1') => loadedDocument(graphDto({
  workflow: workflowDto({ id, entryStepIds: ['s1'], cacheIds: ['c1'], assignmentIds: ['a1'] }),
  steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2', { nextStepIds: ['s3'], entryCondition: 2 }), stepDto('s3')],
  assignments: [assignmentDto('a1', { stepId: 's1', payload: '{"k":1}' })],
  caches: [cacheDto('c1')],
}));

/** A workflow of its own: one step on another processor. */
const other = () => loadedDocument(graphDto({
  workflow: workflowDto({ id: 'wf2', entryStepIds: ['t1'] }),
  steps: [stepDto('t1', { processorId: 'p9' })],
  processors: [processorDto('p9')],
}));

const ids = () => { let n = 0; return () => `n${++n}`; };
/** The assignment a1's own fields as the graph read carries them (the fixture's). */
const ASG = { name: 'assignment-a1', version: '1.0.0', description: null };
const node = (id: string) => ({ kind: 'node' as const, id });
const wire = (id: string) => ({ kind: 'wire' as const, id });

type Box = { x: number; y: number; w: number; h: number };
const overlap = (a: Box, b: Box, m = 0) => a.x < b.x + b.w + m && a.x + a.w + m > b.x && a.y < b.y + b.h + m && a.y + a.h + m > b.y;
const stepBox = (doc: StudioDocument, id: string): Box => { const p = doc.placement.steps.get(id)!; return { x: p.x, y: p.y, w: STEP_W, h: STEP_H }; };

/** Pastes `clip` into (base, edits, draft) and returns the drawing with the paste. */
function paste(base: StudioDocument, draft: Draft, clip: Clip, edits: EntityEdits = EMPTY_EDITS, newId = ids()) {
  const r = pasteClip(base, edits, draft, clip, newId, base.graph.workflow.id)!;
  return { ...r, shown: applyDesign(base, r.draft, edits) };
}

describe('copy (2026-10-10)', () => {
  it('copies the picked steps with their assignment and the wires between them; the hub and wires to what is left out are skipped', async () => {
    const base = await chain();
    const clip = copyClip(base, EMPTY_EDITS, EMPTY_DRAFT, [node(SPHERE_NODE_ID), node('s1'), node('s2'), wire('wf->s1'), wire('s1->s2')], 'wf1')!;
    expect(clip.steps.map((s) => [s.id, s.name, s.processorId, s.entryCondition])).toEqual([['s1', 'step-s1', 'p1', 1], ['s2', 'step-s2', 'p1', 2]]);
    expect(clip.steps[0]!.assignment).toEqual({ copyOf: 'a1', fields: { ...ASG, payload: '{"k":1}' } });
    expect(clip.steps[1]!.assignment).toBeNull();
    // s1 -> s2 runs between copied steps; the hub's wire and s2 -> s3 reach what is left out
    expect(Object.keys(clip.wires)).toEqual(['s1->s2']);
    expect(clip.processors.map((p) => p.id)).toEqual(['p1']);
    expect(clip.pasted).toBe(0);
  });

  it('a copy of a pasted step keeps the real row its assignment copies (never the unsaved one)', async () => {
    const base = await chain();
    const first = copyClip(base, EMPTY_EDITS, EMPTY_DRAFT, [node('s1')], 'wf1')!;
    const { draft } = paste(base, EMPTY_DRAFT, first);
    const again = copyClip(base, EMPTY_EDITS, draft, [node('n1')], 'wf1')!;
    expect(again.steps[0]!.assignment).toEqual({ copyOf: 'a1', fields: { ...ASG, payload: '{"k":1}' } });
  });

  it('the hub alone copies nothing', async () => {
    const base = await chain();
    expect(copyClip(base, EMPTY_EDITS, EMPTY_DRAFT, [node(SPHERE_NODE_ID)], 'wf1')).toBeNull();
  });

  it('copies what the design shows: an Inspector edit of the step and its assignment', async () => {
    const base = await chain();
    const edits: EntityEdits = {
      ...EMPTY_EDITS, steps: { s1: { updatedAt: null, fields: { name: 'renamed' } } },
      assignments: { s1: { op: 'update', id: 'a1', updatedAt: null, fields: { ...ASG, payload: '{"k":2}' } } },
    };
    const clip = copyClip(base, edits, EMPTY_DRAFT, [node('s1')], 'wf1')!;
    expect(clip.steps[0]!.name).toBe('renamed');
    expect(clip.steps[0]!.assignment).toEqual({ copyOf: 'a1', fields: { ...ASG, payload: '{"k":2}' } });
  });

  it('a wire picked alone is copied free: both ends open where it is drawn, its drawn shape kept', async () => {
    const base = await chain();
    const clip = copyClip(base, EMPTY_EDITS, EMPTY_DRAFT, [wire('s1->s2')], 'wf1')!;
    const drawn = base.wires.find((w) => w.id === 's1->s2')!.points;
    const w = clip.wires['s1->s2']!;
    expect(w.tail).toEqual({ on: 'open', x: drawn[0]![0], y: drawn[0]![1] });
    expect(w.head).toEqual({ on: 'open', x: drawn.at(-1)![0], y: drawn.at(-1)![1] });
    expect(clip.steps).toEqual([]);
  });

  it('a junction among copied wires comes with its host, and is left out without it', async () => {
    const base = await chain();
    // s2 -> s3 is re-sourced to tap s1 -> s2 40 px along it
    const draft = withCircuit(EMPTY_DRAFT, base, setEnd(circuitOf(base, EMPTY_DRAFT), 's2->s3', 'tail', { on: 'wire', host: 's1->s2', at: 40 }));
    const all = copyClip(base, EMPTY_EDITS, draft, [node('s1'), node('s2'), node('s3')], 'wf1')!;
    expect(Object.keys(all.wires).sort()).toEqual(['s1->s2', 's2->s3']);
    expect(all.wires['s2->s3']!.tail).toEqual({ on: 'wire', host: 's1->s2', at: 40 });
    const noHost = copyClip(base, EMPTY_EDITS, draft, [node('s2'), node('s3')], 'wf1')!;
    expect(Object.keys(noHost.wires)).toEqual([]);
  });
});

describe('paste (2026-10-10)', () => {
  it('makes new ids for steps, assignments and wires, keeps names, versions and the processor, and picks what it pasted', async () => {
    const base = await chain();
    const clip = copyClip(base, EMPTY_EDITS, EMPTY_DRAFT, [node('s1'), node('s2'), wire('s1->s2')], 'wf1')!;
    const { draft, picks, shown } = paste(base, EMPTY_DRAFT, clip);
    // steps first, then caches, wires, assignments
    expect(Object.keys(draft.blocks.steps)).toEqual(['n1', 'n2']);
    const n1 = draft.blocks.steps.n1!;
    expect([n1.copyOf, n1.name, n1.version, n1.processorId, n1.assignment]).toEqual(['s1', 'step-s1', '1.0.0', 'p1', { id: 'n4', copyOf: 'a1', fields: { ...ASG, payload: '{"k":1}' } }]);
    expect(draft.blocks.steps.n2!.entryCondition).toBe(2);
    // the copied wire joins the copies, under a new design wire id
    const c = circuitOf(applyEdits(base, EMPTY_EDITS, draft.blocks), draft);
    const pasted = Object.entries(c).filter(([id]) => id.startsWith('w:'));
    expect(pasted).toHaveLength(1);
    expect(pasted[0]![1].tail).toEqual({ on: 'step', step: 'n1', y: null });
    expect(pasted[0]![0]).toBe('w:n3');
    expect(pasted[0]![1].head).toEqual({ on: 'step', step: 'n2', y: null });
    expect(draft.next).toEqual({ n1: ['n2'] });
    expect(picks).toEqual([node('n1'), node('n2'), wire('w:n3')]);
    // the originals are untouched, the copies drawn with an assignment of their own
    expect(shown.graph.steps.get('s1')!.nextStepIds).toEqual(['s2']);
    expect(shown.graph.assignments.find((a) => a.stepId === 'n1')).toMatchObject({ id: 'n4', payload: '{"k":1}' });
    expect(new Set([...shown.graph.steps.keys()]).size).toBe(5);
  });

  it('into a free area the group lands +32 / +32, and each further paste of the same clip another 32 px (when free)', async () => {
    const target = await other();
    const source = await chain();
    const clip = copyClip(source, EMPTY_EDITS, EMPTY_DRAFT, [node('s3')], 'wf1')!;
    // far from the target's blocks
    const far: Clip = { ...clip, steps: clip.steps.map((s) => ({ ...s, at: { x: 4000, y: 4000 } })) };
    const once = paste(target, EMPTY_DRAFT, far);
    expect(once.draft.blocks.steps.n1!.at).toEqual({ x: 4000 + PASTE_STEP, y: 4000 + PASTE_STEP });
    // a cascade step that is free lands exactly there
    const third = paste(target, EMPTY_DRAFT, { ...far, pasted: 2 });
    expect(third.draft.blocks.steps.n1!.at).toEqual({ x: 4000 + 3 * PASTE_STEP, y: 4000 + 3 * PASTE_STEP });
  });

  it('never lands on a block: not on its originals, not on other blocks, not on an earlier paste', async () => {
    const base = await chain();
    let draft = EMPTY_DRAFT;
    let clip = copyClip(base, EMPTY_EDITS, draft, [node('s1'), node('s2'), node(cacheNodeId('c1'))], 'wf1')!;
    const newId = ids();
    for (let i = 0; i < 6; i++) {
      const before = applyDesign(base, draft, EMPTY_EDITS);
      const r = pasteClip(base, EMPTY_EDITS, draft, clip, newId)!;
      draft = r.draft;
      clip = { ...clip, pasted: clip.pasted + 1 };
      const shown = applyDesign(base, draft, EMPTY_EDITS);
      const made = r.picks.filter((p) => p.kind === 'node').map((p) => p.id);
      const boxes = made.map((id) => (id.startsWith('cache:') ? { ...shown.placement.caches.get(id.slice(6))!, w: CACHE_W, h: CACHE_H } : stepBox(shown, id)));
      for (const b of boxes) for (const o of blockBoxes(before)) expect(overlap(b, o, PASTE_MARGIN - 1)).toBe(false);
      // rigid: the group keeps its shape
      const dx = boxes[0]!.x - clip.steps[0]!.at.x, dy = boxes[0]!.y - clip.steps[0]!.at.y;
      expect([boxes[1]!.x - clip.steps[1]!.at.x, boxes[1]!.y - clip.steps[1]!.at.y]).toEqual([dx, dy]);
    }
    expect(Object.keys(draft.blocks.steps)).toHaveLength(12);
    expect(Object.keys(draft.blocks.caches)).toHaveLength(6);
  });

  it('is deterministic: the same clip on the same canvas lands at the same place', async () => {
    const base = await chain();
    const clip = copyClip(base, EMPTY_EDITS, EMPTY_DRAFT, [node('s1'), node('s2')], 'wf1')!;
    const a = paste(base, EMPTY_DRAFT, clip), b = paste(base, EMPTY_DRAFT, clip);
    expect(a.draft.blocks.steps.n1!.at).toEqual(b.draft.blocks.steps.n1!.at);
  });

  it('copied wires keep their shapes moved by the same offset; junctions keep their place along their (new) host', async () => {
    const base = await chain();
    let c = circuitOf(base, EMPTY_DRAFT);
    const s1 = base.placement.steps.get('s1')!;
    c = setBends(c, 's1->s2', { xs: [s1.x + STEP_W + 48], ys: [] });
    c = setEnd(c, 's2->s3', 'tail', { on: 'wire', host: 's1->s2', at: 40 });
    const draft = withCircuit(EMPTY_DRAFT, base, c);
    const clip = copyClip(base, EMPTY_EDITS, draft, [node('s1'), node('s2'), node('s3')], 'wf1')!;
    const { draft: after } = paste(base, draft, clip);
    const moved = after.blocks.steps.n1!.at;
    const dx = moved.x - s1.x, dy = moved.y - s1.y;
    const circuit = circuitOf(applyEdits(base, EMPTY_EDITS, after.blocks), after);
    const host = Object.entries(circuit).find(([id, w]) => id.startsWith('w:') && w.tail.on === 'step' && w.tail.step === 'n1')!;
    expect(host[1].bends).toEqual({ xs: [s1.x + STEP_W + 48 + dx], ys: [] });
    const tap = Object.entries(circuit).find(([id, w]) => id.startsWith('w:') && w.tail.on === 'wire')!;
    expect(tap[1].tail).toEqual({ on: 'wire', host: host[0], at: 40 });
    expect(dy).not.toBeNaN();
  });

  it('a free wire pastes direction-less: grey, both ends open, moved by the offset', async () => {
    const base = await chain();
    const clip = copyClip(base, EMPTY_EDITS, EMPTY_DRAFT, [wire('s1->s2')], 'wf1')!;
    const { draft, shown } = paste(base, EMPTY_DRAFT, clip);
    const id = Object.keys(draft.wires!).find((k) => k.startsWith('w:'))!;
    const w = draft.wires![id]!;
    const was = clip.wires['s1->s2']!;
    expect(w.tail).toEqual({ on: 'open', x: (was.tail as { x: number }).x + PASTE_STEP, y: (was.tail as { y: number }).y + PASTE_STEP });
    expect(shown.wires.find((r) => r.id === id)!.free).toBe(true);
    expect(draft.next).toEqual({});
  });

  it('into another workflow brings the processor it needs to draw the step', async () => {
    const source = await chain();
    const target = await other();
    const clip = copyClip(source, EMPTY_EDITS, EMPTY_DRAFT, [node('s1')], 'wf1')!;
    const { draft, shown } = paste(target, EMPTY_DRAFT, clip);
    expect(Object.keys(draft.blocks.refs.processors)).toEqual(['p1']);
    expect(shown.graph.processors.get('p1')!.name).toBe('proc-p1');
    expect(shown.graph.steps.get('n1')!.processorId).toBe('p1');
  });
});

describe('review fixes (2026-10-10)', () => {
  it('a pasted cache keeps every field as copied, its root too, paste after paste (2026-10-22)', async () => {
    const base = await chain();
    let clip = copyClip(base, EMPTY_EDITS, EMPTY_DRAFT, [node(cacheNodeId('c1'))], 'wf1')!;
    let draft = EMPTY_DRAFT;
    const newId = ids();
    for (let i = 0; i < 3; i++) {
      draft = pasteClip(base, EMPTY_EDITS, draft, clip, newId, 'wf1')!.draft;
      clip = { ...clip, pasted: clip.pasted + 1 };
    }
    const made = Object.values(draft.blocks.caches);
    expect(made.map((c) => [c.copyOf, c.name, c.version, c.description, c.root, c.items]))
      .toEqual(Array(3).fill(['c1', 'cache-c1', '1.0.0', null, 'c1', '{}']));
    // a root another cache uses is BaseApi's to refuse at Save: the request sends it as it is
    const body = buildDesignRequest(base, applyDesign(base, draft, EMPTY_EDITS), { draft, edits: EMPTY_EDITS });
    expect(body.newCaches!.map((c) => c.fields.root)).toEqual(['c1', 'c1', 'c1']);
  });

  it('the store pastes a cache with the root it shows, an Inspector edit included, whatever another open workflow uses', async () => {
    const a = await chain('wf1');
    const b = await loadedDocument(graphDto({
      workflow: workflowDto({ id: 'wf2', entryStepIds: ['t1'], cacheIds: ['k'] }), steps: [stepDto('t1')], caches: [cacheDto('k', { root: 'edited' })],
    }));
    const edits: EntityEdits = { ...EMPTY_EDITS, caches: { c1: { updatedAt: null, fields: { root: 'edited', items: '{"x":"1"}' } } } };
    const clip = copyClip(a, edits, EMPTY_DRAFT, [node(cacheNodeId('c1'))], 'wf1')!;
    const state = [
      { type: 'open', workflowId: 'wf1', name: 'a', version: '1' }, { type: 'loaded', workflowId: 'wf1', doc: a },
      { type: 'open', workflowId: 'wf2', name: 'b', version: '1' }, { type: 'loaded', workflowId: 'wf2', doc: b },
    ].reduce((s: StudioState, x) => reduce(s, x as StudioAction), { ...INITIAL_STATE, clipboard: clip });
    const pasted = reduce(state, { type: 'paste', workflowId: 'wf2', newId: ids() });
    expect(Object.values(pasted.docs[1]!.design.draft.blocks.caches).map((c) => [c.root, c.items])).toEqual([['edited', '{"x":"1"}']]);
  });

  it('a deleted step keeps the stamp it was loaded with through a stored design and a re-read: someone else\'s change conflicts', async () => {
    const base = await chain();
    const loaded = base.graph.steps.get('s3')!.updatedAt;
    const draft = deletePicked(base, EMPTY_EDITS, EMPTY_DRAFT, [node('s3')])!.draft;
    expect(draft.blocks.stamps).toEqual({ s3: loaded });
    const { layout, ...stored } = buildDesignRequest(base, applyDesign(base, draft, EMPTY_EDITS), { draft, edits: EMPTY_EDITS });
    // a refused Save: the workflow read again, s3 changed by someone else meanwhile
    const reread: StudioDocument = { ...base, graph: { ...base.graph, steps: new Map([...base.graph.steps].map(([id, s]) => [id, id === 's3' ? { ...s, updatedAt: '2026-10-10T09:00:00Z' } : s])) } };
    const back = storedDesignOf(JSON.parse(JSON.stringify(stored)), JSON.parse(JSON.stringify(layout)));
    expect(back.draft.blocks.stamps).toEqual({ s3: loaded });
    // and kept by a refresh (the session's draft)
    const session = parseDraft(JSON.parse(JSON.stringify(back.draft)))!;
    const again = buildDesignRequest(reread, applyDesign(reread, session, EMPTY_EDITS), { draft: session, edits: EMPTY_EDITS });
    expect(again.deletedSteps).toEqual([{ id: 's3', updatedAt: loaded }]);
  });

  it('cut and paste across workflows: the copy carries its assignment\'s own fields, so it saves once the original is gone', async () => {
    const source = await chain();
    const target = await other();
    const clip = copyClip(source, EMPTY_EDITS, EMPTY_DRAFT, [node('s1')], 'wf1')!;
    // the original is deleted (and saved) before the paste is saved
    expect(deletePicked(source, EMPTY_EDITS, EMPTY_DRAFT, [node('s1')])!.draft.blocks.removed.steps).toEqual(['s1']);
    const { draft } = paste(target, EMPTY_DRAFT, clip);
    const body = buildDesignRequest(target, applyDesign(target, draft, EMPTY_EDITS), { draft, edits: EMPTY_EDITS });
    expect(body.assignments).toEqual([{ op: 'create', id: 'n2', stepId: 'n1', updatedAt: null, fields: { ...ASG, payload: '{"k":1}' }, copyOf: 'a1' }]);
  });

  it('a free picked wire comes with the wires joined on it', async () => {
    const base = await chain();
    // s2 -> s3 taps s1 -> s2; only s1 -> s2 (both ends left out) and s3 are copied: the tap's head is on s3
    const draft = withCircuit(EMPTY_DRAFT, base, setEnd(circuitOf(base, EMPTY_DRAFT), 's2->s3', 'tail', { on: 'wire', host: 's1->s2', at: 40 }));
    const clip = copyClip(base, EMPTY_EDITS, draft, [wire('s1->s2'), node('s3')], 'wf1')!;
    expect(Object.keys(clip.wires).sort()).toEqual(['s1->s2', 's2->s3']);
    expect(clip.wires['s1->s2']!.tail.on).toBe('open');
    expect(clip.wires['s2->s3']!.tail).toEqual({ on: 'wire', host: 's1->s2', at: 40 });
  });
});

describe('freeOffset', () => {
  const step = (x: number, y: number): Box => ({ x, y, w: STEP_W, h: STEP_H });

  it('keeps the start when nothing is in the way', () => {
    expect(freeOffset([step(0, 0)], [], { x: 32, y: 32 })).toEqual({ x: 32, y: 32 });
  });

  it('prefers right and down when two spots are as near', () => {
    // a block right on the start: the nearest free spots are below it and to the right of it
    const at = freeOffset([step(0, 0)], [step(32, 32)], { x: 32, y: 32 });
    expect(at.x >= 32 && at.y >= 32).toBe(true);
  });

  it('on a crowded canvas finds a free spot, never on a block, the same every time', () => {
    const crowd: Box[] = [];
    for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) if ((i + j) % 5 !== 0) crowd.push(step(i * 240, j * 176));
    const group = [step(240, 176), step(480, 176)];
    const a = freeOffset(group, [...crowd, ...group], { x: 32, y: 32 });
    expect(freeOffset(group, [...crowd, ...group], { x: 32, y: 32 })).toEqual(a);
    for (const g of group) for (const o of [...crowd, ...group]) expect(overlap({ ...g, x: g.x + a.x, y: g.y + a.y }, o, PASTE_MARGIN - 1)).toBe(false);
  });

  it('is fast on a large canvas (a box index)', () => {
    const crowd: Box[] = [];
    for (let i = 0; i < 40; i++) for (let j = 0; j < 40; j++) crowd.push(step(i * 240, j * 176));
    const t = performance.now();
    const at = freeOffset([step(4800, 3520)], crowd, { x: 32, y: 32 });
    expect(performance.now() - t).toBeLessThan(500);
    expect(crowd.some((o) => overlap({ ...step(4800, 3520), x: 4800 + at.x, y: 3520 + at.y }, o, PASTE_MARGIN - 1))).toBe(false);
  });
});

describe('delete (2026-10-10)', () => {
  it('removes a step of the workflow with every wire on it; a wire joined on one of them opens where it is drawn; the hub stays', async () => {
    const base = await chain();
    // s2 -> s3 taps s1 -> s2; deleting s1 takes s1 -> s2 (and wf -> s1), so the tap opens
    const draft = withCircuit(EMPTY_DRAFT, base, setEnd(circuitOf(base, EMPTY_DRAFT), 's2->s3', 'tail', { on: 'wire', host: 's1->s2', at: 40 }));
    const r = deletePicked(base, EMPTY_EDITS, draft, [node(SPHERE_NODE_ID), node('s1')])!;
    expect(r.draft.blocks.removed.steps).toEqual(['s1']);
    expect(r.picks).toEqual([node(SPHERE_NODE_ID)]);
    const c = circuitOf(applyEdits(base, EMPTY_EDITS, r.draft.blocks), r.draft);
    expect(Object.keys(c).sort()).toEqual(['s2->s3']);
    expect(c['s2->s3']!.tail.on).toBe('open');
    const shown = applyDesign(base, r.draft, EMPTY_EDITS);
    expect(shown.graph.steps.has('s1')).toBe(false);
    expect(shown.graph.assignments).toEqual([]);
    expect(shown.graph.workflow.entryStepIds).toEqual([]);
  });

  it('a pasted step deleted is simply gone (nothing to delete on Save); a cache of the workflow is removed', async () => {
    const base = await chain();
    const clip = copyClip(base, EMPTY_EDITS, EMPTY_DRAFT, [node('s1')], 'wf1')!;
    const { draft } = paste(base, EMPTY_DRAFT, clip);
    const r = deletePicked(base, EMPTY_EDITS, draft, [node('n1'), node(cacheNodeId('c1'))])!;
    expect(r.draft.blocks.steps).toEqual({});
    expect(r.draft.blocks.removed).toEqual({ steps: [], caches: ['c1'] });
    expect(applyDesign(base, r.draft, EMPTY_EDITS).graph.workflow.cacheIds).toEqual([]);
  });

  it('wires picked alone go as before; nothing picked deletes nothing', async () => {
    const base = await chain();
    const r = deletePicked(base, EMPTY_EDITS, EMPTY_DRAFT, [wire('s2->s3')])!;
    expect(Object.keys(circuitOf(base, r.draft)).sort()).toEqual(['s1->s2', 'wf->s1']);
    expect(r.draft.blocks.removed.steps).toEqual([]);
    expect(deletePicked(base, EMPTY_EDITS, EMPTY_DRAFT, [node(SPHERE_NODE_ID)])).toBeNull();
  });

  it('never deletes the workflow, picked with steps and their wires (a rectangle round them all, 2026-10-10): the hub stays, and stays picked', async () => {
    const base = await chain();
    const r = deletePicked(base, EMPTY_EDITS, EMPTY_DRAFT, [node(SPHERE_NODE_ID), node('s1'), node('s2'), wire('wf->s1'), wire('s1->s2')])!;
    expect(r.draft.blocks.removed.steps).toEqual(['s1', 's2']);
    expect(r.picks).toEqual([node(SPHERE_NODE_ID)]);
    const shown = applyDesign(base, r.draft, EMPTY_EDITS);
    expect(shown.graph.workflow.id).toBe(base.graph.workflow.id);
    expect(shown.placement.sphere).toEqual(base.placement.sphere);
    expect(shown.graph.steps.has('s3')).toBe(true);
  });

  it('undo brings a deleted step back, redo deletes it again', async () => {
    const base = await chain();
    const r = deletePicked(base, EMPTY_EDITS, EMPTY_DRAFT, [node('s2')])!;
    const h = commit(historyOf(), r.draft);
    expect(applyDesign(base, undo(h).draft, EMPTY_EDITS).graph.steps.has('s2')).toBe(true);
    expect(applyDesign(base, redo(undo(h)).draft, EMPTY_EDITS).graph.steps.has('s2')).toBe(false);
  });
});

describe('group drag (decision 8, 2026-10-10)', () => {
  it('a picked hand-shaped wire moves with the blocks: its bends and open ends shift; an automatic wire is routed as before', async () => {
    const base = await chain();
    const s1 = base.placement.steps.get('s1')!, s2 = base.placement.steps.get('s2')!;
    let c = circuitOf(base, EMPTY_DRAFT);
    c = setBends(c, 's1->s2', { xs: [s1.x + STEP_W + 40], ys: [] });
    c = setEnd(c, 's2->s3', 'head', { on: 'open', x: 900, y: 900 });
    const draft = withCircuit(EMPTY_DRAFT, base, c);
    const moved = new Map([['s1', { x: s1.x + 64, y: s1.y + 32 }], ['s2', { x: s2.x + 64, y: s2.y + 32 }]]);
    const d = moveGroup(draft, base, moved, ['s1->s2', 's2->s3', 'wf->s1'], 64, 32);
    const after: Circuit = circuitOf(base, d);
    expect(after['s1->s2']!.bends).toEqual({ xs: [s1.x + STEP_W + 40 + 64], ys: [] });
    expect(after['s2->s3']!.head).toEqual({ on: 'open', x: 964, y: 932 });
    expect(after['wf->s1']).toEqual(c['wf->s1']);
    // not picked: stays where it was
    const alone = moveGroup(draft, base, moved, [], 64, 32);
    expect(circuitOf(base, alone)['s1->s2']!.bends).toEqual({ xs: [s1.x + STEP_W + 40], ys: [] });
  });
});

describe('blocks in the drawing, the request and the stored design', () => {
  it('applyBlocks drops a removed step from every list and places a pasted one', async () => {
    const base = await chain();
    const doc = applyBlocks(base, {
      ...EMPTY_BLOCKS, removed: { steps: ['s2'], caches: [] },
      steps: { n1: { copyOf: 's3', name: 'x', version: '1.0.0', description: null, processorId: 'p1', entryCondition: 1, at: { x: 3, y: 5 }, assignment: null } },
    });
    expect(doc.graph.steps.get('s1')!.nextStepIds).toEqual([]);
    expect(doc.placement.steps.has('s2')).toBe(false);
    expect(doc.placement.steps.get('n1')).toEqual({ x: 0, y: 8 });
    expect(doc.parkedIds).toContain('n1');
  });

  it('Save sends the pasted steps with their next steps and assignment, the deleted ones with their stamps, and the lists without them', async () => {
    const base = await chain();
    const clip = copyClip(base, EMPTY_EDITS, EMPTY_DRAFT, [node('s1'), node('s2'), node(cacheNodeId('c1'))], 'wf1')!;
    let { draft } = paste(base, EMPTY_DRAFT, clip);
    draft = deletePicked(base, EMPTY_EDITS, draft, [node('s3')])!.draft;
    const edits: EntityEdits = { ...EMPTY_EDITS, steps: { n1: { updatedAt: null, fields: { description: 'edited' } } } };
    const body = buildDesignRequest(base, applyDesign(base, draft, edits), { draft, edits });
    // ids: steps n1 n2, the cache n3, the wire w:n4, the assignment n5
    expect(body.newSteps).toEqual([
      { id: 'n1', copyOf: 's1', processorId: 'p1', fields: { name: 'step-s1', version: '1.0.0', description: 'edited', entryCondition: 1 }, nextStepIds: ['n2'] },
      { id: 'n2', copyOf: 's2', processorId: 'p1', fields: { name: 'step-s2', version: '1.0.0', description: null, entryCondition: 2 }, nextStepIds: null },
    ]);
    expect(body.assignments).toEqual([{ op: 'create', id: 'n5', stepId: 'n1', updatedAt: null, fields: { ...ASG, payload: '{"k":1}' }, copyOf: 'a1' }]);
    expect(body.newCaches).toEqual([{ id: 'n3', copyOf: 'c1', fields: { name: 'cache-c1', version: '1.0.0', description: null, root: 'c1', items: '{}' } }]);
    expect(body.deletedSteps).toEqual([{ id: 's3', updatedAt: base.graph.steps.get('s3')!.updatedAt }]);
    // s2 led to s3: its list goes without it
    expect(body.steps).toEqual([{ id: 's2', updatedAt: base.graph.steps.get('s2')!.updatedAt, fields: {}, nextStepIds: [] }]);
    expect(body.workflow.cacheIds).toEqual(['c1', 'n3']);
    expect(body.layout.parked).toEqual(expect.arrayContaining(['n1', 'n2']));
    expect(body.layout.steps.n1).toEqual(draft.blocks.steps.n1!.at);
  });

  it('a stored design (not applied) reads back with its pasted blocks where the layout has them', async () => {
    const base = await chain();
    const clip = copyClip(base, EMPTY_EDITS, EMPTY_DRAFT, [node('s1'), node('s2')], 'wf1')!;
    let { draft } = paste(base, EMPTY_DRAFT, clip);
    draft = deletePicked(base, EMPTY_EDITS, draft, [node('s3')])!.draft;
    const { layout, ...stored } = buildDesignRequest(base, applyDesign(base, draft, EMPTY_EDITS), { draft, edits: EMPTY_EDITS });
    const back = storedDesignOf(JSON.parse(JSON.stringify(stored)), JSON.parse(JSON.stringify(layout)));
    expect(Object.keys(back.draft.blocks.steps)).toEqual(['n1', 'n2']);
    expect(back.draft.blocks.steps.n1).toMatchObject({ copyOf: 's1', name: 'step-s1', at: draft.blocks.steps.n1!.at, assignment: { id: 'n4', copyOf: 'a1' } });
    expect(back.draft.blocks.removed.steps).toEqual(['s3']);
    expect(back.draft.next.n1).toEqual(['n2']);
    expect(back.edits.assignments).toEqual({});
  });
});

describe('the clipboard in the store and the session', () => {
  const run = (state: StudioState, ...actions: StudioAction[]) => actions.reduce(reduce, state);

  it('copied in one workflow, pasted into another: one undo step there, the cascade counted, kept by a refresh', async () => {
    const a = await chain('wf1');
    const b = await other();
    let state = run(INITIAL_STATE,
      { type: 'open', workflowId: 'wf1', name: 'a', version: '1' }, { type: 'loaded', workflowId: 'wf1', doc: a },
      { type: 'open', workflowId: 'wf2', name: 'b', version: '1' }, { type: 'loaded', workflowId: 'wf2', doc: b },
      { type: 'pick', workflowId: 'wf1', picks: [node(SPHERE_NODE_ID), node('s1'), node('s2')] },
      { type: 'copy', workflowId: 'wf1' });
    expect(state.clipboard!.steps.map((s) => s.id)).toEqual(['s1', 's2']);
    state = run(state, { type: 'paste', workflowId: 'wf2', newId: ids() });
    const wf2 = state.docs.find((d) => d.workflowId === 'wf2')!;
    expect(Object.keys(wf2.design.draft.blocks.steps)).toEqual(['n1', 'n2']);
    expect(wf2.picks).toEqual([node('n1'), node('n2'), expect.objectContaining({ kind: 'wire' })]);
    expect(wf2.design.past).toHaveLength(1);
    expect(state.clipboard!.pasted).toBe(1);
    expect(state.docs.find((d) => d.workflowId === 'wf1')!.design.draft.blocks).toEqual(EMPTY_BLOCKS);

    // a refresh keeps the clipboard and the pasted draft
    const storage = memoryStorage();
    storage.setItem(SESSION_KEY, JSON.stringify(sessionOf(state, new Map(), null)));
    const restored = restoredState(readSession(storage));
    expect(restored.clipboard).toEqual(state.clipboard);
    expect(restored.docs.find((d) => d.workflowId === 'wf2')!.design.draft.blocks).toEqual(wf2.design.draft.blocks);

    // undo takes the paste back, and the Inspector's pick of a pasted step with it
    const one = run(state, { type: 'select', workflowId: 'wf2', selection: { kind: 'step', stepId: 'n1' }, picks: [node('n1')] }, { type: 'undo', workflowId: 'wf2' });
    const back = one.docs.find((d) => d.workflowId === 'wf2')!;
    expect(back.design.draft.blocks.steps).toEqual({});
    expect(back.selection).toBeNull();
    expect(back.picks).toEqual([]);
  });

  it('Delete in the store removes the picks as one step and leaves the Inspector on nothing', async () => {
    const a = await chain('wf1');
    const state = run(INITIAL_STATE,
      { type: 'open', workflowId: 'wf1', name: 'a', version: '1' }, { type: 'loaded', workflowId: 'wf1', doc: a },
      { type: 'select', workflowId: 'wf1', selection: { kind: 'step', stepId: 's2' } },
      { type: 'deletePicks', workflowId: 'wf1' });
    const d = state.docs[0]!;
    expect(d.design.draft.blocks.removed.steps).toEqual(['s2']);
    expect(d.selection).toBeNull();
    expect(d.design.past).toHaveLength(1);
  });

  it('a draft with blocks survives the session as JSON', async () => {
    const base = await chain();
    const clip = copyClip(base, EMPTY_EDITS, EMPTY_DRAFT, [node('s1')], 'wf1')!;
    const { draft } = paste(base, EMPTY_DRAFT, clip);
    expect(parseDraft(JSON.parse(JSON.stringify(draft)))).toEqual(draft);
  });
});
