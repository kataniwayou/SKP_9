import { CACHE_H, CACHE_W, STEP_H, STEP_W, TRIANGLE_H, TRIANGLE_W } from '../../board/geometry';
import { pickKey, livePicks, deletePicks } from '../../board/picks';
import type { Pick } from '../../board/selection';
import type { BoardState, ItemRef } from '../../design/board';
import { addCache, addEntry, addStep, addWire, linkCache, moveItems, removeEntries, removeWires, unlinkCaches } from '../../design/edits';
import type { Rect } from '../../model/geometry';
import type { Id } from '../../model/graph';
import { copyClip, copyMessage, pasteClip, readClip, writeClip } from '../../operate/clipboard';
import { freeOffset } from '../../operate/freeOffset';
import type { ToolContext, ToolDef, ToolOutcome } from '../toolTypes';
import { applyEdit, applyState, CACHE_ID, done, fail, linesSince, NO_ARGS, onBoard, STEP_ID, text, WORKFLOW_ID } from './common';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Everything that stands on the board, as boxes. */
function boxes(b: BoardState): Rect[] {
  const at = (p: { x: number; y: number } | null) => p ?? { x: 0, y: 0 };
  return [
    ...Object.values(b.steps).map((s) => ({ ...at(s.at), w: STEP_W, h: STEP_H })),
    ...Object.values(b.caches).map((c) => ({ ...at(c.at), w: CACHE_W, h: CACHE_H })),
    ...Object.values(b.workflows).map((w) => ({ ...at(w.at), w: TRIANGLE_W, h: TRIANGLE_H })),
  ];
}

/** Where a new thing goes: the given spot, else the free spot nearest to the board's corner. */
function spot(ctx: ToolContext, args: Record<string, unknown>, w: number, h: number) {
  if (typeof args.x === 'number' && typeof args.y === 'number') return { x: args.x, y: args.y };
  return freeOffset([{ x: 0, y: 0, w, h }], boxes(ctx.store.state()), { x: 40, y: 40 });
}

const XY = { x: { type: 'number', description: 'Board x of the left edge (optional: a free spot).' }, y: { type: 'number', description: 'Board y of the top edge (optional).' } };

const addStepTool: ToolDef = {
  name: 'add_step',
  description: 'Add a step that runs a processor (list_processors gives the ids), on a free spot or at x, y. It is named after the processor unless `name` is given, version 1.0.0, unsaved until Save. It takes part in no workflow until an entry arrow or wire reaches it. Answers its id.',
  parameters: { type: 'object', properties: { processor_id: { type: 'string' }, name: { type: 'string' }, ...XY }, required: ['processor_id'], additionalProperties: false },
  async run(ctx, args) {
    const pid = text(args, 'processor_id');
    const p = ctx.store.state().processors[pid] ?? ctx.processors().find((x) => x.id === pid);
    if (!p) return fail(`no processor ${pid === '' ? '(none given)' : pid}`, 'add step');
    const id = ctx.newId();
    const at = spot(ctx, args, STEP_W, STEP_H);
    const wanted = text(args, 'name').trim();
    const out = applyState(ctx, (b) => {
      const made = addStep(b, p, at, id);
      return wanted === '' ? made : { ...made, steps: { ...made.steps, [id]: { ...made.steps[id]!, name: wanted } } };
    }, 'add step', '');
    if (!out.ok) return out;
    const st = ctx.store.state().steps[id]!;
    return done(true, `added step ${st.name} ${st.version} (id ${id}) running ${p.name}; it is not saved yet`, `add step ${st.name}`);
  },
};

const addCacheTool: ToolDef = {
  name: 'add_cache',
  description: 'Add a cache named new-cache-N (version 1.0.0, unsaved until Save), on a free spot or at x, y. Answers its id.',
  parameters: { type: 'object', properties: { ...XY }, additionalProperties: false },
  async run(ctx, args) {
    const id = ctx.newId();
    const at = spot(ctx, args, CACHE_W, CACHE_H);
    const out = applyState(ctx, (b) => addCache(b, at, id), 'add cache', '');
    if (!out.ok) return out;
    const c = ctx.store.state().caches[id]!;
    return done(true, `added cache ${c.name} ${c.version} (id ${id}); it is not saved yet`, `add cache ${c.name}`);
  },
};

const FROM_TO = {
  type: 'object',
  properties: { from: { ...STEP_ID, description: 'The step the wire starts at.' }, to: { ...STEP_ID, description: 'The step that runs after it.' } },
  required: ['from', 'to'], additionalProperties: false,
};

function ends(ctx: ToolContext, args: Record<string, unknown>, action: string): { from: Id; to: Id } | { out: ToolOutcome } {
  const from = onBoard(ctx, 'step', text(args, 'from'), action);
  if ('out' in from) return from;
  const to = onBoard(ctx, 'step', text(args, 'to'), action);
  return 'out' in to ? to : { from: from.id, to: to.id };
}

const connect: ToolDef = {
  name: 'connect', description: 'Wire one step to another: the second runs after the first. A wire that already exists is refused.',
  parameters: FROM_TO,
  async run(ctx, args) {
    const e = ends(ctx, args, 'connect');
    if ('out' in e) return e.out;
    const s = ctx.store.state().steps;
    return applyEdit(ctx, (b) => addWire(b, e.from, e.to), 'connect', `wired ${s[e.from]!.name} to ${s[e.to]!.name}`);
  },
};

const disconnect: ToolDef = {
  name: 'disconnect', description: 'Remove the wire between two steps.',
  parameters: FROM_TO,
  async run(ctx, args) {
    const e = ends(ctx, args, 'disconnect');
    if ('out' in e) return e.out;
    if (!ctx.store.state().steps[e.from]!.nextStepIds.includes(e.to)) return fail(`no wire ${e.from} > ${e.to} on the board`, 'disconnect');
    return applyState(ctx, (b) => removeWires(b, [[e.from, e.to]]), 'disconnect', `removed the wire ${e.from} > ${e.to}`);
  },
};

const WF_STEP = { type: 'object', properties: { workflow_id: WORKFLOW_ID, step_id: STEP_ID }, required: ['workflow_id', 'step_id'], additionalProperties: false };
const WF_CACHE = { type: 'object', properties: { workflow_id: WORKFLOW_ID, cache_id: CACHE_ID }, required: ['workflow_id', 'cache_id'], additionalProperties: false };

function wfAnd(ctx: ToolContext, args: Record<string, unknown>, what: 'step' | 'cache', key: string, action: string): { wf: Id; other: Id } | { out: ToolOutcome } {
  const wf = onBoard(ctx, 'workflow', text(args, 'workflow_id'), action);
  if ('out' in wf) return wf;
  const o = onBoard(ctx, what, text(args, key), action);
  return 'out' in o ? o : { wf: wf.id, other: o.id };
}

const nameOf = (ctx: ToolContext, wf: Id) => ctx.store.state().workflows[wf]!.name;

const setEntry: ToolDef = {
  name: 'set_entry', description: "Draw the workflow's entry arrow to a step: the workflow starts there. One arrow per step.",
  parameters: WF_STEP,
  async run(ctx, args) {
    const t = wfAnd(ctx, args, 'step', 'step_id', 'set entry');
    if ('out' in t) return t.out;
    const out = applyEdit(ctx, (b) => addEntry(b, t.wf, t.other), 'set entry', `${nameOf(ctx, t.wf)} now starts at ${ctx.store.state().steps[t.other]!.name}`);
    if (out.kind === 'done' && out.ok) ctx.commands.focus(t.wf, [t.other]);
    return out;
  },
};

const removeEntry: ToolDef = {
  name: 'remove_entry', description: "Remove the workflow's entry arrow to a step.",
  parameters: WF_STEP,
  async run(ctx, args) {
    const t = wfAnd(ctx, args, 'step', 'step_id', 'remove entry');
    if ('out' in t) return t.out;
    if (!ctx.store.state().workflows[t.wf]!.entryStepIds.includes(t.other)) return fail(`${nameOf(ctx, t.wf)} has no entry arrow to ${t.other}`, 'remove entry');
    return applyState(ctx, (b) => removeEntries(b, [[t.wf, t.other]]), 'remove entry', `removed the entry arrow of ${nameOf(ctx, t.wf)} to ${t.other}`);
  },
};

const linkCacheTool: ToolDef = {
  name: 'link_cache', description: 'Link a cache to a workflow (the dashed line from its back). One line per cache.',
  parameters: WF_CACHE,
  async run(ctx, args) {
    const t = wfAnd(ctx, args, 'cache', 'cache_id', 'link cache');
    if ('out' in t) return t.out;
    return applyEdit(ctx, (b) => linkCache(b, t.wf, t.other), 'link cache', `${nameOf(ctx, t.wf)} now uses ${ctx.store.state().caches[t.other]!.name}`);
  },
};

const unlinkCacheTool: ToolDef = {
  name: 'unlink_cache', description: "Remove a workflow's line to a cache.",
  parameters: WF_CACHE,
  async run(ctx, args) {
    const t = wfAnd(ctx, args, 'cache', 'cache_id', 'unlink cache');
    if ('out' in t) return t.out;
    if (!ctx.store.state().workflows[t.wf]!.cacheIds.includes(t.other)) return fail(`${nameOf(ctx, t.wf)} does not use cache ${t.other}`, 'unlink cache');
    return applyState(ctx, (b) => unlinkCaches(b, [[t.wf, t.other]]), 'unlink cache', `${nameOf(ctx, t.wf)} no longer uses ${t.other}`);
  },
};

const moveBlocks: ToolDef = {
  name: 'move_blocks',
  description: 'Move steps, caches or triangles to new board positions (their top-left corner), as one change.',
  parameters: {
    type: 'object',
    properties: { blocks: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string', enum: ['step', 'cache', 'workflow'] }, id: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }, required: ['kind', 'id', 'x', 'y'], additionalProperties: false } } },
    required: ['blocks'], additionalProperties: false,
  },
  async run(ctx, args) {
    const list = Array.isArray(args.blocks) ? args.blocks : [];
    const moved: { ref: ItemRef; at: { x: number; y: number } }[] = [];
    for (const raw of list) {
      const r = (raw ?? {}) as Record<string, unknown>;
      const kind = r.kind === 'step' || r.kind === 'cache' || r.kind === 'workflow' ? r.kind : null;
      if (kind === null) return fail('each block needs a kind: step, cache or workflow', 'move blocks');
      const t = onBoard(ctx, kind, text(r, 'id'), 'move blocks');
      if ('out' in t) return t.out;
      if (typeof r.x !== 'number' || typeof r.y !== 'number') return fail(`block ${t.id} needs a number x and y`, 'move blocks');
      moved.push({ ref: { kind, id: t.id }, at: { x: r.x, y: r.y } });
    }
    if (moved.length === 0) return fail('no blocks given', 'move blocks');
    return applyState(ctx, (b) => moveItems(b, moved), 'move blocks', `moved ${plural(moved.length, 'block')}`);
  },
};

/** One item of a pick call as a Pick, checked against the board; the failed outcome otherwise. */
function toPick(ctx: ToolContext, r: Record<string, unknown>): Pick | { out: ToolOutcome } {
  const b = ctx.store.state();
  const bad = (msg: string) => ({ out: fail(msg, 'pick') });
  switch (r.kind) {
    case 'workflow': case 'step': case 'cache': {
      const t = onBoard(ctx, r.kind, text(r, 'id'), 'pick');
      return 'out' in t ? t : ({ kind: r.kind, id: t.id } as Pick);
    }
    case 'wire': {
      const from = text(r, 'from'), to = text(r, 'to');
      return b.steps[from]?.nextStepIds.includes(to) ? { kind: 'wire', from, to } : bad(`no wire ${from} > ${to} on the board`);
    }
    case 'entry': {
      const w = text(r, 'workflow_id'), s = text(r, 'step_id');
      return b.workflows[w]?.entryStepIds.includes(s) ? { kind: 'entry', workflowId: w, stepId: s } : bad(`no entry arrow ${w} > ${s} on the board`);
    }
    case 'cacheLink': {
      const w = text(r, 'workflow_id'), c = text(r, 'cache_id');
      return b.workflows[w]?.cacheIds.includes(c) ? { kind: 'cacheLink', workflowId: w, cacheId: c } : bad(`no cache line ${w} > ${c} on the board`);
    }
    default: return bad('each item needs a kind: workflow, step, cache, wire, entry or cacheLink');
  }
}

const pickTool: ToolDef = {
  name: 'pick',
  description: 'Replace what is picked on the board (what copy and delete_picked act on; an empty list picks nothing). Items: {kind: step|cache|workflow, id}, {kind: wire, from, to}, {kind: entry, workflow_id, step_id}, {kind: cacheLink, workflow_id, cache_id}. Taken as given: the picked triangles are the selected workflows, and nothing else stays selected.',
  parameters: {
    type: 'object',
    properties: { items: { type: 'array', items: { type: 'object', properties: {
      kind: { type: 'string', enum: ['workflow', 'step', 'cache', 'wire', 'entry', 'cacheLink'] }, id: { type: 'string' },
      from: { type: 'string' }, to: { type: 'string' }, workflow_id: { type: 'string' }, step_id: { type: 'string' }, cache_id: { type: 'string' },
    }, required: ['kind'], additionalProperties: false } } },
    required: ['items'], additionalProperties: false,
  },
  async run(ctx, args) {
    const raw = Array.isArray(args.items) ? args.items : [];
    const picks: Pick[] = [];
    for (const item of raw) {
      const p = toPick(ctx, (item ?? {}) as Record<string, unknown>);
      if ('out' in p) return p.out;
      if (!picks.some((x) => pickKey(x) === pickKey(p))) picks.push(p);
    }
    ctx.commands.setPicks(picks);
    return done(true, picks.length === 0 ? 'picked nothing' : `picked ${plural(picks.length, 'item')}`, `pick ${picks.length}`);
  },
};

const copy: ToolDef = {
  name: 'copy',
  description: 'Copy steps (step_ids, or the picked steps when not given) and the wires among them for paste. No payloads are copied.',
  parameters: { type: 'object', properties: { step_ids: { type: 'array', items: { type: 'string' } } }, additionalProperties: false },
  async run(ctx, args) {
    const given = Array.isArray(args.step_ids) ? args.step_ids.map(String) : null;
    const ids = given ?? ctx.commands.picks().flatMap((p) => (p.kind === 'step' ? [p.id] : []));
    for (const id of ids) { const t = onBoard(ctx, 'step', id, 'copy'); if ('out' in t) return t.out; }
    const clip = copyClip(ctx.store.state(), ids);
    if (!clip) return fail('nothing to copy: pick steps or give step_ids', 'copy');
    writeClip(ctx.session, clip);
    const msg = copyMessage(clip);
    ctx.output.log(msg, 'ok');
    return done(true, msg, 'copy');
  },
};

const paste: ToolDef = {
  name: 'paste', description: 'Paste the copied steps as new steps on free board (new names, unsaved, no payloads) and pick them.',
  parameters: NO_ARGS,
  async run(ctx) {
    const clip = readClip(ctx.session);
    if (!clip) return fail('nothing copied yet', 'paste');
    let pasted: Id[] = [];
    const out = applyState(ctx, (b) => { const r = pasteClip(b, clip, ctx.newId); pasted = r.pasted; return r.state; }, 'paste', '');
    if (!out.ok) return out;
    writeClip(ctx.session, { ...clip, pasted: clip.pasted + 1 });
    ctx.commands.setPicks(pasted.map((id) => ({ kind: 'step' as const, id })));
    const names = pasted.map((id) => ctx.store.state().steps[id]!.name).join(', ');
    ctx.output.log(`Pasted ${plural(pasted.length, 'step')}`, 'ok');
    return done(true, `pasted ${plural(pasted.length, 'step')}: ${names}; they are picked and not saved yet`, 'paste');
  },
};

const describePicks = (picks: Pick[]): string => {
  const n = (k: Pick['kind']) => picks.filter((p) => p.kind === k).length;
  return ([['step', 'step'], ['cache', 'cache'], ['wire', 'wire'], ['entry', 'entry arrow'], ['cacheLink', 'cache line']] as const)
    .flatMap(([k, w]) => (n(k) > 0 ? [plural(n(k), w)] : [])).join(', ');
};

const parsePicks = (pin: string | undefined): Pick[] | null => {
  try { const v: unknown = JSON.parse(pin ?? ''); return Array.isArray(v) ? (v as Pick[]) : null; } catch { return null; }
};

const deletePicked: ToolDef = {
  name: 'delete_picked',
  description: 'Delete what is picked: steps (with their wires, entry arrows and payloads), caches, wires, entry arrows and cache lines, as one change. The user is asked first; what they confirm is exactly what was picked then. A picked triangle is not deleted here: use delete_workflow.',
  parameters: NO_ARGS,
  async run(ctx, _args, answer, pin) {
    const asked = answer === undefined;
    const picks = asked ? ctx.commands.picks() : parsePicks(pin);
    if (picks === null) return fail('the question lost what it named: pick again', 'delete picked');
    if (picks.some((p) => p.kind === 'workflow')) return fail('a picked triangle is deleted with delete_workflow, not delete_picked', 'delete picked');
    const live = livePicks(picks, ctx.store.state());
    if (live.length === 0) return fail('nothing is picked: pick what to delete first', 'delete picked');
    if (asked) return { kind: 'ask', question: { text: `Delete ${describePicks(live)}?`, choices: ['Delete', 'Cancel'], pin: JSON.stringify(live) } };
    if (answer !== 'Delete') return fail('the user declined', 'user declined: delete picked');
    const out = applyState(ctx, (b) => deletePicks(b, live), 'delete picked', `deleted ${describePicks(live)}`);
    if (out.kind === 'done' && out.ok) ctx.commands.setPicks([]);
    return out;
  },
};

function history(ctx: ToolContext, way: 'undo' | 'redo'): ToolOutcome {
  const before = ctx.store.state();
  const mark = ctx.output.lines().at(-1);
  if (way === 'undo') ctx.store.undo(); else ctx.store.redo();
  const lines = linesSince(ctx, mark);
  const entries = lines.map((l) => ({ kind: 'output' as const, text: l.text, level: l.level, name: 'board' }));
  if (ctx.store.state() === before) return fail(lines.map((l) => l.text).join('; ') || `nothing to ${way}`, `${way} failed`, entries);
  return done(true, `${way === 'undo' ? 'undid' : 'redid'} the last change on the board`, way, entries);
}

const undo: ToolDef = {
  name: 'undo', description: "Undo the last change on the board (the one history the user's Ctrl+Z uses).",
  parameters: NO_ARGS, run: async (ctx) => history(ctx, 'undo'),
};
const redo: ToolDef = {
  name: 'redo', description: 'Redo the change last undone on the board.',
  parameters: NO_ARGS, run: async (ctx) => history(ctx, 'redo'),
};

export const DESIGN_TOOLS: ToolDef[] = [
  addStepTool, addCacheTool, connect, disconnect, setEntry, removeEntry, linkCacheTool, unlinkCacheTool,
  moveBlocks, pickTool, copy, paste, deletePicked, undo, redo,
];
