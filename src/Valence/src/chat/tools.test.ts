import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectData } from '../api/project';
import { createHighlights } from '../app/highlights';
import { createWorkspace } from '../app/workspace';
import { canvasBridge, type CanvasApi } from '../molecule/bridge';
import type { Vec } from '../molecule/layout';
import { buildMolecule } from '../molecule/model';
import project from '../test/fixtures/project.json';
import { runTool } from './runTool';
import { DESTRUCTIVE, TOOL_DEFS } from './tools';
import type { ToolContext, ToolOutcome } from './toolTypes';

const data = project as ProjectData;
const WF = `wf:${data.workflows[0]!.id}`; // kafka-import-export
const ENTRY = `step:${data.workflows[0]!.entryStepIds![0]}`; // step-kafka-importer
const IMPORTER = `proc:${data.steps.find((s) => `step:${s.id}` === ENTRY)!.processorId}`; // kafka-importer 2.2.0

let places: Map<string, Vec>;
function setup(): ToolContext {
  const workspace = createWorkspace();
  workspace.loaded(data, buildMolecule(data));
  places = new Map([...workspace.get().molecule!.atoms.keys()].map((k, i) => [k, [i, 0, 0] as Vec]));
  canvasBridge.set({ positions: () => new Map(places), place: (p: ReadonlyMap<string, Vec>) => p.forEach((v, k) => places.set(k, v)), rekey: () => {} } as unknown as CanvasApi);
  return { workspace, highlights: createHighlights([]) };
}
const call = (ctx: ToolContext, name: string, args: object = {}, answer?: string, pin?: string) =>
  runTool(ctx, { id: 'c1', name, arguments: JSON.stringify(args) }, answer, pin);
const result = (o: ToolOutcome) => (o.kind === 'done' ? o.result : `asked: ${o.question.text}`);

afterEach(() => { canvasBridge.set(null); vi.unstubAllGlobals(); });

describe("Valence's chat tools (2026-10-26)", () => {
  let ctx: ToolContext;
  beforeEach(() => { ctx = setup(); });

  it('has one tool per gesture, and only the apply asks first', () => {
    expect(TOOL_DEFS.map((t) => t.name)).toEqual(['list_atoms', 'read_atom', 'read_changes', 'read_view', 'read_output',
      'pin', 'highlight_workflows', 'set_field', 'revert', 'delete', 'create_atom', 'draw_arrow', 'copy_atom', 'paste', 'undo', 'redo', 'move_atom', 'apply_changes']);
    expect([...DESTRUCTIVE]).toEqual(['apply_changes']);
  });

  it('lists atoms by kind, by what a workflow reaches and by name; reads one with its fields, arrows and Delete verdict', async () => {
    const procs = result(await call(ctx, 'list_atoms', { type: 'processor' }));
    expect(procs).toMatch(/^11 processors:/);
    expect(procs).toContain(`${IMPORTER} | processor kafka-importer 2.2.0 | health: Checking…`);
    const reach = result(await call(ctx, 'list_atoms', { workflow: 'kafka-import-export' }));
    expect(reach).toContain(ENTRY);
    expect(reach).not.toContain('file-fetcher');
    expect(result(await call(ctx, 'list_atoms', { query: 'ARCHIVE-exp', type: 'proc' }))).toMatch(/^1 processors named \*archive-exp\*:/);

    const read = result(await call(ctx, 'read_atom', { target: 'kafka-importer' }));
    expect(read).toContain('"field":"name"');
    expect(read).toMatch(/arrows in:\n {2}uses\|step:/);
    expect(read).toMatch(/delete: refused: kafka-importer cannot be deleted/);
  });

  it('says a name is ambiguous, and finds an atom by "name version"', async () => {
    const out = await call(ctx, 'read_atom', { target: 'simple-stepA' });
    expect(out).toMatchObject({ ok: false });
    expect(result(out)).toMatch(/"simple-stepA" is ambiguous: step simple-stepA 1\.0\.0 \(step:/);
    expect(result(await call(ctx, 'pin', { target: 'kafka-importer 2.2.0' }))).toBe('pinned processor kafka-importer 2.2.0');
  });

  it('pins as a click does, and highlights workflows as the filter does', async () => {
    await call(ctx, 'pin', { target: ENTRY });
    expect(ctx.workspace.get().pinned).toBe(ENTRY);
    await call(ctx, 'pin', {});
    expect(ctx.workspace.get().pinned).toBeNull();

    await call(ctx, 'highlight_workflows', { workflows: ['kafka-import-export'] });
    await call(ctx, 'highlight_workflows', { workflows: ['sc-chain'], add: true });
    expect(ctx.highlights.get()).toEqual([WF, `wf:${data.workflows[1]!.id}`]);
    expect(result(await call(ctx, 'read_view'))).toContain('highlighted workflows: kafka-import-export');
    await call(ctx, 'highlight_workflows', { workflows: [] });
    expect(ctx.highlights.get()).toEqual([]);
    expect(await call(ctx, 'highlight_workflows', { workflows: ['file-fetcher'] })).toMatchObject({ ok: false });
  });

  it('edits a field as the Inspector does (pinned, virtual, judged by its rule), reverts it, and undoes', async () => {
    const out = await call(ctx, 'set_field', { atom: IMPORTER, field: 'description', value: 'reads Kafka' });
    expect(out).toMatchObject({ ok: true });
    expect(ctx.workspace.get().edits[IMPORTER]).toEqual({ description: 'reads Kafka' });
    expect(ctx.workspace.get().pinned).toBe(IMPORTER);
    expect(await call(ctx, 'set_field', { atom: IMPORTER, field: 'version', value: 'two' })).toMatchObject({ ok: false });
    expect(await call(ctx, 'set_field', { atom: IMPORTER, field: 'colour', value: 'x' })).toMatchObject({ ok: false });

    await call(ctx, 'revert', { atom: IMPORTER });
    expect(ctx.workspace.get().edits[IMPORTER]).toBeUndefined();
    const undo = await call(ctx, 'undo');
    expect(result(undo)).toMatch(/Output:\nUndid: /);
    expect(ctx.workspace.get().edits[IMPORTER]).toBeDefined();
  });

  it("deletes under the rules, echoing Output's refusal", async () => {
    const refused = await call(ctx, 'delete', { target: IMPORTER });
    expect(refused).toMatchObject({ ok: false });
    expect(result(refused)).toMatch(/Output:\n\[refused\] kafka-importer cannot be deleted/);
    const cache = `cache:${data.caches[0]!.id}`;
    expect(await call(ctx, 'delete', { target: cache })).toMatchObject({ ok: true });
    expect(ctx.workspace.get().removed.atoms).toEqual([cache]);
  });

  it('makes an atom on its target with its fields, beside it; draws an arrow; copies and pastes', async () => {
    const made = await call(ctx, 'create_atom', { type: 'step', on: 'kafka-importer', fields: { name: 'read-more', version: '1.0.0' } });
    expect(made).toMatchObject({ ok: true });
    const key = ctx.workspace.get().pinned!;
    expect(ctx.workspace.get().created.map((c) => c.key)).toEqual([key]);
    expect(ctx.workspace.get().edits[key]).toEqual({ name: 'read-more' });
    expect(ctx.workspace.get().created[0]!.pos).not.toEqual(places.get(IMPORTER));
    expect(await call(ctx, 'create_atom', { type: 'step' })).toMatchObject({ ok: false });

    expect(await call(ctx, 'draw_arrow', { kind: 'next', tail: ENTRY, head: key })).toMatchObject({ ok: true });
    expect(ctx.workspace.get().added).toEqual([`next|${ENTRY}|${key}`]);

    expect(await call(ctx, 'copy_atom', { atom: 'file-fetcher' })).toMatchObject({ ok: true });
    expect(await call(ctx, 'paste')).toMatchObject({ ok: true });
    expect(ctx.workspace.get().created).toHaveLength(2);
  });

  it('moves an atom on the canvas only', async () => {
    await call(ctx, 'move_atom', { atom: IMPORTER, x: 4, y: 5 });
    expect(places.get(IMPORTER)).toEqual([4, 5, 0]);
    expect(ctx.workspace.get().history.past).toHaveLength(0);
  });

  it('asks before applying; Cancel applies nothing; Apply sends the changes once, if they did not change meanwhile', async () => {
    expect(await call(ctx, 'apply_changes')).toMatchObject({ ok: false, result: expect.stringMatching(/^Apply is not ready: Nothing to apply/) });
    await call(ctx, 'set_field', { atom: IMPORTER, field: 'description', value: 'reads Kafka' });
    ctx.workspace.judged({ kind: 'done', ok: true, planned: 1, refused: 0, byAtom: {} });
    const asked = await call(ctx, 'apply_changes');
    expect(asked.kind).toBe('ask');
    if (asked.kind !== 'ask') return;
    expect(asked.question.choices).toEqual(['Apply', 'Cancel']);
    expect(asked.question.warnings![0]).toMatch(/^updated: processor kafka-importer/);

    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ ok: true, applied: true, results: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchFn);
    expect(await call(ctx, 'apply_changes', {}, 'Cancel', asked.question.pin)).toMatchObject({ ok: true, result: 'the user cancelled: nothing applied' });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await call(ctx, 'apply_changes', {}, 'Apply', 'other')).toMatchObject({ ok: false });
    expect(fetchFn).not.toHaveBeenCalled();

    const applied = await call(ctx, 'apply_changes', {}, 'Apply', asked.question.pin);
    expect(applied).toMatchObject({ ok: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result(applied)).toMatch(/Output:\nApplied 1 change to BaseApi/);
    expect(ctx.workspace.get().edits).toEqual({});
  });
});
