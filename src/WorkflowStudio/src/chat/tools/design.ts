import { describeError } from '../../api/describeError';
import { cacheFromDto, processorFromDto, schemaFromDto } from '../../api/toModel';
import { nearestAlong } from '../../ai/drawing';
import type { StudioDocument } from '../../app/document';
import { addCircuitWire, NEW_WIRE_PREFIX, setEnd, type Circuit, type CircuitWire, type End, type Side } from '../../circuit/circuit';
import { applyDraft, applyEdits } from '../../design/apply';
import { arrowsOf, autoTarget, type Dir } from '../../design/autoConnect';
import { blockBoxes, freeOffset } from '../../design/clipboard';
import { circuitOf, moveBlocks, resetShape, withCircuit, type Draft } from '../../design/draft';
import { dropLabel, judgeDrop, toneOf } from '../../design/drop';
import { shortCircuitErrors } from '../../design/shortCircuits';
import { dropTool, judgeTool, type ToolItem } from '../../design/toolDrop';
import { wireName } from '../../design/wireName';
import { WORKFLOW_SOURCE } from '../../layout/ports';
import { CACHE_H, CACHE_W, CELL, COLUMN_PITCH, GRID, LAYOUT_GAP, PMID, snap, SPHERE_R, STEP_H, STEP_W, type Point } from '../../layout/geometry';
import { CONTACT_MARGIN, lengthOf } from '../../layout/junctions';
import { cacheNodeId, CACHE_NODE_PREFIX, SPHERE_NODE_ID } from '../../layout/nodeIds';
import { conditionInfo } from '../../model/entryConditions';
import type { Id } from '../../model/graph';
import { pickKey, type Pick } from '../../store/picks';
import { entityLabel, shownDesignOf } from '../../store/problems';
import { designDirty, designLocked, reduce, type OpenDocument, type StudioAction } from '../../store/studioState';
import type { ChatEntry } from '../chatStore';
import { withEcho } from '../echo';
import { findCache, findProcessor, findStep, findWire, type Found } from '../resolve';
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
  if (designLocked(doc)) return { out: fail(`the design of ${doc.name} is read-only now: a Save or the AI drawing is under way; try again when it is over`, action) };
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

/** A wire in the chat's words: "from → to", a step by its name, the hub as workflow, else a junction or an open end. */
export function wireText(shown: StudioDocument, id: string): string {
  const w = shown.wires.find((x) => x.id === id);
  if (!w) return wireName(shown, id) ?? id;
  const name = (s: string | null, on: string) => (s === null ? (on === 'junction' ? 'a junction' : 'an open end') : s === WORKFLOW_SOURCE ? 'workflow' : shown.graph.steps.get(s)?.name ?? s);
  return `${name(w.source, w.tailOn)} → ${name(w.target, w.headOn)}`;
}

/** What an action added to and removed from the drawing: steps, caches and wires, each named as the canvas names it. */
function changesOf(before: OpenDocument, after: OpenDocument): { added: string[]; removed: string[]; newSteps: Id[] } {
  const b = shownDesignOf(before)!, a = shownDesignOf(after)!;
  const added: string[] = [], removed: string[] = [], newSteps: Id[] = [];
  for (const s of a.graph.steps.values()) if (!b.graph.steps.has(s.id)) { added.push(`step ${s.name} (id ${s.id})`); newSteps.push(s.id); }
  for (const c of a.graph.caches.values()) if (!b.graph.caches.has(c.id)) added.push(`cache ${labelOf(c)} (id ${c.id})`);
  for (const w of a.wires) if (!b.wires.some((x) => x.id === w.id)) added.push(`wire ${wireText(a, w.id)} (id ${w.id})`);
  for (const s of b.graph.steps.values()) if (!a.graph.steps.has(s.id)) removed.push(`step ${s.name}`);
  for (const c of b.graph.caches.values()) if (!a.graph.caches.has(c.id)) removed.push(`cache ${labelOf(c)}`);
  for (const w of b.wires) if (!a.wires.some((x) => x.id === w.id)) removed.push(`wire ${wireText(b, w.id)}`);
  return { added, removed, newSteps };
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
    return done(true, `added step ${name} (id ${made})${withP} at x ${pos?.x}, y ${pos?.y}${extra ? `; also ${extra} (the wire under it was split through it)` : ''}`, `+ step ${name}${withP}`, r.entries);
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

/** A step's or the hub's name for an action line. */
const endName = (shown: StudioDocument, e: End): string =>
  e.on === 'hub' ? 'workflow' : e.on === 'step' ? shown.graph.steps.get(e.step)?.name ?? e.step : e.on === 'wire' ? 'a junction' : 'an open end';

const connectTool: ToolDef = {
  name: 'connect',
  description: 'Draw a wire from a step\'s output (or the workflow circle, for an entry step) into a step\'s input, as a wire dragged from contact to contact. Its colour (family) is the head step\'s entry condition. Refused when it would make a short circuit.',
  parameters: {
    type: 'object',
    properties: {
      workflow: WORKFLOW_ARG,
      from: { type: 'string', description: 'The tail: a step (name or id), or "workflow" for the workflow circle.' },
      to: { type: 'string', description: 'The head: a step (name or id).' },
    },
    required: ['from', 'to'],
    additionalProperties: false,
  },
  async run(ctx, args) {
    const from = text(args.from) ?? '', to = text(args.to) ?? '';
    const asked = `connect ${from || '?'} → ${to || '?'}`;
    const found = await designDocOf(ctx, text(args.workflow), asked);
    if ('out' in found) return found.out;
    const { doc } = found;
    let tail: End;
    if (same(from, 'workflow')) tail = { on: 'hub', angle: null };
    else {
      const s = findStep(doc, from);
      if (!s.ok) return fail(s.error, asked);
      tail = { on: 'step', step: s.value, y: null };
    }
    const h = findStep(doc, to);
    if (!h.ok) return fail(h.error, asked);
    const { saved, shown, draft } = layersOf(doc);
    const wire: CircuitWire = { tail, head: { on: 'step', step: h.value, y: null } };
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

const joinTool: ToolDef = {
  name: 'join',
  description: 'Merge a wire into a trunk: its head (fan-in) or its tail (fan-out) on a step becomes a junction on another wire of the same family that ends (head) or starts (tail) on that same step, where that wire passes nearest it. Refused across families, steps, or for a wire on the workflow circle.',
  parameters: {
    type: 'object',
    properties: {
      workflow: WORKFLOW_ARG,
      wire: { type: 'string', description: 'The wire to merge: its id, or "from -> to".' },
      side: { type: 'string', enum: ['head', 'tail'], description: 'head for a fan-in, tail for a fan-out.' },
      host: { type: 'string', description: 'The trunk it joins: its id, or "from -> to".' },
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
    const mine = circuit[w.value]!, theirs = circuit[hostId.value]!;
    const name = wireText(shown, w.value), hostName = wireText(shown, hostId.value);
    const action = `join ${name}'s ${side} on ${hostName}`;
    if (w.value === hostId.value) return fail('a wire cannot join itself', action);
    const end = mine[side], hostEnd = theirs[side];
    if (end.on !== 'step') return fail(`the ${side} of ${name} is not on a step${end.on === 'hub' ? ' (a wire on the workflow circle stays separate)' : ''}`, action);
    if (hostEnd.on !== 'step' || hostEnd.step !== end.step) return fail(`${hostName} does not ${side === 'head' ? 'end' : 'start'} on the same step as ${name}: a junction merges wires of one step`, action);
    const route = shown.wires.find((x) => x.id === w.value), host = shown.wires.find((x) => x.id === hostId.value);
    if (!route || !host) return fail('one of the wires is not drawn', action);
    if (route.condition === null || route.condition !== host.condition) return fail(`${name} and ${hostName} are not of one family: wires of different families are never joined`, action);
    const point = side === 'tail' ? route.points[0]! : route.points.at(-1)!;
    const length = lengthOf([host.points]);
    const raw = nearestAlong(host.points, point) ?? 0;
    const at = Math.min(Math.max(snap(raw, GRID), CONTACT_MARGIN), Math.max(CONTACT_MARGIN, length - CONTACT_MARGIN));
    const target = { on: 'wire' as const, host: hostId.value, at };
    const why = judgeDrop(shown, circuit, w.value, side, target);
    if (toneOf(why) !== 'ok') return fail(`refused: ${dropLabel(why)}`, action);
    const next = withCircuit(draft, saved, setEnd(circuit, w.value, side, { on: 'wire', host: hostId.value, at }));
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

const moveBlocksTool: ToolDef = {
  name: 'move_blocks',
  description: 'Move blocks (steps, caches, the workflow circle) to new top-left corners, snapped to the 8 px grid, as one drag: one Undo step. Wires follow (the router draws them).',
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
    const next = moveBlocks(draft, saved, moved);
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
    const name = wireText(shown, w.value);
    const r = await act(ctx, doc.workflowId, { type: 'design', workflowId: doc.workflowId, draft: resetShape(draft, saved, w.value) }, { unchanged: `wire ${name} has no route of its own to reset` });
    if (!r.ok) return fail(r.error, `reset route of ${name} refused`);
    return done(true, `the route of wire ${name} is automatic again`, `reset route of ${name}`, r.entries);
  },
};

/** A pick by what the model wrote: a wire ("from -> to" or its id), "workflow", a step or a cache. */
function pickOf(doc: OpenDocument, shown: StudioDocument, ref: string): Found<{ pick: Pick; label: string }> {
  const t = ref.trim();
  if (/->|→/.test(t) || t.startsWith(NEW_WIRE_PREFIX)) {
    const w = findWire(doc, t);
    return w.ok ? { ok: true, value: { pick: { kind: 'wire', id: w.value }, label: `wire ${wireText(shown, w.value)}` } } : w;
  }
  const b = blockOf(doc, shown, t);
  return b.ok ? { ok: true, value: { pick: { kind: 'node', id: b.value.node }, label: b.value.label } } : b;
}

/** What the picks are, in words: each block and wire as the canvas names it. */
function picksText(shown: StudioDocument, picks: readonly Pick[]): string[] {
  return picks.map((p) => {
    if (p.kind === 'wire') return `wire ${wireText(shown, p.id)}`;
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
    const names = picksText(shown, picks);
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
  description: 'Paste what copy copied (Ctrl+V): an exact copy with new ids (names, fields and a cache\'s root included), placed clear of every block; the pasted items are picked. BaseApi refuses a cache root another cache has, so give a pasted cache a new root before Save.',
  parameters: { type: 'object', properties: { workflow: WORKFLOW_ARG }, additionalProperties: false },
  async run(ctx, args) {
    const found = await designDocOf(ctx, text(args.workflow), 'paste');
    if ('out' in found) return found.out;
    const { doc } = found;
    if (ctx.store.getState().clipboard === null) return fail('the clipboard is empty: pick and copy first', `paste into ${doc.name}: nothing copied`);
    const r = await act(ctx, doc.workflowId, { type: 'paste', workflowId: doc.workflowId, newId: ctx.newId }, { unchanged: 'nothing was pasted' });
    if (!r.ok) return fail(r.error, `paste into ${doc.name} refused`);
    const { added } = changesOf(r.before, r.after);
    return done(true, `pasted ${added.join(', ')}`, `pasted ${added.map((a) => a.replace(/ \(id .*\)$/, '')).join(', ')}`, r.entries);
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
    const names = picksText(shown, picks);
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
function historyTool(op: 'undo' | 'redo'): ToolDef {
  return {
    name: op,
    description: op === 'undo' ? 'Undo the last design step (Ctrl+Z), the user\'s or yours: one history for both. Field edits have no Undo (revert_entity).' : 'Redo the design step undone last (Ctrl+Y).',
    parameters: { type: 'object', properties: { workflow: WORKFLOW_ARG }, additionalProperties: false },
    async run(ctx, args) {
      const found = await designDocOf(ctx, text(args.workflow), op);
      if ('out' in found) return found.out;
      const { doc } = found;
      if ((op === 'undo' ? doc.design.past : doc.design.future).length === 0) return fail(`nothing to ${op} in ${labelOf(doc)}`, `${op} in ${labelOf(doc)}: nothing to ${op}`);
      const { entries } = await withEcho(ctx.store, () => [doc.workflowId], async () => { ctx.store.dispatch({ type: op, workflowId: doc.workflowId }); });
      const after = docOf(ctx, doc.workflowId)!;
      const { added, removed } = changesOf(doc, after);
      const changes = [...added.map((a) => `back: ${a}`), ...removed.map((r) => `gone: ${r}`)].join('; ');
      const past = op === 'undo' ? 'undid' : 'redid';
      return done(true, `${past} one design step in ${labelOf(doc)}${changes ? ` (${changes})` : ''}`, `${past} one step in ${labelOf(doc)}`, entries);
    },
  };
}

const discardTool: ToolDef = {
  name: 'discard_design',
  description: 'Discard every unsaved change to the workflow (the drawing and the Inspector\'s edits), back to its last Save (Discard design). The user is asked first.',
  parameters: { type: 'object', properties: { workflow: WORKFLOW_ARG }, additionalProperties: false },
  async run(ctx, args, answer, pin) {
    const found = await askedDocOf(ctx, 'discard design', text(args.workflow), answer, pin);
    if ('out' in found) return found.out;
    const { doc } = found;
    const label = labelOf(doc);
    if (!designDirty(doc)) return done(true, `${label} has no unsaved changes; nothing to discard`, `nothing to discard in ${doc.name}`);
    if (answer === undefined) return { kind: 'ask', question: { text: `Discard every unsaved change to ${label} (the drawing and the Inspector's edits)?`, choices: YES_NO, pin: doc.workflowId } };
    if (answer !== 'Yes') return fail('the user declined', `user declined: discard ${doc.name}`);
    const { entries } = await withEcho(ctx.store, () => [doc.workflowId], async () => { ctx.store.dispatch({ type: 'discardDesign', workflowId: doc.workflowId }); });
    return done(true, `discarded the unsaved changes to ${label}; it is as last saved`, `discarded the design of ${label}`, entries);
  },
};

export const DESIGN_TOOLS: ToolDef[] = [
  addStepTool, setProcessorTool, addCacheTool, connectTool, joinTool, autoConnectTool, moveBlocksTool, resetRouteTool,
  pickTool, copyTool, pasteTool, deletePickedTool, historyTool('undo'), historyTool('redo'), discardTool,
];
