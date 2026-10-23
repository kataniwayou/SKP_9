import { describe, expect, it, vi } from 'vitest';
import type { StudioApi } from '../../api/client';
import { graphDto, processorDto, schemaDto, stepDto, workflowDto } from '../../api/fixtures';
import type { WorkflowGraphDto } from '../../api/types';
import { loadedDocument } from '../../app/fixtures';
import { createInspectorService } from '../../app/inspectorService';
import { setEnd } from '../../circuit/circuit';
import { applyEdits } from '../../design/apply';
import { circuitOf, EMPTY_DRAFT, nextOf, withCircuit } from '../../design/draft';
import { canUndo } from '../../design/history';
import { judgeTool } from '../../design/toolDrop';
import { COLUMN_PITCH, PMID, snap, STEP_H, STEP_W } from '../../layout/geometry';
import { shownDesignOf } from '../../store/problems';
import { createStudioStore } from '../../store/studioStore';
import { runTool } from '../runTool';
import { DESTRUCTIVE, TOOLS } from '../tools';
import type { ToolContext, ToolOutcome } from '../toolTypes';

const ok = <T,>(value: T) => ({ ok: true, value }) as const;
const notFound = { ok: false, error: { kind: 'notFound', status: 404 } } as const;

/** Steps a and b, both entry steps, not wired to each other; processor FileFetcher 1.2.0 in BaseApi's list. */
const twoSteps = () => graphDto({
  workflow: workflowDto({ entryStepIds: ['s1', 's2'] }),
  steps: [stepDto('s1', { name: 'a', processorId: 'p1' }), stepDto('s2', { name: 'b', processorId: 'p1' })],
  processors: [processorDto('p1', { name: 'fetcher' })],
});

async function setup(graph: WorkflowGraphDto = twoSteps()) {
  const store = createStudioStore();
  store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
  store.dispatch({ type: 'loaded', workflowId: 'wf1', doc: await loadedDocument(graph) });
  const api = {
    listWorkflows: async () => ok([workflowDto({ id: 'wf1' })]),
    listProcessors: async () => ok([processorDto('p1', { name: 'fetcher' }), processorDto('p9', { name: 'FileFetcher', version: '1.2.0', configSchemaId: 'sc9' })]),
    listSchemas: async () => ok([schemaDto('sc9', { name: 'fetch-config' })]),
    listCaches: async () => ok([]),
    getEntity: vi.fn(async () => notFound),
  } as unknown as StudioApi;
  let n = 0;
  const ctx: ToolContext = { store, api, service: createInspectorService(api, store), commands: {} as ToolContext['commands'], newId: () => `n${++n}` };
  // an answer carries the question's pin, wf1 unless a test says otherwise (null: none)
  const call = (name: string, args: object = {}, answer?: string, pin: string | null = 'wf1') =>
    runTool(ctx, { id: 'c1', name, arguments: JSON.stringify(args) }, answer, answer === undefined || pin === null ? undefined : pin);
  const doc = () => store.getState().docs[0]!;
  const shown = () => shownDesignOf(doc())!;
  const stepsNamed = (name: string) => [...shown().graph.steps.values()].filter((s) => s.name === name);
  return { store, ctx, call, doc, shown, stepsNamed };
}
const done = (o: ToolOutcome) => { if (o.kind !== 'done') throw new Error(`asked: ${JSON.stringify(o)}`); return o; };
const ask = (o: ToolOutcome) => { if (o.kind !== 'ask') throw new Error(`done: ${JSON.stringify(o)}`); return o.question; };

describe('the design tools', () => {
  it('are offered, the ones that destroy asking first', () => {
    const names = TOOLS.map((t) => t.function.name);
    expect(names).toEqual(expect.arrayContaining(['add_step', 'set_processor', 'add_cache', 'connect', 'join', 'auto_connect', 'move_blocks',
      'reset_route', 'pick', 'copy', 'paste', 'delete_picked', 'undo', 'redo', 'discard_design']));
    expect(DESTRUCTIVE.has('delete_picked') && DESTRUCTIVE.has('discard_design')).toBe(true);
  });

  it('add_step with processor FileFetcher: a new step with that processor, one Undo step, the Inspector on it', async () => {
    const { call, doc, shown } = await setup();
    const before = new Set(shown().graph.steps.keys());
    const r = done(await call('add_step', { processor: 'FileFetcher' }));
    expect(r.ok).toBe(true);
    expect(r.action).toBe('+ step step with processor FileFetcher 1.2.0');
    const added = [...shown().graph.steps.values()].filter((s) => !before.has(s.id));
    expect(added).toHaveLength(1);
    expect(added[0]!.processorId).toBe('p9');
    expect(r.result).toContain(`id ${added[0]!.id}`);
    expect(canUndo(doc().design)).toBe(true);
    expect(doc().design.past).toHaveLength(1);
    expect(doc().selection).toEqual({ kind: 'step', stepId: added[0]!.id });
    // placed clear of every block, right of the rightmost step on the hub's row
    const p = shown().placement.steps.get(added[0]!.id)!;
    expect(p.x).toBeGreaterThan(Math.max(...[...before].map((id) => shown().placement.steps.get(id)!.x)));
  });

  it('add_step with no processor at a point: an empty step there; set_processor gives it one', async () => {
    const { call, shown, stepsNamed } = await setup();
    const r = done(await call('add_step', { x: 1200, y: 600 }));
    expect(r).toMatchObject({ ok: true, action: '+ step step' });
    const s = stepsNamed('step')[0]!;
    expect(s.processorId).toBeNull();
    expect(shown().placement.steps.get(s.id)).toEqual({ x: 1200, y: 600 });
    const given = done(await call('set_processor', { step: 'step', processor: 'FileFetcher 1.2.0' }));
    expect(given).toMatchObject({ ok: true, action: 'processor of step set to FileFetcher 1.2.0' });
    expect(shown().graph.steps.get(s.id)!.processorId).toBe('p9');
  });

  it('connect a → b: b is a next step of a, no short circuit, one Undo step', async () => {
    const { call, doc } = await setup();
    const r = done(await call('connect', { from: 'a', to: 'b' }));
    expect(r).toMatchObject({ ok: true, action: 'wired a → b (Completed)' });
    const d = doc();
    const saved = applyEdits(d.status.kind === 'ready' ? d.status.doc : (undefined as never), d.edits, d.design.draft.blocks);
    expect(nextOf(saved, d.design.draft, 's1')).toContain('s2');
    expect(r.entries.some((e) => e.kind === 'problems')).toBe(false);
    expect(d.design.past).toHaveLength(1);
  });

  it('connect that would short-circuit is refused and the draft is unchanged', async () => {
    // a → b (Failed); the hub's wire to a held at the ring's right: a new hub wire to b runs on it, another family
    const { store, call, doc } = await setup(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1'] }),
      steps: [stepDto('s1', { name: 'a', nextStepIds: ['s2'] }), stepDto('s2', { name: 'b', entryCondition: 2 })],
    }));
    const d0 = doc();
    const base = d0.status.kind === 'ready' ? d0.status.doc : (undefined as never);
    store.dispatch({ type: 'design', workflowId: 'wf1', draft: withCircuit(EMPTY_DRAFT, base, setEnd(circuitOf(base, EMPTY_DRAFT), 'wf->s1', 'tail', { on: 'hub', angle: 0 })) });
    const draft = doc().design.draft;
    const r = done(await call('connect', { from: 'workflow', to: 'b' }));
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/short circuit/);
    expect(r.result).toContain('overlaps');
    expect(doc().design.draft).toBe(draft);
  });

  it('an entry condition that would make a fan-out trunk carry two families is refused, nothing typed', async () => {
    // a → b and a → c share one trunk (a → c's tail a junction on a → b): one net, Completed
    const { store, call, doc } = await setup(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1'] }),
      steps: [stepDto('s1', { name: 'a', nextStepIds: ['s2', 's3'] }), stepDto('s2', { name: 'b' }), stepDto('s3', { name: 'c' })],
    }));
    const d0 = doc();
    const base = d0.status.kind === 'ready' ? d0.status.doc : (undefined as never);
    store.dispatch({ type: 'design', workflowId: 'wf1', draft: withCircuit(EMPTY_DRAFT, base, setEnd(circuitOf(base, EMPTY_DRAFT), 's1->s3', 'tail', { on: 'wire', host: 's1->s2', at: 40 })) });
    const r = done(await call('set_field', { target: { kind: 'step', step: 'c' }, field: 'entryCondition', value: 'Failed' }));
    expect(r.ok).toBe(false);
    expect(r.result).toContain('short circuit: Completed meets Failed');
    expect(doc().edits.steps).toEqual({});
  });

  it('pick + copy + paste: two steps of the same name, the copy with a new id', async () => {
    const { call, stepsNamed } = await setup();
    expect(done(await call('pick', { items: ['a'] }))).toMatchObject({ ok: true, action: 'picked step a' });
    expect(done(await call('copy'))).toMatchObject({ ok: true, action: 'copied step a' });
    const r = done(await call('paste'));
    expect(r.ok).toBe(true);
    const named = stepsNamed('a');
    expect(named).toHaveLength(2);
    expect(new Set(named.map((s) => s.id)).size).toBe(2);
    const copy = named.find((s) => s.id !== 's1')!;
    expect(r.result).toContain(`id ${copy.id}`);
    expect(copy.processorId).toBe('p1');
  });

  it('delete_picked asks, naming what goes, and deletes only after Yes', async () => {
    const { call, stepsNamed, doc } = await setup();
    done(await call('pick', { items: ['b'] }));
    const q = ask(await call('delete_picked'));
    expect(q).toMatchObject({ text: 'Delete step b, wire workflow → b from orders 1.0.0?', choices: ['Yes', 'No'], pin: 'wf1' });
    expect(stepsNamed('b')).toHaveLength(1);
    expect(done(await call('delete_picked', {}, 'No'))).toMatchObject({ ok: false, result: 'the user declined' });
    expect(stepsNamed('b')).toHaveLength(1);
    ask(await call('delete_picked'));
    const r = done(await call('delete_picked', {}, 'Yes'));
    expect(r).toMatchObject({ ok: true, action: 'deleted step b, wire workflow → b' });
    expect(stepsNamed('b')).toHaveLength(0);
    // Undo brings it back
    expect(done(await call('undo'))).toMatchObject({ ok: true });
    expect(stepsNamed('b')).toHaveLength(1);
    expect(doc().design.future).toHaveLength(1);
  });

  it('delete_picked: a Yes after the picks changed, or with no pin, deletes nothing', async () => {
    const { call, stepsNamed } = await setup();
    done(await call('pick', { items: ['b'] }));
    ask(await call('delete_picked'));
    done(await call('pick', { items: ['a'] }));
    expect(done(await call('delete_picked', {}, 'Yes')).result).toContain('picks changed');
    expect(stepsNamed('a')).toHaveLength(1);
    ask(await call('delete_picked'));
    expect(done(await call('delete_picked', {}, 'Yes', null)).result).toContain('ask again');
    expect(stepsNamed('a')).toHaveLength(1);
  });

  it('auto_connect, move_blocks and reset_route act as the canvas does', async () => {
    const { call, shown, doc } = await setup();
    const r = done(await call('auto_connect', { block: 'b', dir: 'right' }));
    expect(r.ok).toBe(true);
    const made = [...shown().graph.steps.values()].find((s) => s.id !== 's1' && s.id !== 's2')!;
    expect(shown().graph.steps.get('s2')!.nextStepIds).toContain(made.id);
    // b's output has a wire now: no right arrow
    expect(done(await call('auto_connect', { block: 'b', dir: 'right' })).ok).toBe(false);
    const m = done(await call('move_blocks', { moves: [{ block: 'a', x: 403, y: 597 }] }));
    expect(m.ok).toBe(true);
    expect(shown().placement.steps.get('s1')).toEqual({ x: 400, y: 600 });
    expect(doc().design.past).toHaveLength(2);
    expect(done(await call('reset_route', { wire: 'b -> step' })).result).toContain('no route of its own');
  });

  it('discard_design asks, then drops the draft', async () => {
    const { call, doc } = await setup();
    expect(done(await call('discard_design')).result).toContain('nothing to discard');
    done(await call('add_step'));
    expect(ask(await call('discard_design')).text).toContain('Discard every unsaved change to orders 1.0.0');
    done(await call('discard_design', {}, 'Yes'));
    expect(doc().design.draft).toEqual(EMPTY_DRAFT);
  });

  it('join: a fan-in head becomes a junction on the trunk; a hub tail is refused', async () => {
    const { call, shown } = await setup(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1', 's2'] }),
      steps: [stepDto('s1', { name: 'a', nextStepIds: ['s3'] }), stepDto('s2', { name: 'b', nextStepIds: ['s3'] }), stepDto('s3', { name: 'c' })],
    }));
    const r = done(await call('join', { wire: 'b -> c', side: 'head', host: 'a -> c' }));
    expect(r.ok).toBe(true);
    const w = shown().wires.find((x) => x.id === 's2->s3')!;
    expect(w.headOn).toBe('junction');
    expect(shown().graph.steps.get('s2')!.nextStepIds).toContain('s3');
    const hub = done(await call('join', { wire: 'workflow -> a', side: 'tail', host: 'workflow -> b' }));
    expect(hub.result).toContain('workflow circle');
    expect(hub.action).toBe("join workflow → a's tail on workflow → b");
  });

  it('join: a fan-out tail becomes a junction on a trunk of its family; a tail of another family is refused', async () => {
    // a feeds b and c (Completed) and d (Failed)
    const { call, shown, doc } = await setup(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1'] }),
      steps: [stepDto('s1', { name: 'a', nextStepIds: ['s2', 's3', 's4'] }), stepDto('s2', { name: 'b' }), stepDto('s3', { name: 'c' }), stepDto('s4', { name: 'd', entryCondition: 2 })],
    }));
    const ok = done(await call('join', { wire: 'a -> c', side: 'tail', host: 'a -> b' }));
    expect(ok).toMatchObject({ ok: true, action: "joined a → c's tail on a → b" });
    expect(shown().wires.find((x) => x.id === 's1->s3')!.tailOn).toBe('junction');
    expect(shown().graph.steps.get('s1')!.nextStepIds).toEqual(['s2', 's3', 's4']);
    const draft = doc().design.draft;
    const other = done(await call('join', { wire: 'a -> d', side: 'tail', host: 'a -> b' }));
    expect(other.ok).toBe(false);
    expect(other.result).toContain('not of one family');
    expect(other.action).toBe("join a → d's tail on a → b");
    expect(doc().design.draft).toBe(draft);
  });

  it('connect from "workflow": a new entry step', async () => {
    const { call, shown } = await setup(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1'] }),
      steps: [stepDto('s1', { name: 'a', nextStepIds: ['s2'] }), stepDto('s2', { name: 'b' })],
    }));
    const r = done(await call('connect', { from: 'workflow', to: 'b' }));
    expect(r).toMatchObject({ ok: true, action: 'wired workflow → b (Completed)' });
    expect(shown().graph.workflow.entryStepIds).toEqual(['s1', 's2']);
    // a refusal names what was asked
    expect(done(await call('connect', { from: 'nope', to: 'b' })).action).toBe('connect nope → b');
  });

  it('add_step with no point never splits a wire: the spot right of the row that lies on a wire is passed over', async () => {
    // a on the hub's row; d → e moved so their wire runs up through the spot right of a
    const { call, shown, doc } = await setup(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1', 's2'] }),
      steps: [stepDto('s1', { name: 'a' }), stepDto('s2', { name: 'd', nextStepIds: ['s3'] }), stepDto('s3', { name: 'e' })],
    }));
    const { cx, cy } = shown().placement.sphere;
    const rowY = snap(cy - PMID);
    const a = shown().placement.steps.get('s1')!;
    const spot = { x: a.x + COLUMN_PITCH, y: rowY };
    done(await call('move_blocks', { moves: [{ block: 'a', x: a.x, y: rowY }, { block: 'd', x: spot.x - 192, y: rowY + 480 }, { block: 'e', x: spot.x + 320, y: rowY - 480 }] }));
    expect(shown().placement.steps.get('s2')!.y).toBeGreaterThan(rowY + STEP_H);
    expect(cx).toBeLessThan(spot.x);
    // the plain spot would split d → e (the precondition of this test)
    const d0 = doc();
    const saved = applyEdits(d0.status.kind === 'ready' ? d0.status.doc : (undefined as never), d0.edits, d0.design.draft.blocks);
    expect(judgeTool(shown(), { kind: 'step' }, { x: spot.x + STEP_W / 2, y: spot.y + STEP_H / 2 }, { circuit: circuitOf(saved, d0.design.draft), reach: 0 }).kind).toBe('split');

    const relations = () => {
      const g = shown().graph;
      return { entries: g.workflow.entryStepIds, next: ['s1', 's2', 's3'].map((id) => g.steps.get(id)!.nextStepIds), at: ['s1', 's2', 's3'].map((id) => shown().placement.steps.get(id)) };
    };
    const before = relations();
    const r = done(await call('add_step'));
    expect(r.ok).toBe(true);
    expect(relations()).toEqual(before);
    const made = [...shown().graph.steps.values()].find((s) => !['s1', 's2', 's3'].includes(s.id))!;
    expect(made.nextStepIds).toEqual([]);
    expect(shown().wires.some((w) => w.source === made.id || w.target === made.id)).toBe(false);
  });
});
