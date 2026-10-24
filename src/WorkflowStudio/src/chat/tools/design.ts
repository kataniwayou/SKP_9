import { describeError } from '../../api/describeError';
import { cacheFromDto, processorFromDto, schemaFromDto } from '../../api/toModel';
import type { StudioDocument } from '../../app/document';
import { addCircuitWire, NEW_WIRE_PREFIX, setBends, setEnd, shiftWires, snapAngle, type Circuit, type CircuitWire, type End, type Side } from '../../circuit/circuit';
import { applyDraft, applyEdits } from '../../design/apply';
import { arrowsOf, autoTarget, type Dir } from '../../design/autoConnect';
import { blockBoxes, clipOrigin, freeOffset } from '../../design/clipboard';
import { circuitOf, moveBlocks, resetShape, withCircuit, type Draft } from '../../design/draft';
import { isAssignmentStep, redoStepOf, undoStepOf, type AssignmentStep } from '../../design/history';
import { dropLabel, judgeDrop, toneOf } from '../../design/drop';
import { nodeBox } from '../../design/hit';
import { shortCircuitErrors } from '../../design/shortCircuits';
import { dropTool, judgeTool, type ToolItem } from '../../design/toolDrop';
import { wireName } from '../../design/wireName';
import { WORKFLOW_SOURCE } from '../../layout/ports';
import { CACHE_H, CACHE_W, CELL, COLUMN_PITCH, GRID, LANDING_MAX, LANDING_MIN, LAYOUT_GAP, PMID, snap, SPHERE_R, STEP_H, STEP_W, type Point } from '../../layout/geometry';
import { CONTACT_MARGIN, lengthOf, nearestOn } from '../../layout/junctions';
import type { Pt } from '../../layout/router';
import { JOG, type Bends } from '../../layout/shape';
import { cacheNodeId, CACHE_NODE_PREFIX, SPHERE_NODE_ID } from '../../layout/nodeIds';
import { conditionInfo } from '../../model/entryConditions';
import type { Id } from '../../model/graph';
import { pickKey, type Pick } from '../../store/picks';
import { entityLabel, shownDesignOf } from '../../store/problems';
import { designLocked, reduce, type OpenDocument, type StudioAction } from '../../store/studioState';
import type { ChatEntry } from '../chatStore';
import { withEcho } from '../echo';
import { findCache, findProcessor, findStep, findWire, reachedEnd, shownCircuitOf, type Found } from '../resolve';
import type { ToolContext, ToolDef } from '../toolTypes';
import { docOf, done, fail, labelOf, openDocOf, questionDocOf, text, workflowOf, WORKFLOW_ARG, YES_NO, type DocChoice } from './common';

// The design tools (2026-10-23): each is one of the canvas's own actions (a Toolbox drop, an AutoConnect click, a
// finished wire or block drag, Ctrl+C / Ctrl+V, Delete, Undo), dispatched to the store as the gesture dispatches it, so
// it is one Undo step and the canvas shows it at once. An action whose design would gain a short circuit is refused
// before it is dispatched: the design stays as it was and the model hears which nets collide.

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The document's design as the canvas draws it: the loaded workflow with the entity edits and the blocks (`saved`), the draft over it (`shown`). */
export function layersOf(doc: OpenDocument): { base: StudioDocument; saved: StudioDocument; shown: StudioDocument; draft: Draft } {
  if (doc.status.kind !== 'ready') throw new Error(`${doc.name} is not loaded`);
  const base = doc.status.doc, draft = doc.design.draft;
  const saved = applyEdits(base, doc.edits, draft.blocks);
  return { base, saved, shown: applyDraft(saved, draft), draft };
}

/** The open, loaded workflow a design tool means (named, else the active one), its design not locked; or why not. */
export async function designDocOf(ctx: ToolContext, ref: string | undefined, action: string): Promise<DocChoice> {
  const w = await workflowOf(ctx, ref);
  if (!w.ok) return { out: fail(w.error, action) };
  const doc = w.value.doc;
  if (doc === null) return { out: fail(`workflow ${ref} is not open; open it first`, action) };
  return usable(doc, action);
}

function usable(doc: OpenDocument, action: string): DocChoice {
  if (doc.status.kind !== 'ready') return { out: fail(`workflow ${doc.name} is not loaded yet`, action) };
  if (designLocked(doc)) return { out: fail(`the design of ${doc.name} is read-only now: a Save is under way; try again when it is over`, action) };
  return { doc };
}

/** The open, loaded workflow a tool that changes no design means (a pick, a copy): it works while the design is locked. */
async function loadedDocOf(ctx: ToolContext, ref: string | undefined, action: string): Promise<DocChoice> {
  const found = await openDocOf(ctx, ref, action);
  if ('out' in found) return found;
  return found.doc.status.kind === 'ready' ? found : { out: fail(`workflow ${found.doc.name} is not loaded yet`, action) };
}

/** The workflow a call that asks first acts on (the pin rule, `questionDocOf`), loaded and its design not locked. */
export const askedDocOf = (ctx: ToolContext, tool: string, ref: string | undefined, answer: string | undefined, pin: string | undefined): Promise<DocChoice> =>
  questionDocOf(ctx, tool, answer, pin, () => designDocOf(ctx, ref, tool), (doc) => usable(doc, tool));

/** The design's short circuits, each as one line naming where it is and which families or wires collide. */
function shortsOf(doc: OpenDocument): Map<string, string> {
  const shown = shownDesignOf(doc);
  if (shown === null || doc.status.kind !== 'ready') return new Map();
  const loaded = doc.status.doc.graph;
  return new Map(shortCircuitErrors(shown, doc.design.draft).map((e) => [`${e.id}|${e.message}`, `${entityLabel(e, shown.graph, shown, loaded)}: ${e.message}`]));
}

export type Acted = { ok: true; entries: ChatEntry[]; before: OpenDocument; after: OpenDocument } | { ok: false; error: string };

/**
 * Carries out one studio action on a workflow (`run`, by default dispatching `action`), first judged on the state as it
 * is now: `action` reduced on it shows what it would do. Refused when that would add a short circuit, or, given
 * `unchanged`, when it would change neither the design nor the edits (the gesture was refused: `unchanged` says why).
 * The Output lines and problems it causes are echoed.
 */
export async function act(ctx: ToolContext, id: Id, action: StudioAction, opts: { unchanged?: string; run?: () => void } = {}): Promise<Acted> {
  const state = ctx.store.getState();
  const before = state.docs.find((d) => d.workflowId === id);
  if (!before) return { ok: false, error: 'the workflow is no longer open' };
  const preview = reduce(state, action).docs.find((d) => d.workflowId === id)!;
  const changed = (d: OpenDocument) => d.design.draft !== before.design.draft || d.edits !== before.edits;
  if (opts.unchanged !== undefined && !changed(preview)) return { ok: false, error: opts.unchanged };
  const had = shortsOf(before);
  const added = [...shortsOf(preview)].filter(([k]) => !had.has(k)).map(([, line]) => line);
  if (added.length > 0) return { ok: false, error: `refused, the design is unchanged: it would add a short circuit (${added.join('; ')})` };
  const { entries } = await withEcho(ctx.store, () => [id], async () => { (opts.run ?? (() => ctx.store.dispatch(action)))(); });
  const after = docOf(ctx, id);
  if (!after) return { ok: false, error: 'the workflow closed meanwhile' };
  if (opts.unchanged !== undefined && !changed(after)) return { ok: false, error: opts.unchanged };
  return { ok: true, entries, before, after };
}

/**
 * A wire in the chat's words: "from → to", a step by its name, the hub as workflow, else a junction or an open end;
 * given the circuit, an end on a junction by what it reaches through it (a fan-out branch is "a → e" too).
 */
export function wireText(shown: StudioDocument, id: string, circuit?: Readonly<Circuit>): string {
  const w = shown.wires.find((x) => x.id === id);
  if (!w) return wireName(shown, id) ?? id;
  const name = (s: string | null, on: string) => (s === null ? (on === 'junction' ? 'a junction' : 'an open end') : s === WORKFLOW_SOURCE ? 'workflow' : shown.graph.steps.get(s)?.name ?? s);
  const tail = circuit ? reachedEnd(circuit, id, 'tail') ?? w.source : w.source, head = circuit ? reachedEnd(circuit, id, 'head') ?? w.target : w.target;
  return `${name(tail, w.tailOn)} → ${name(head, w.headOn)}`;
}

/** What an action added to and removed from the drawing: steps, caches and wires, each named as the canvas names it. */
function changesOf(before: OpenDocument, after: OpenDocument): { added: string[]; removed: string[]; newSteps: Id[] } {
  const b = shownDesignOf(before)!, a = shownDesignOf(after)!;
  const cb = shownCircuitOf(before) ?? undefined, ca = shownCircuitOf(after) ?? undefined;
  const added: string[] = [], removed: string[] = [], newSteps: Id[] = [];
  for (const s of a.graph.steps.values()) if (!b.graph.steps.has(s.id)) { added.push(`step ${s.name} (id ${s.id})`); newSteps.push(s.id); }
  for (const c of a.graph.caches.values()) if (!b.graph.caches.has(c.id)) added.push(`cache ${labelOf(c)} (id ${c.id})`);
  for (const w of a.wires) if (!b.wires.some((x) => x.id === w.id)) added.push(`wire ${wireText(a, w.id, ca)} (id ${w.id})`);
  for (const s of b.graph.steps.values()) if (!a.graph.steps.has(s.id)) removed.push(`step ${s.name}`);
  for (const c of b.graph.caches.values()) if (!a.graph.caches.has(c.id)) removed.push(`cache ${labelOf(c)}`);
  for (const w of b.wires) if (!a.wires.some((x) => x.id === w.id)) removed.push(`wire ${wireText(b, w.id, cb)}`);
  return { added, removed, newSteps };
}

/** The wires drawn both before and after an action whose family changed, in the chat's words. */
function recoloured(before: OpenDocument, after: OpenDocument): { wire: string; from: string; to: string }[] {
  const b = shownDesignOf(before)!, a = shownDesignOf(after)!;
  const was = new Map(b.wires.map((w) => [w.id, w.condition]));
  const name = (c: number | null | undefined) => (c == null ? 'undecided' : conditionInfo(c).name);
  return a.wires.filter((w) => was.has(w.id) && was.get(w.id) !== w.condition).map((w) => ({ wire: wireText(a, w.id, shownCircuitOf(after) ?? undefined), from: name(was.get(w.id)), to: name(w.condition) }));
}

/** A block of the drawing by what the model wrote: "workflow" (the hub), a step, or a cache, by name or id; its React Flow node id. */
function blockOf(doc: OpenDocument, shown: StudioDocument, ref: string): Found<{ node: string; label: string }> {
  if (same(ref, 'workflow') || same(ref, SPHERE_NODE_ID)) return { ok: true, value: { node: SPHERE_NODE_ID, label: 'the workflow' } };
  const step = findStep(doc, ref);
  if (step.ok) return { ok: true, value: { node: step.value, label: `step ${shown.graph.steps.get(step.value)?.name ?? step.value}` } };
  if (step.ambiguous) return step;
  const bare = ref.trim().startsWith(CACHE_NODE_PREFIX) ? ref.trim().slice(CACHE_NODE_PREFIX.length) : ref;
  const cache = findCache([...shown.graph.caches.values()], bare);
  if (cache.ok) return { ok: true, value: { node: cacheNodeId(cache.value.id), label: `cache ${labelOf(cache.value)}` } };
  if (cache.ambiguous) return cache;
  return { ok: false, error: `nothing named ${ref} in ${doc.name}: name a step or a cache (name or id), or "workflow"` };
}

/** An existing processor as a Toolbox tile drags it: the entity and the schemas its slots name, from BaseApi's lists. */
async function processorItem(ctx: ToolContext, ref: string): Promise<Found<Extract<ToolItem, { kind: 'processor' }>>> {
  if (!ctx.api.listProcessors) return { ok: false, error: 'cannot list processors here' };
  const list = await ctx.api.listProcessors();
  if (!list.ok) return { ok: false, error: `could not list processors. ${describeError(list.error)}` };
  const found = findProcessor(list.value, ref);
  if (!found.ok) return found;
  const processor = processorFromDto(found.value);
  const schemas = ctx.api.listSchemas ? await ctx.api.listSchemas() : null;
  const byId = new Map((schemas?.ok ? schemas.value : []).map(schemaFromDto).map((s) => [s.id, s]));
  const slots = [processor.inputSchemaId, processor.outputSchemaId, processor.configSchemaId]
    .flatMap((sid) => { const s = sid ? byId.get(sid) : undefined; return s ? [s] : []; });
  return { ok: true, value: { kind: 'processor', processor, schemas: slots } };
}

/** The top-left the model gave, else null; both or neither. */
function pointArg(args: Record<string, unknown>): Found<Point | null> {
  const x = num(args.x), y = num(args.y);
  if (x === undefined && y === undefined) return { ok: true, value: null };
  if (x === undefined || y === undefined) return { ok: false, error: 'give both x and y (the top-left corner, flow px), or neither' };
  return { ok: true, value: { x, y } };
}

type Box = { x: number; y: number; w: number; h: number };

/** Every run of every drawn wire as a thin box, for a placement to keep off. */
const wireBoxes = (shown: StudioDocument): Box[] => shown.wires.flatMap((w) => w.points.slice(1).map((b, i) => {
  const a = w.points[i]!;
  return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.max(1, Math.abs(a[0] - b[0])), h: Math.max(1, Math.abs(a[1] - b[1])) };
}));

/** How many spots a placement tries before it gives up keeping off the wires. */
const SPOT_TRIES = 64;

/**
 * Where a new step goes when the model names no point: one column right of the rightmost step on the hub's row (in line
 * with the hub, as AutoConnect lands one), else one gap right of the hub; moved to the nearest spot (`freeOffset`) clear
 * of every block and every wire's run. A placement the model did not choose never changes what is wired to what
 * (review 2026-10-23): a spot where the Toolbox drop would split a wire (`judgeTool`) is passed over for the next.
 */
export function freeStepSpot(shown: StudioDocument, circuit: Readonly<Circuit>): Point {
  const { cx, cy } = shown.placement.sphere;
  const rowY = snap(cy - PMID);
  const row = [...shown.placement.steps.values()].filter((p) => Math.abs(p.y - rowY) < STEP_H / 2);
  const x = snap(row.length > 0 ? Math.max(...row.map((p) => p.x)) + COLUMN_PITCH : cx + SPHERE_R + LAYOUT_GAP);
  const box = { x, y: rowY, w: STEP_W, h: STEP_H };
  const obstacles = [...blockBoxes(shown), ...wireBoxes(shown)];
  let spot: Point = { x, y: rowY };
  for (let i = 0; i < SPOT_TRIES; i++) {
    const off = freeOffset([box], obstacles, { x: 0, y: 0 });
    spot = { x: x + off.x, y: rowY + off.y };
    if (judgeTool(shown, { kind: 'step' }, centred(spot, STEP_W, STEP_H), { circuit, reach: 0 }).kind !== 'split') return spot;
    obstacles.push({ ...spot, w: STEP_W, h: STEP_H });
  }
  return spot;
}

/** Where a new cache goes when the model names no point: under the hub, as a loaded workflow's caches stack, the nearest free spot. */
function freeCacheSpot(shown: StudioDocument): Point {
  const { cx, cy } = shown.placement.sphere;
  const at = { x: snap(cx - CACHE_W / 2), y: snap(cy + SPHERE_R + CELL) };
  const off = freeOffset([{ ...at, w: CACHE_W, h: CACHE_H }], blockBoxes(shown), { x: 0, y: 0 });
  return { x: at.x + off.x, y: at.y + off.y };
}

/** A block's top-left as the drop's pointer: the Toolbox drops a block centred on the pointer. */
const centred = (p: Point, w: number, h: number): Point => ({ x: p.x + w / 2, y: p.y + h / 2 });

const PLACE = {
  x: { type: 'number', description: 'Top-left x of the new block (flow px, as read_design gives positions). Leave out x and y to let the studio place it.' },
  y: { type: 'number', description: 'Top-left y of the new block (flow px).' },
};

const addStepTool: ToolDef = {
  name: 'add_step',
  description: 'Add a new step, empty or with an existing processor (as a Toolbox drop on the canvas). It is named step, step-2, … and has entry condition Completed; rename it with set_field. Without x and y it goes right of the rightmost step on the workflow circle\'s row. Dropped on a wire\'s run, the wire is split through it, as on the canvas.',
  parameters: {
    type: 'object',
    properties: { workflow: WORKFLOW_ARG, processor: { type: 'string', description: 'An existing processor: id, name, or "name version" (list_processors). Leave out for an empty step.' }, ...PLACE },
    additionalProperties: false,
  },
  async run(ctx, args) {
    const ref = text(args.processor);
    const asked = `add step${ref === undefined ? '' : ` with processor ${ref}`}`;
    const point = pointArg(args);
    if (!point.ok) return fail(point.error, asked);
    const item = ref === undefined ? null : await processorItem(ctx, ref);
    if (item !== null && !item.ok) return fail(item.error, asked);
    // the state as it is now, after the lists were read
    const found = await designDocOf(ctx, text(args.workflow), asked);
    if ('out' in found) return found.out;
    const { doc } = found;
    const id = doc.workflowId;
    const { base, saved, shown, draft } = layersOf(doc);
    const topLeft = point.value ?? freeStepSpot(shown, circuitOf(saved, draft));
    const at = centred({ x: snap(topLeft.x), y: snap(topLeft.y) }, STEP_W, STEP_H);
    let action: StudioAction = { type: 'toolDrop', workflowId: id, item: { kind: 'step' }, at, newId: ctx.newId };
    let stepId: Id | null = null;
    if (item !== null) {
      // a step with a processor (the spec's "processor drop on empty canvas"): the step dropped, then the processor on it, one Undo step
      const placed = dropTool(base, doc.edits, doc.design.draft, { kind: 'step' }, at, ctx.newId);
      if (placed === null) return fail('the step could not be placed there', `${asked} refused`);
      stepId = placed.picks[0]!.id;
      const withStep = applyDraft(applyEdits(base, doc.edits, placed.draft.blocks), placed.draft);
      const p = withStep.placement.steps.get(stepId)!;
      const given = dropTool(base, doc.edits, placed.draft, item.value, centred(p, STEP_W, STEP_H), ctx.newId);
      if (given === null) return fail('the processor could not be given to the new step', `${asked} refused`);
      action = { type: 'design', workflowId: id, draft: given.draft, picks: [{ kind: 'node', id: stepId }] };
    }
    const r = await act(ctx, id, action, { unchanged: 'the step could not be placed there' });
    if (!r.ok) return fail(r.error, `${asked} refused`);
    const { added, newSteps } = changesOf(r.before, r.after);
    const made = stepId ?? newSteps[0] ?? null;
    // the Inspector shows the new step, as after a Toolbox drop (the drop itself selects it; the composed one does here)
    // (a select takes the Inspector back from the Toolbox, as the reducer does for a drop)
    if (made !== null && stepId !== null) ctx.store.dispatch({ type: 'select', workflowId: id, selection: { kind: 'step', stepId: made } });
    const step = made !== null ? shownDesignOf(r.after)!.graph.steps.get(made) : undefined;
    const name = step?.name ?? '?';
    const pos = made !== null ? shownDesignOf(r.after)!.placement.steps.get(made) : undefined;
    const withP = item?.ok ? ` with processor ${labelOf(item.value.processor)}` : '';
    const extra = added.filter((x) => !x.startsWith('step ')).join(', ');
    // a split hands the wires into the new step its entry condition: say which changed family, so a meaning change is never silent (2026-10-25)
    const changed = recoloured(r.before, r.after);
    const was = [...new Set(changed.map((c) => c.from))];
    const recolour = changed.length === 0 ? '' : `. ${changed.length} wire${changed.length === 1 ? '' : 's'} changed family with the split (${changed.map((c) => `${c.wire}: ${c.from} → ${c.to}`).join('; ')}): the relations they carry now run on ${changed[0]!.to}, the entry condition of ${name}${was.length === 1 ? `; to keep them on ${was[0]}, set its entryCondition to ${was[0]}` : ''}`;
    return done(true, `added step ${name} (id ${made})${withP} at x ${pos?.x}, y ${pos?.y}${extra ? `; also ${extra} (the wire under it was split through it)` : ''}${recolour}`, `+ step ${name}${withP}`, r.entries);
  },
};

const setProcessorTool: ToolDef = {
  name: 'set_processor',
  description: 'Give a step an existing processor, or replace its processor (as a Toolbox processor dropped on the step).',
  parameters: {
    type: 'object',
    properties: { workflow: WORKFLOW_ARG, step: { type: 'string', description: 'The step: name or id.' }, processor: { type: 'string', description: 'The processor: id, name, or "name version".' } },
    required: ['step', 'processor'],
    additionalProperties: false,
  },
  async run(ctx, args) {
    const asked = `set processor ${text(args.processor) ?? '?'} on step ${text(args.step) ?? '?'}`;
    const item = await processorItem(ctx, text(args.processor) ?? '');
    if (!item.ok) return fail(item.error, asked);
    const found = await designDocOf(ctx, text(args.workflow), asked);
    if ('out' in found) return found.out;
    const { doc } = found;
    const step = findStep(doc, text(args.step) ?? '');
    if (!step.ok) return fail(step.error, asked);
    const { shown } = layersOf(doc);
    const p = shown.placement.steps.get(step.value);
    const name = shown.graph.steps.get(step.value)!.name;
    if (!p) return fail(`step ${name} is not on the canvas`, asked);
    const label = labelOf(item.value.processor);
    const action: StudioAction = { type: 'toolDrop', workflowId: doc.workflowId, item: item.value, at: centred(p, STEP_W, STEP_H), newId: ctx.newId };
    const r = await act(ctx, doc.workflowId, action, { unchanged: `step ${name} already has processor ${label}` });
    if (!r.ok) return fail(r.error, `set processor of ${name} refused`);
    const now = shownDesignOf(r.after)!.graph.steps.get(step.value)?.processorId;
    if (now !== item.value.processor.id) return done(false, `the processor did not land on step ${name}`, `set processor of ${name} failed`, r.entries);
    return done(true, `step ${name} has processor ${label} now`, `processor of ${name} set to ${label}`, r.entries);
  },
};

const addCacheTool: ToolDef = {
  name: 'add_cache',
  description: 'Add a new, empty cache (it needs a root before Save: set_field root), or link an existing cache to the workflow (the same cache, not a copy), as a Toolbox drop.',
  parameters: {
    type: 'object',
    properties: { workflow: WORKFLOW_ARG, cache: { type: 'string', description: 'An existing cache to link: id, name, or "name version" (list_caches). Leave out for a new cache.' }, ...PLACE },
    additionalProperties: false,
  },
  async run(ctx, args) {
    const ref = text(args.cache);
    const asked = ref === undefined ? 'add new cache' : `link cache ${ref}`;
    const point = pointArg(args);
    if (!point.ok) return fail(point.error, asked);
    let item: ToolItem = { kind: 'newCache' };
    if (ref !== undefined) {
      if (!ctx.api.listCaches) return fail('cannot list caches here', asked);
      const list = await ctx.api.listCaches();
      if (!list.ok) return fail(`could not list caches. ${describeError(list.error)}`, asked);
      const c = findCache(list.value, ref);
      if (!c.ok) return fail(c.error, asked);
      item = { kind: 'cache', cache: cacheFromDto(c.value) };
    }
    const found = await designDocOf(ctx, text(args.workflow), asked);
    if ('out' in found) return found.out;
    const { doc } = found;
    const { shown } = layersOf(doc);
    const topLeft = point.value ?? freeCacheSpot(shown);
    const action: StudioAction = { type: 'toolDrop', workflowId: doc.workflowId, item, at: centred({ x: snap(topLeft.x), y: snap(topLeft.y) }, CACHE_W, CACHE_H), newId: ctx.newId };
    const linked = item.kind === 'cache' ? `cache ${labelOf(item.cache)} is already in ${doc.name}` : 'the cache could not be placed there';
    const r = await act(ctx, doc.workflowId, action, { unchanged: linked });
    if (!r.ok) return fail(r.error, `${asked} refused`);
    const { added } = changesOf(r.before, r.after);
    const what = added.join(', ');
    return item.kind === 'cache'
      ? done(true, `linked ${what}`, `+ cache ${labelOf(item.cache)} linked`, r.entries)
      : done(true, `added ${what}; it has no root yet: set one with set_field (target cache, field root) before Save`, `+ new ${what.replace(/ \(id .*\)$/, '')}`, r.entries);
  },
};

/** An open end at the point the model gave ({ x, y }, snapped), else null. */
function openArg(v: unknown): End | null {
  const p = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const x = num(p.x), y = num(p.y);
  return x === undefined || y === undefined ? null : { on: 'open', x: snap(x), y: snap(y) };
}

/** A step's or the hub's name for an action line. */
const endName = (shown: StudioDocument, e: End): string =>
  e.on === 'hub' ? 'workflow' : e.on === 'step' ? shown.graph.steps.get(e.step)?.name ?? e.step : e.on === 'wire' ? 'a junction' : 'an open end';

const connectTool: ToolDef = {
  name: 'connect',
  description: 'Draw a wire from a step\'s output (or the workflow circle, for an entry step) into a step\'s input, as a wire dragged from contact to contact. Its colour (family) is the head step\'s entry condition. An end given as a point (from_point, to_point) is open there, connected to nothing, as a wire dropped on empty canvas. Refused when it would make a short circuit.',
  parameters: {
    type: 'object',
    properties: {
      workflow: WORKFLOW_ARG,
      from: { type: 'string', description: 'The tail: a step (name or id), or "workflow" for the workflow circle.' },
      to: { type: 'string', description: 'The head: a step (name or id).' },
      from_point: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, description: 'An open tail at this flow point, in place of from.' },
      to_point: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, description: 'An open head at this flow point, in place of to.' },
    },
    additionalProperties: false,
  },
  async run(ctx, args) {
    const from = text(args.from) ?? '', to = text(args.to) ?? '';
    const fromPoint = openArg(args.from_point), toPoint = openArg(args.to_point);
    const asked = `connect ${from || (fromPoint ? 'an open end' : '?')} → ${to || (toPoint ? 'an open end' : '?')}`;
    const found = await designDocOf(ctx, text(args.workflow), asked);
    if ('out' in found) return found.out;
    const { doc } = found;
    let tail: End, head: End;
    if (fromPoint !== null) tail = fromPoint;
    else if (same(from, 'workflow')) tail = { on: 'hub', angle: null };
    else {
      const s = findStep(doc, from);
      if (!s.ok) return fail(s.error, asked);
      tail = { on: 'step', step: s.value, y: null };
    }
    if (toPoint !== null) head = toPoint;
    else {
      const h = findStep(doc, to);
      if (!h.ok) return fail(h.error, asked);
      head = { on: 'step', step: h.value, y: null };
    }
    const { saved, shown, draft } = layersOf(doc);
    // a relation already drawn is not drawn twice (2026-10-25): a second wire would only make "from -> to" ambiguous
    const source = tail.on === 'hub' ? WORKFLOW_SOURCE : tail.on === 'step' ? tail.step : null;
    const all = circuitOf(saved, draft);
    const twin = source !== null && head.on === 'step' ? shown.wires.find((w) => reachedEnd(all, w.id, 'tail') === source && reachedEnd(all, w.id, 'head') === head.step) : undefined;
    if (twin) return fail(`${endName(shown, tail)} → ${endName(shown, head)} is wired already (wire ${twin.id}); a second wire would carry the same relation`, `${asked} refused`);
    const wire: CircuitWire = { tail, head };
    const wireId = `${NEW_WIRE_PREFIX}${ctx.newId()}`;
    const next = withCircuit(draft, saved, addCircuitWire(circuitOf(saved, draft), wireId, wire));
    const line = `${endName(shown, tail)} → ${endName(shown, wire.head)}`;
    const r = await act(ctx, doc.workflowId, { type: 'design', workflowId: doc.workflowId, draft: next, picks: [{ kind: 'wire', id: wireId }] }, { unchanged: `the wire ${line} could not be drawn` });
    if (!r.ok) return fail(r.error, `wire ${line} refused`);
    const drawn = shownDesignOf(r.after)!.wires.find((w) => w.id === wireId);
    const family = drawn?.condition != null ? conditionInfo(drawn.condition).name : 'undecided';
    return done(true, `wired ${line} (id ${wireId}, family ${family})`, `wired ${line} (${family})`, r.entries);
  },
};

/**
 * Where a wire meets the trunk it joins, as a drag of its end would land: walking its route from the far end (the tail
 * of a fan-in, the head of a fan-out), the first corner that comes up against the trunk, so each branch drops straight
 * onto it; the trunk point nearest that corner, as a distance along the trunk.
 */
function meetingOf(route: readonly Pt[], side: Side, host: readonly Pt[], length: number): number {
  const corners = side === 'head' ? route : [...route].reverse();
  const near = corners.map((c) => nearestOn([host], c, CONTACT_MARGIN, length - CONTACT_MARGIN));
  const closest = Math.min(...near.map((n) => n.gap));
  return (near.find((n) => n.gap <= closest + GRID) ?? near.at(-1)!).at;
}

/**
 * The step a wire's end reaches (2026-10-25): its own step, or, for an end joined on a trunk, the step that trunk's same
 * end reaches, through any junctions; `via` the wires passed on the way. Null for the hub, an open end or a cycle.
 */
function reachedStep(circuit: Readonly<Circuit>, id: string, side: Side): { step: Id; via: Set<string> } | null {
  const via = new Set<string>();
  for (let at = id; Object.hasOwn(circuit, at) && !via.has(at);) {
    via.add(at);
    const e = circuit[at]![side];
    if (e.on === 'step') return { step: e.step, via };
    if (e.on !== 'wire') return null;
    at = e.host;
  }
  return null;
}

/** How far from its step a branch turns to drop onto its trunk (2 jogs, as the hand-drawn trunks have it). */
const DROP = 2 * JOG;

/**
 * Where a branch drops straight onto its trunk (2026-10-25): DROP out from its own step (right of the output for a
 * fan-in, left of the input for a fan-out), down or up to the trunk's nearest level run under that x. The junction's
 * place along the trunk and the branch's one vertical run; null when no level run of the trunk lies under that x.
 */
function straightDrop(route: readonly Pt[], side: Side, host: readonly Pt[], length: number): { at: number; x: number } | null {
  const own = side === 'head' ? route[0]! : route.at(-1)!;
  const x = snap(side === 'head' ? own[0] + DROP : own[0] - DROP);
  let best: { y: number; gap: number } | null = null;
  for (let i = 0; i < host.length - 1; i++) {
    const [ax, ay] = host[i]!, [bx, by] = host[i + 1]!;
    if (ay !== by || x < Math.min(ax, bx) || x > Math.max(ax, bx)) continue;
    const gap = Math.abs(ay - own[1]);
    if (gap > 0 && (best === null || gap < best.gap)) best = { y: ay, gap };
  }
  if (best === null) return null;
  const near = nearestOn([host], [x, best.y], CONTACT_MARGIN, length - CONTACT_MARGIN);
  return near.gap === 0 ? { at: near.at, x } : null;
}

const joinTool: ToolDef = {
  name: 'join',
  description: 'Merge a wire into a trunk: its head (fan-in) or its tail (fan-out) on a step becomes a junction on another wire of the same family that ends (head) or starts (tail) on that same step, at the given point along the trunk, else where the branch drops straight onto it a little out from its own step (else where its route first comes up against that trunk) (each branch drops straight onto it). Refused across families, steps, or for a wire on the workflow circle.',
  parameters: {
    type: 'object',
    properties: {
      workflow: WORKFLOW_ARG,
      wire: { type: 'string', description: 'The wire to merge: its id, or "from -> to".' },
      side: { type: 'string', enum: ['head', 'tail'], description: 'head for a fan-in, tail for a fan-out.' },
      host: { type: 'string', description: 'The trunk it joins: its id, or "from -> to".' },
      at: { type: 'number', description: 'Where on the trunk the junction goes, in px along the trunk from its tail (read_design gives a junction end its at). Leave out to let the studio choose.' },
    },
    required: ['wire', 'side', 'host'],
    additionalProperties: false,
  },
  async run(ctx, args) {
    const side = args.side === 'head' || args.side === 'tail' ? (args.side as Side) : null;
    const asked = `join ${text(args.wire) ?? '?'}'s ${side ?? String(args.side)} on ${text(args.host) ?? '?'}`;
    if (side === null) return fail('side must be head or tail', asked);
    const found = await designDocOf(ctx, text(args.workflow), asked);
    if ('out' in found) return found.out;
    const { doc } = found;
    const w = findWire(doc, text(args.wire) ?? '');
    if (!w.ok) return fail(w.error, asked);
    const hostId = findWire(doc, text(args.host) ?? '');
    if (!hostId.ok) return fail(hostId.error, asked);
    const { saved, shown, draft } = layersOf(doc);
    const circuit = circuitOf(saved, draft);
    const mine = circuit[w.value]!;
    const name = wireText(shown, w.value, circuit), hostName = wireText(shown, hostId.value, circuit);
    const action = `join ${name}'s ${side} on ${hostName}`;
    if (w.value === hostId.value) return fail('a wire cannot join itself', action);
    const end = mine[side];
    if (end.on !== 'step') return fail(`the ${side} of ${name} is not on a step${end.on === 'hub' ? ' (a wire on the workflow circle stays separate)' : ''}`, action);
    // the trunk may itself be a branch joined on another: what counts is the step it reaches (2026-10-25)
    const reached = reachedStep(circuit, hostId.value, side);
    if (reached === null || reached.step !== end.step) return fail(`${hostName} does not ${side === 'head' ? 'end' : 'start'} on the same step as ${name}: a junction merges wires of one step`, action);
    const route = shown.wires.find((x) => x.id === w.value), host = shown.wires.find((x) => x.id === hostId.value);
    if (!route || !host) return fail('one of the wires is not drawn', action);
    if (route.condition === null || route.condition !== host.condition) return fail(`${name} and ${hostName} are not of one family: wires of different families are never joined`, action);
    const length = lengthOf([host.points]);
    // no point given: the branch drops straight onto the trunk where it can, else meets it where its route comes up to it
    const drop = num(args.at) === undefined ? straightDrop(route.points, side, host.points, length) : null;
    const raw = num(args.at) ?? drop?.at ?? meetingOf(route.points, side, host.points, length);
    const at = Math.min(Math.max(snap(raw, GRID), CONTACT_MARGIN), Math.max(CONTACT_MARGIN, length - CONTACT_MARGIN));
    const target = { on: 'wire' as const, host: hostId.value, at };
    const why = judgeDrop(shown, circuit, w.value, side, target);
    if (toneOf(why) !== 'ok') return fail(`refused: ${dropLabel(why)}`, action);
    const joined = setEnd(circuit, w.value, side, { on: 'wire', host: hostId.value, at });
    const next = withCircuit(draft, saved, drop !== null && drop.at === at ? setBends(joined, w.value, { xs: [drop.x], ys: [] }) : joined);
    const r = await act(ctx, doc.workflowId, { type: 'design', workflowId: doc.workflowId, draft: next, picks: [{ kind: 'wire', id: w.value }] }, { unchanged: `${name} could not join ${hostName}` });
    if (!r.ok) return fail(r.error, `${action} refused`);
    return done(true, `the ${side} of ${name} is a junction on ${hostName} now, ${at} px along it`, `joined ${name}'s ${side} on ${hostName}`, r.entries);
  },
};

const DIRS: readonly Dir[] = ['right', 'left', 'up', 'down'];

const autoConnectTool: ToolDef = {
  name: 'auto_connect',
  description: 'Click a block\'s AutoConnect arrow: a new step one gap that way, wired from the block (into it for left), or, when a step is already there, only the wire to it. A step shows right while its output has no wire, left while its input has none, up and down always; the workflow circle shows right while it has no wire.',
  parameters: {
    type: 'object',
    properties: { workflow: WORKFLOW_ARG, block: { type: 'string', description: 'A step (name or id) or "workflow".' }, dir: { type: 'string', enum: [...DIRS] } },
    required: ['block', 'dir'],
    additionalProperties: false,
  },
  async run(ctx, args) {
    const dir = DIRS.find((d) => d === args.dir);
    const asked = `auto connect ${String(args.dir)} of ${text(args.block) ?? '?'}`;
    if (dir === undefined) return fail('dir must be right, left, up or down', asked);
    const found = await designDocOf(ctx, text(args.workflow), asked);
    if ('out' in found) return found.out;
    const { doc } = found;
    const { saved, shown, draft } = layersOf(doc);
    const block = blockOf(doc, shown, text(args.block) ?? '');
    if (!block.ok) return fail(block.error, asked);
    const { node, label } = block.value;
    const circuit = circuitOf(saved, draft);
    let why = `${label} shows no ${dir} arrow`;
    if (arrowsOf(shown, circuit, node).includes(dir)) {
      const t = autoTarget(shown, circuit, node, dir);
      why = t.kind === 'blocked' ? `the spot ${dir} of ${label} is taken by a cache or the workflow circle` : `the step ${dir} of ${label} cannot be wired that way (a short circuit)`;
    }
    const r = await act(ctx, doc.workflowId, { type: 'autoConnect', workflowId: doc.workflowId, id: node, dir, newId: ctx.newId }, { unchanged: `refused: ${why}` });
    if (!r.ok) return fail(r.error, `auto connect ${dir} of ${label} refused`);
    const { added } = changesOf(r.before, r.after);
    return done(true, `added ${added.join(', ')}`, `auto connect ${dir} of ${label}: ${added.map((a) => a.replace(/ \(id .*\)$/, '')).join(', ')}`, r.entries);
  },
};

/**
 * The wires a move takes along (2026-10-25), as a rubber band picks them with the blocks on the canvas: a wire whose
 * ends, followed through the junctions it hangs on, are all on blocks that move by one same offset; by that offset.
 * A wire with an open end, or an end on a block that stays or moves by another offset, keeps its shape.
 */
function wiresAlong(circuit: Readonly<Circuit>, offsetOf: (node: string) => Point | undefined): Map<string, { ids: string[]; dx: number; dy: number }> {
  const blocks = (id: string, seen: Set<string>): string[] | null => {
    if (seen.has(id) || !Object.hasOwn(circuit, id)) return null;
    seen.add(id);
    const out: string[] = [];
    for (const e of [circuit[id]!.tail, circuit[id]!.head]) {
      if (e.on === 'open') return null;
      if (e.on === 'step') out.push(e.step);
      else if (e.on === 'hub') out.push(SPHERE_NODE_ID);
      else { const host = blocks(e.host, seen); if (host === null) return null; out.push(...host); }
    }
    return out;
  };
  const groups = new Map<string, { ids: string[]; dx: number; dy: number }>();
  for (const id of Object.keys(circuit)) {
    const nodes = blocks(id, new Set());
    const offsets = nodes?.map(offsetOf);
    if (!offsets || offsets.length === 0 || offsets.some((o) => o === undefined)) continue;
    const { x: dx, y: dy } = offsets[0]!;
    if (offsets.some((o) => o!.x !== dx || o!.y !== dy) || (dx === 0 && dy === 0)) continue;
    const key = `${dx},${dy}`;
    (groups.get(key) ?? groups.set(key, { ids: [], dx, dy }).get(key)!).ids.push(id);
  }
  return groups;
}

const moveBlocksTool: ToolDef = {
  name: 'move_blocks',
  description: 'Move blocks (steps, caches, the workflow circle) to new top-left corners, snapped to the 8 px grid, as one drag: one Undo step. A wire whose ends are all on blocks moved by one same offset moves with them, its shape kept (as a rubber-band pick dragged on the canvas); every other wire follows its ends.',
  parameters: {
    type: 'object',
    properties: {
      workflow: WORKFLOW_ARG,
      moves: {
        type: 'array',
        items: { type: 'object', properties: { block: { type: 'string', description: 'A step or cache (name or id), or "workflow".' }, x: { type: 'number' }, y: { type: 'number' } }, required: ['block', 'x', 'y'] },
      },
    },
    required: ['moves'],
    additionalProperties: false,
  },
  async run(ctx, args) {
    const moves = Array.isArray(args.moves) ? (args.moves as Record<string, unknown>[]) : [];
    const asked = `move ${moves.map((m) => text(m?.block) ?? '?').join(', ') || 'blocks'}`;
    if (moves.length === 0) return fail('moves must list at least one { block, x, y }', asked);
    const found = await designDocOf(ctx, text(args.workflow), asked);
    if ('out' in found) return found.out;
    const { doc } = found;
    const { saved, shown, draft } = layersOf(doc);
    const moved = new Map<string, Point>();
    const names: string[] = [];
    for (const m of moves) {
      const block = blockOf(doc, shown, text(m?.block) ?? '');
      if (!block.ok) return fail(block.error, asked);
      const x = num(m.x), y = num(m.y);
      if (x === undefined || y === undefined) return fail(`the move of ${block.value.label} needs x and y`, asked);
      moved.set(block.value.node, { x: snap(x), y: snap(y) });
      names.push(`${block.value.label} to (${snap(x)}, ${snap(y)})`);
    }
    // each moved block's offset from where it is drawn now
    const offsets = new Map<string, Point>();
    for (const [node, to] of moved) {
      const from = nodeBox(shown, node);
      if (from) offsets.set(node, { x: to.x - from.x, y: to.y - from.y });
    }
    let next = moveBlocks(draft, saved, moved);
    for (const { ids, dx, dy } of wiresAlong(circuitOf(saved, draft), (node) => offsets.get(node)).values()) {
      const c = circuitOf(saved, next);
      const shifted = shiftWires(c, ids, dx, dy, (block) => moved.has(block === 'hub' ? SPHERE_NODE_ID : block));
      if (shifted !== c) next = withCircuit(next, saved, shifted);
    }
    const r = await act(ctx, doc.workflowId, { type: 'design', workflowId: doc.workflowId, draft: next }, { unchanged: 'nothing moved: the blocks are already there' });
    if (!r.ok) return fail(r.error, `${asked} refused`);
    return done(true, `moved ${names.join(', ')}`, `moved ${names.map((n) => n.replace(/ to \(.*\)$/, '')).join(', ')}`, r.entries);
  },
};

const resetRouteTool: ToolDef = {
  name: 'reset_route',
  description: 'Reset a wire\'s route (its bends go and its ends on steps go back to automatic heights; what it connects stays), as the wire\'s Reset route.',
  parameters: { type: 'object', properties: { workflow: WORKFLOW_ARG, wire: { type: 'string', description: 'The wire: its id, or "from -> to".' } }, required: ['wire'], additionalProperties: false },
  async run(ctx, args) {
    const asked = `reset route of ${text(args.wire) ?? '?'}`;
    const found = await designDocOf(ctx, text(args.workflow), asked);
    if ('out' in found) return found.out;
    const { doc } = found;
    const w = findWire(doc, text(args.wire) ?? '');
    if (!w.ok) return fail(w.error, asked);
    const { saved, shown, draft } = layersOf(doc);
    const name = wireText(shown, w.value, circuitOf(saved, draft));
    const r = await act(ctx, doc.workflowId, { type: 'design', workflowId: doc.workflowId, draft: resetShape(draft, saved, w.value) }, { unchanged: `wire ${name} has no route of its own to reset` });
    if (!r.ok) return fail(r.error, `reset route of ${name} refused`);
    return done(true, `the route of wire ${name} is automatic again`, `reset route of ${name}`, r.entries);
  },
};

/**
 * A step end merged into a trunk as shape_wire's { host, at } asks, the trunk ending (head) or starting (tail) on that
 * same step and of the same family, so what the wire connects stays (as join); null when the model gave no host.
 */
function junctionArg(doc: OpenDocument, shown: StudioDocument, circuit: Readonly<Circuit>, id: string, side: Side, v: unknown): Found<End> | null {
  const a = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  if (!Object.hasOwn(a, 'host')) return null;
  const hostId = findWire(doc, text(a.host) ?? '');
  if (!hostId.ok) return hostId;
  if (hostId.value === id) return { ok: false, error: 'a wire cannot join itself' };
  const hostName = wireText(shown, hostId.value, circuit);
  // what counts is the step each end reaches, through any junctions (a trunk may be a branch joined on another)
  const step = reachedStep(circuit, id, side)?.step ?? null;
  if (step === null) return { ok: false, error: `the ${side} reaches no step: a junction merges wires of one step` };
  const reached = reachedStep(circuit, hostId.value, side);
  if (reached?.via.has(id)) return { ok: false, error: `${hostName} is joined on this wire: joining back on it would make a loop of junctions` };
  if (reached === null || reached.step !== step) return { ok: false, error: `${hostName} does not ${side === 'head' ? 'end' : 'start'} on the same step: a junction merges wires of one step` };
  const mine = shown.wires.find((x) => x.id === id), host = shown.wires.find((x) => x.id === hostId.value);
  if (!mine || !host) return { ok: false, error: 'one of the wires is not drawn' };
  if (mine.condition === null || mine.condition !== host.condition) return { ok: false, error: `not of one family with ${hostName}: wires of different families are never joined` };
  const at = num(a.at);
  if (at === undefined) return { ok: false, error: `give { host, at }: at is px along ${hostName} from its tail` };
  const length = lengthOf([host.points]);
  return { ok: true, value: { on: 'wire', host: hostId.value, at: Math.min(Math.max(snap(at, GRID), CONTACT_MARGIN), Math.max(CONTACT_MARGIN, length - CONTACT_MARGIN)) } };
}

/** A wire end as the model asked it changed (shape_wire's tail or head), on what it is on now: the same footing only. */
function endArg(cur: End, v: unknown, side: Side, host: { length: number } | null): Found<End | undefined> {
  if (v === undefined) return { ok: true, value: undefined };
  const a = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const has = (k: string) => Object.hasOwn(a, k);
  switch (cur.on) {
    case 'step': {
      if (!has('y')) return { ok: false, error: `the ${side} is on a step: give { y } (its height down the step's side, ${LANDING_MIN} to ${LANDING_MAX}, or null for automatic)` };
      if (a.y === null) return { ok: true, value: { on: 'step', step: cur.step, y: null } };
      const y = num(a.y);
      if (y === undefined || y < LANDING_MIN || y > LANDING_MAX) return { ok: false, error: `the ${side}'s y must be ${LANDING_MIN} to ${LANDING_MAX} (px down the step's side) or null` };
      return { ok: true, value: { on: 'step', step: cur.step, y: snap(y) } };
    }
    case 'hub': {
      if (!has('angle') && !has('dy')) return { ok: false, error: `the ${side} is on the workflow circle: give { angle } (degrees round it, 0 right, 90 down; null for automatic) or { dy } (an automatic tail held that far below its centre)` };
      const angle = a.angle === null || a.angle === undefined ? null : num(a.angle);
      if (angle === undefined) return { ok: false, error: 'angle must be a number or null' };
      const dy = a.dy === null || a.dy === undefined ? null : num(a.dy);
      if (dy === undefined) return { ok: false, error: 'dy must be a number' };
      return { ok: true, value: angle !== null ? { on: 'hub', angle: snapAngle(angle) } : dy !== null ? { on: 'hub', angle: null, dy: snap(dy) } : { on: 'hub', angle: null } };
    }
    case 'wire': {
      const at = num(a.at);
      if (at === undefined || host === null) return { ok: false, error: `the ${side} is a junction: give { at } (px along its trunk from the trunk's tail)` };
      return { ok: true, value: { on: 'wire', host: cur.host, at: Math.min(Math.max(snap(at, GRID), CONTACT_MARGIN), Math.max(CONTACT_MARGIN, host.length - CONTACT_MARGIN)) } };
    }
    case 'open': {
      const x = num(a.x), y = num(a.y);
      if (x === undefined || y === undefined) return { ok: false, error: `the ${side} is open: give { x, y } (a flow point)` };
      return { ok: true, value: { on: 'open', x: snap(x), y: snap(y) } };
    }
  }
}

/** The bends the model gave: absent (keep), null or no xs (automatic), else { xs, ys } with one ys fewer than xs. */
function bendsArg(v: unknown, given: boolean): Found<Bends | null | undefined> {
  if (!given) return { ok: true, value: undefined };
  if (v === null) return { ok: true, value: null };
  const b = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const xs = Array.isArray(b.xs) ? b.xs.map(num) : null, ys = Array.isArray(b.ys) ? b.ys.map(num) : null;
  if (xs === null || ys === null || xs.some((x) => x === undefined) || ys.some((y) => y === undefined)) return { ok: false, error: 'bends must be { xs: [numbers], ys: [numbers] } or null' };
  if (xs.length === 0) return { ok: true, value: null };
  if (ys.length !== xs.length - 1) return { ok: false, error: `bends need one ys fewer than xs (xs: the x of each vertical run, ys: the y of each level run between two of them); got ${xs.length} xs and ${ys.length} ys` };
  return { ok: true, value: { xs: xs.map((x) => snap(x!)), ys: ys.map((y) => snap(y!)) } };
}

const END_ARG = {
  type: 'object',
  description: 'On a step: { y } (px down the step\'s side, null: automatic). On the workflow circle: { angle } or { dy } (null: automatic). A junction: { host, at } (the trunk, its id or "from -> to", ending or starting on the same step; at: px along it; host may be left out for a junction that stays on its trunk). Open: { x, y }. Leave out to keep it.',
  properties: { y: { type: ['number', 'null'] }, angle: { type: ['number', 'null'] }, dy: { type: ['number', 'null'] }, host: { type: 'string' }, at: { type: 'number' }, x: { type: 'number' } },
};

const SHAPE_ITEM = {
  type: 'object',
  properties: {
    wire: { type: 'string', description: 'The wire: its id, or "from -> to".' },
    tail: END_ARG,
    head: END_ARG,
    bends: { type: ['object', 'null'], properties: { xs: { type: 'array', items: { type: 'number' } }, ys: { type: 'array', items: { type: 'number' } } }, description: 'Its own route, or null: automatic. Leave out to keep it.' },
  },
  required: ['wire'],
};

const shapeWireTool: ToolDef = {
  name: 'shape_wire',
  description: 'Shape wires as dragging their ends and runs does, what they connect staying: the place of each tail and head on what it is on (read_design gives each end its y on a step, angle or dy on the workflow circle, at on a trunk) and the route of each wire (bends: xs, the x of each vertical run; ys, the y of each level run between two of them; null: automatic). All the wires listed change at once, one Undo step, judged as a whole: shape neighbouring wires in one call. Copy a drawing exactly by giving every wire the shape read_design shows for the original. Refused when the result would make a short circuit.',
  parameters: {
    type: 'object',
    properties: { workflow: WORKFLOW_ARG, wires: { type: 'array', items: SHAPE_ITEM, description: 'Each wire and its new shape.' } },
    required: ['wires'],
    additionalProperties: false,
  },
  async run(ctx, args) {
    // one wire given flat ({ wire, tail, head, bends }) is a list of one
    const items = (Array.isArray(args.wires) ? args.wires : [args]).map((x) => (typeof x === 'object' && x !== null ? x : {}) as Record<string, unknown>);
    const asked = `shape ${items.map((x) => text(x.wire) ?? '?').join(', ')}`;
    if (items.length === 0) return fail('wires must list at least one { wire, tail, head, bends }', asked);
    const found = await designDocOf(ctx, text(args.workflow), asked);
    if ('out' in found) return found.out;
    const { doc } = found;
    const { saved, shown, draft } = layersOf(doc);
    let circuit = circuitOf(saved, draft);
    const hostOf = (e: End) => {
      const h = e.on === 'wire' ? shown.wires.find((x) => x.id === e.host) : undefined;
      return h ? { length: lengthOf([h.points]) } : null;
    };
    const ids: string[] = [], names: string[] = [];
    for (const item of items) {
      const w = findWire(doc, text(item.wire) ?? '');
      if (!w.ok) return fail(w.error, asked);
      const cur = circuit[w.value]!;
      const name = wireText(shown, w.value, circuit);
      const action = `shape ${name}`;
      const tail = junctionArg(doc, shown, circuit, w.value, 'tail', item.tail) ?? endArg(cur.tail, item.tail, 'tail', hostOf(cur.tail));
      if (!tail.ok) return fail(tail.error, action);
      const head = junctionArg(doc, shown, circuit, w.value, 'head', item.head) ?? endArg(cur.head, item.head, 'head', hostOf(cur.head));
      if (!head.ok) return fail(head.error, action);
      const bends = bendsArg(item.bends, Object.hasOwn(item, 'bends'));
      if (!bends.ok) return fail(bends.error, action);
      for (const [side, end] of [['tail', tail.value], ['head', head.value]] as const) {
        if (end === undefined) continue;
        // a junction slid along its trunk lands as an end drag would: refused where the drag is
        if (end.on === 'wire') {
          const why = judgeDrop(shown, circuit, w.value, side, end);
          if (toneOf(why) !== 'ok') return fail(`refused: ${dropLabel(why)}`, action);
        }
        circuit = setEnd(circuit, w.value, side, end);
      }
      if (bends.value !== undefined) circuit = setBends(circuit, w.value, bends.value);
      ids.push(w.value);
      names.push(name);
    }
    const all = names.join(', ');
    const r = await act(ctx, doc.workflowId, { type: 'design', workflowId: doc.workflowId, draft: withCircuit(draft, saved, circuit), picks: ids.map((id) => ({ kind: 'wire' as const, id })) }, { unchanged: `${names.length === 1 ? `wire ${all} is` : `wires ${all} are`} already shaped so` });
    if (!r.ok) return fail(r.error, `shape ${all} refused`);
    const drawn = shownDesignOf(r.after)!.wires;
    const through = ids.map((id, i) => `${names[i]} through ${JSON.stringify(drawn.find((x) => x.id === id)?.points ?? [])}`).join('; ');
    return done(true, `shaped ${through}`, `shaped ${all}`, r.entries);
  },
};

/** A pick by what the model wrote: a wire ("from -> to" or its id), "workflow", a step or a cache. */
function pickOf(doc: OpenDocument, shown: StudioDocument, ref: string): Found<{ pick: Pick; label: string }> {
  const t = ref.trim();
  if (/->|→/.test(t) || t.startsWith(NEW_WIRE_PREFIX)) {
    const w = findWire(doc, t);
    return w.ok ? { ok: true, value: { pick: { kind: 'wire', id: w.value }, label: `wire ${wireText(shown, w.value, shownCircuitOf(doc) ?? undefined)}` } } : w;
  }
  const b = blockOf(doc, shown, t);
  return b.ok ? { ok: true, value: { pick: { kind: 'node', id: b.value.node }, label: b.value.label } } : b;
}

/** What the picks are, in words: each block and wire as the canvas names it. */
function picksText(shown: StudioDocument, picks: readonly Pick[], circuit?: Readonly<Circuit>): string[] {
  return picks.map((p) => {
    if (p.kind === 'wire') return `wire ${wireText(shown, p.id, circuit)}`;
    if (p.kind === 'processor') return `the processor of step ${shown.graph.steps.get(p.id)?.name ?? p.id}`;
    if (p.id === SPHERE_NODE_ID) return 'the workflow';
    if (p.id.startsWith(CACHE_NODE_PREFIX)) { const c = shown.graph.caches.get(p.id.slice(CACHE_NODE_PREFIX.length)); return `cache ${c ? labelOf(c) : p.id}`; }
    return `step ${shown.graph.steps.get(p.id)?.name ?? p.id}`;
  });
}

const pickTool: ToolDef = {
  name: 'pick',
  description: 'Pick (select) items on the canvas, replacing what is picked, as a rubber band does; copy and delete_picked act on the picks. An empty list clears them.',
  parameters: {
    type: 'object',
    properties: { workflow: WORKFLOW_ARG, items: { type: 'array', items: { type: 'string' }, description: 'Each a step or cache (name or id), a wire ("from -> to" or its id), or "workflow".' } },
    required: ['items'],
    additionalProperties: false,
  },
  async run(ctx, args) {
    const items = (Array.isArray(args.items) ? args.items : []).map(String);
    const asked = items.length === 0 ? 'clear the picks' : `pick ${items.join(', ')}`;
    // picking is no design change: it works while a Save runs too, as clicking does
    const found = await loadedDocOf(ctx, text(args.workflow), asked);
    if ('out' in found) return found.out;
    const { doc } = found;
    const { shown } = layersOf(doc);
    const picks: Pick[] = [];
    for (const ref of items) {
      const p = pickOf(doc, shown, ref);
      if (!p.ok) return fail(p.error, asked);
      if (!picks.some((x) => pickKey(x) === pickKey(p.value.pick))) picks.push(p.value.pick);
    }
    const { entries } = await withEcho(ctx.store, () => [doc.workflowId], async () => { ctx.store.dispatch({ type: 'pick', workflowId: doc.workflowId, picks }); });
    const names = picksText(shown, picks, shownCircuitOf(doc) ?? undefined);
    return names.length === 0
      ? done(true, 'nothing is picked now', `picks cleared in ${doc.name}`, entries)
      : done(true, `picked ${names.join(', ')}`, `picked ${names.join(', ')}`, entries);
  },
};

const copyTool: ToolDef = {
  name: 'copy',
  description: 'Copy the picked steps, caches and wires (Ctrl+C); the workflow circle is never copied. paste puts an exact copy with new ids into the active or named workflow.',
  parameters: { type: 'object', properties: { workflow: WORKFLOW_ARG }, additionalProperties: false },
  async run(ctx, args) {
    const found = await loadedDocOf(ctx, text(args.workflow), 'copy the picks');
    if ('out' in found) return found.out;
    const { doc } = found;
    const before = ctx.store.getState().clipboard;
    const { entries } = await withEcho(ctx.store, () => [doc.workflowId], async () => { ctx.store.dispatch({ type: 'copy', workflowId: doc.workflowId }); });
    const clip = ctx.store.getState().clipboard;
    if (clip === null || clip === before) return done(false, 'nothing to copy: pick steps, caches or wires first (the workflow circle is not copied)', `copy in ${doc.name}: nothing picked`, entries);
    const what = [...clip.steps.map((s) => `step ${s.name}`), ...clip.caches.map((c) => `cache ${c.name} ${c.version}`)];
    const wires = Object.keys(clip.wires).length;
    const all = [...what, ...(wires > 0 ? [`${wires} wire${wires === 1 ? '' : 's'}`] : [])].join(', ');
    return done(true, `copied ${all}`, `copied ${all}`, entries);
  },
};

const pasteTool: ToolDef = {
  name: 'paste',
  description: 'Paste what copy copied (Ctrl+V): an exact copy with new ids (names, fields and a cache\'s root included), the blocks and wires keeping their places and shapes relative to each other; the pasted items are picked. Where it lands: x, y put the top-left of the pasted blocks there (a duplicate on its own row below everything, its columns in line); in_place: true where it was copied (to copy a drawing into another workflow); neither: the nearest spot clear of every block, as Ctrl+V. Refused when a pasted block would overlap a block. Pasted steps keep their names: name them by the ids the result gives. The workflow circle is never copied: wire it to a pasted entry step with connect. BaseApi refuses a cache root another cache has, so give a pasted cache a new root before Save.',
  parameters: {
    type: 'object',
    properties: {
      workflow: WORKFLOW_ARG,
      x: { type: 'number', description: 'Top-left x of the pasted blocks (flow px).' },
      y: { type: 'number', description: 'Top-left y of the pasted blocks (flow px).' },
      in_place: { type: 'boolean', description: 'true: at the very positions copied, wires shaped exactly as copied.' },
    },
    additionalProperties: false,
  },
  async run(ctx, args) {
    const found = await designDocOf(ctx, text(args.workflow), 'paste');
    if ('out' in found) return found.out;
    const { doc } = found;
    const clip = ctx.store.getState().clipboard;
    if (clip === null) return fail('the clipboard is empty: pick and copy first', `paste into ${doc.name}: nothing copied`);
    const point = pointArg(args);
    if (!point.ok) return fail(point.error, `paste into ${doc.name}`);
    const at = point.value !== null ? { x: snap(point.value.x), y: snap(point.value.y) } : args.in_place === true ? clipOrigin(clip) : undefined;
    const where = at === undefined ? '' : ` at (${at.x}, ${at.y})`;
    const r = await act(ctx, doc.workflowId, { type: 'paste', workflowId: doc.workflowId, newId: ctx.newId, ...(at ? { at } : {}) },
      { unchanged: at ? `nothing was pasted: a pasted block would overlap a block${where} (pick a free spot: read_design gives every block)` : 'nothing was pasted' });
    if (!r.ok) return fail(r.error, `paste into ${doc.name}${where} refused`);
    const { added, newSteps } = changesOf(r.before, r.after);
    // a pasted step shares its name with a step already there: the model names it by id from now on (2026-10-25)
    const shown = shownDesignOf(r.after)!;
    const twins = newSteps.filter((id) => [...shown.graph.steps.values()].filter((s) => s.name === shown.graph.steps.get(id)?.name).length > 1);
    const note = twins.length > 0 ? `. ${twins.length} pasted step${twins.length === 1 ? ' shares its name' : 's share their names'} with steps already there: name them by id from now on (or rename them with set_field)` : '';
    return done(true, `pasted${where} ${added.join(', ')}${note}`, `pasted ${added.map((a) => a.replace(/ \(id .*\)$/, '')).join(', ')}`, r.entries);
  },
};

/** The picks a delete question named, by workflow: the Yes deletes them only while they are still what is picked. */
const pendingDeletes = new Map<Id, string>();
const picksKey = (picks: readonly Pick[]): string => picks.map(pickKey).sort().join('|');

const deletePickedTool: ToolDef = {
  name: 'delete_picked',
  description: 'Delete the picked steps, caches and wires from the design (Delete); the workflow circle is never deleted this way. The user is shown what goes and asked first.',
  parameters: { type: 'object', properties: { workflow: WORKFLOW_ARG }, additionalProperties: false },
  async run(ctx, args, answer, pin) {
    const found = await askedDocOf(ctx, 'delete picked items', text(args.workflow), answer, pin);
    if ('out' in found) return found.out;
    const { doc } = found;
    const id = doc.workflowId;
    const picks = doc.picks.filter((p) => !(p.kind === 'node' && p.id === SPHERE_NODE_ID));
    const { shown } = layersOf(doc);
    const names = picksText(shown, picks, shownCircuitOf(doc) ?? undefined);
    if (answer === undefined) {
      if (picks.length === 0) return fail('nothing is picked: pick steps, caches or wires first (the workflow circle is not deleted this way)', `delete in ${doc.name}: nothing picked`);
      // what Delete would take: the picks, and the wires of a picked step that go with it
      const state = ctx.store.getState();
      const preview = reduce(state, { type: 'deletePicks', workflowId: id }).docs.find((d) => d.workflowId === id)!;
      const goes = changesOf(doc, preview).removed;
      pendingDeletes.set(id, picksKey(doc.picks));
      return { kind: 'ask', question: { text: `Delete ${(goes.length > 0 ? goes : names).join(', ')} from ${labelOf(doc)}?`, choices: YES_NO, pin: id } };
    }
    const asked = pendingDeletes.get(id);
    pendingDeletes.delete(id);
    if (answer !== 'Yes') return fail('the user declined', `user declined: delete from ${doc.name}`);
    if (asked === undefined) return fail('the question was lost (the page was refreshed?); nothing was deleted: ask again', `delete in ${doc.name}: question lost`);
    if (asked !== picksKey(doc.picks)) return fail('the picks changed since the question; nothing was deleted: ask again', `delete in ${doc.name}: picks changed`);
    const r = await act(ctx, id, { type: 'deletePicks', workflowId: id }, { unchanged: 'nothing was deleted' });
    if (!r.ok) return fail(r.error, `delete in ${doc.name} refused`);
    const { removed } = changesOf(r.before, r.after);
    const gone = removed.length > 0 ? removed.join(', ') : names.join(', ');
    return done(true, `deleted ${gone} (Undo brings them back)`, `deleted ${gone}`, r.entries);
  },
};

/** Undo or Redo: one step of the design history; it is never refused for a short circuit (it brings back a design that was). */
/** What Undo or Redo of creating or removing an assignment did, in words: "back: …" or "gone: …". */
function assignmentChange(after: OpenDocument, step: AssignmentStep, op: 'undo' | 'redo'): string {
  const { stepId, after: made } = step.assignment;
  const removal = made === null || made.op === 'delete';
  const name = shownDesignOf(after)?.graph.steps.get(stepId)?.name ?? stepId;
  return `${removal === (op === 'undo') ? 'back' : 'gone'}: the assignment of step ${name}`;
}

function historyTool(op: 'undo' | 'redo'): ToolDef {
  return {
    name: op,
    description: op === 'undo' ? 'Undo the last design step (Ctrl+Z), the user\'s or yours: one history for both. Drawing steps and creating or removing an assignment are steps; field edits have no Undo (revert_entity).' : 'Redo the design step undone last (Ctrl+Y).',
    parameters: { type: 'object', properties: { workflow: WORKFLOW_ARG }, additionalProperties: false },
    async run(ctx, args) {
      const found = await designDocOf(ctx, text(args.workflow), op);
      if ('out' in found) return found.out;
      const { doc } = found;
      if ((op === 'undo' ? doc.design.past : doc.design.future).length === 0) return fail(`nothing to ${op} in ${labelOf(doc)}`, `${op} in ${labelOf(doc)}: nothing to ${op}`);
      const step = op === 'undo' ? undoStepOf(doc.design) : redoStepOf(doc.design);
      const { entries } = await withEcho(ctx.store, () => [doc.workflowId], async () => { ctx.store.dispatch({ type: op, workflowId: doc.workflowId }); });
      const after = docOf(ctx, doc.workflowId)!;
      const { added, removed } = changesOf(doc, after);
      // an assignment step (2026-10-23): the step's assignment comes back or goes
      const assignment = step !== null && isAssignmentStep(step) ? assignmentChange(after, step, op) : null;
      const changes = [...added.map((a) => `back: ${a}`), ...removed.map((r) => `gone: ${r}`), ...(assignment ? [assignment] : [])].join('; ');
      const past = op === 'undo' ? 'undid' : 'redid';
      return done(true, `${past} one design step in ${labelOf(doc)}${changes ? ` (${changes})` : ''}`, `${past} one step in ${labelOf(doc)}`, entries);
    },
  };
}

export const DESIGN_TOOLS: ToolDef[] = [
  addStepTool, setProcessorTool, addCacheTool, connectTool, joinTool, autoConnectTool, moveBlocksTool, resetRouteTool, shapeWireTool,
  pickTool, copyTool, pasteTool, deletePickedTool, historyTool('undo'), historyTool('redo'),
];
