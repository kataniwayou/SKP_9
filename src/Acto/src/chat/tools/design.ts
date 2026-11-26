import { CACHE_H, CACHE_W, STEP_H, STEP_W, TRIANGLE_H, TRIANGLE_W } from '../../board/geometry';
import { pickKey, livePicks, deletePicks, deleteRefusal } from '../../board/picks';
import { statusOf } from '../../live/liveState';
import type { Pick } from '../../board/selection';
import type { BoardState, ItemRef } from '../../design/board';
import { addCache, addEntry, addStep, addWire, linkCache, moveItems, removeEntries, removeWires, setCacheField, setEntryCron, unlinkCaches } from '../../design/edits';
import { restoreGhosts, withTheirWires, type GhostItem } from '../../design/ghosts';
import type { Rect } from '../../model/geometry';
import type { Id } from '../../model/graph';
import { cronText } from '../../model/cronText';
import { copyClip, copyMessage, countWords, pasteClip, pasteMessage, readClip, writeClip, type PastedRef } from '../../operate/clipboard';
import { freeOffset } from '../../operate/freeOffset';
import type { ToolContext, ToolDef, ToolOutcome } from '../toolTypes';
import { applyEdit, applyState, CACHE_ID, done, fail, linesSince, NO_ARGS, onBoard, STEP_ID, text, WORKFLOW_ID } from './common';
import { cardDeleteRefusal, onCard } from './cards';

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
  description: 'Add a cache named `name` (else cache, cache-2, …) with root `root`, version 1.0.0, unsaved until Save, on a free spot or at x, y. BaseAPI refuses to save a cache without a root. Answers its id.',
  parameters: { type: 'object', properties: { name: { type: 'string' }, root: { type: 'string' }, ...XY }, additionalProperties: false },
  async run(ctx, args) {
    const id = ctx.newId();
    const at = spot(ctx, args, CACHE_W, CACHE_H);
    const name = text(args, 'name').trim();
    const root = text(args, 'root').trim();
    const out = applyState(ctx, (b) => {
      let made = addCache(b, at, id);
      if (name !== '') made = setCacheField(made, id, 'name', name);
      if (root !== '') made = setCacheField(made, id, 'root', root);
      return made;
    }, 'add cache', '');
    if (!out.ok) return out;
    const c = ctx.store.state().caches[id]!;
    const noRoot = (c.root ?? '') === '' ? '; it has no root yet, and BaseAPI refuses to save a cache without one (set_field root)' : '';
    return done(true, `added cache ${c.name} ${c.version} (id ${id})${c.root ? ` with root ${c.root}` : ''}; it is not saved yet${noRoot}`, `add cache ${c.name}`);
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

const setEntryCronTool: ToolDef = {
  name: 'set_entry_cron', description: "Set or clear the cron of one entry arrow (an entry step of the workflow); value null or blank clears it. A cron has 5 fields, or 6 with seconds first (e.g. */10 * * * * * is every 10 seconds), at most 120 characters.",
  parameters: {
    type: 'object',
    properties: { workflow_id: WORKFLOW_ID, step_id: STEP_ID, value: { type: ['string', 'null'], description: 'The cron expression, or null to clear.' } },
    required: ['workflow_id', 'step_id', 'value'], additionalProperties: false,
  },
  async run(ctx, args) {
    const t = wfAnd(ctx, args, 'step', 'step_id', 'set entry cron');
    if ('out' in t) return t.out;
    if (!ctx.store.state().workflows[t.wf]!.entryStepIds.includes(t.other)) return fail(`${t.other} is not an entry step of ${nameOf(ctx, t.wf)}`, 'set entry cron');
    const value = typeof args.value === 'string' ? args.value : null;
    if (value?.trim()) {
      if (value.length > 120) return fail(`the cron is ${value.length} characters; at most 120`, 'set entry cron');
      const parsed = cronText(value);
      if ('problem' in parsed) return fail(`not a valid cron: ${parsed.problem}`, 'set entry cron');
    }
    return applyState(ctx, (b) => setEntryCron(b, t.wf, t.other, value), 'set entry cron', `${value?.trim() ? `set the cron of ${nameOf(ctx, t.wf)}'s entry arrow to ${t.other} to ${value.trim()}` : `cleared the cron of ${nameOf(ctx, t.wf)}'s entry arrow to ${t.other}`}`);
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
  description: 'Move steps, caches or triangles, and (while the Schemas mode is on) schema and processor cards, to new board positions (their top-left corner), as one change. A card move saves only its place: it changes nothing a workflow runs.',
  parameters: {
    type: 'object',
    properties: { blocks: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string', enum: ['step', 'cache', 'workflow', 'schema', 'processor'] }, id: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }, required: ['kind', 'id', 'x', 'y'], additionalProperties: false } } },
    required: ['blocks'], additionalProperties: false,
  },
  async run(ctx, args) {
    const list = Array.isArray(args.blocks) ? args.blocks : [];
    const moved: { ref: ItemRef; at: { x: number; y: number } }[] = [];
    for (const raw of list) {
      const r = (raw ?? {}) as Record<string, unknown>;
      const kind = r.kind === 'step' || r.kind === 'cache' || r.kind === 'workflow' || r.kind === 'schema' || r.kind === 'processor' ? r.kind : null;
      if (kind === null) return fail('each block needs a kind: step, cache, workflow, schema or processor', 'move blocks');
      const t = kind === 'schema' || kind === 'processor' ? onCard(ctx, kind, text(r, 'id'), 'move blocks') : onBoard(ctx, kind, text(r, 'id'), 'move blocks');
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
    case 'schema': case 'processor': {
      const t = onCard(ctx, r.kind, text(r, 'id'), 'pick');
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
    default: return bad('each item needs a kind: workflow, step, cache, wire, entry, cacheLink, schema or processor');
  }
}

const pickTool: ToolDef = {
  name: 'pick',
  description: 'Replace what is picked on the board (what copy and delete_picked act on; an empty list picks nothing). Items: {kind: step|cache|workflow, id}, {kind: wire, from, to}, {kind: entry, workflow_id, step_id}, {kind: cacheLink, workflow_id, cache_id}, and while the Schemas mode is on {kind: schema|processor, id} (a processor card is a processor no step uses). Taken as given: the picked triangles are the selected workflows, and nothing else stays selected.',
  parameters: {
    type: 'object',
    properties: { items: { type: 'array', items: { type: 'object', properties: {
      kind: { type: 'string', enum: ['workflow', 'step', 'cache', 'wire', 'entry', 'cacheLink', 'schema', 'processor'] }, id: { type: 'string' },
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
  description: "Copy workflows (triangles), steps and caches for paste: the ids given, or the picked ones when none is given. A paste makes new ones with every field the same but the name (and a cache's root, unique, named on like the name); the wires among copied steps are copied; a workflow copied alone pastes alone (no entry arrows, cache lines or assignments, like a step alone); copied with steps or caches it keeps its entry steps, caches and assignments (shared rows), joined to the copies of those copied with it. A step copied without its workflow gets no payloads.",
  parameters: { type: 'object', properties: {
    workflow_ids: { type: 'array', items: { type: 'string' } },
    step_ids: { type: 'array', items: { type: 'string' } },
    cache_ids: { type: 'array', items: { type: 'string' } },
  }, additionalProperties: false },
  async run(ctx, args) {
    const ids = (k: string) => (Array.isArray(args[k]) ? (args[k] as unknown[]).map(String) : null);
    const given = [['workflow', ids('workflow_ids')], ['step', ids('step_ids')], ['cache', ids('cache_ids')]] as const;
    let refs: ItemRef[];
    if (given.some(([, xs]) => xs !== null)) {
      refs = [];
      for (const [kind, xs] of given) {
        for (const id of xs ?? []) { const t = onBoard(ctx, kind, id, 'copy'); if ('out' in t) return t.out; refs.push({ kind, id }); }
      }
    } else {
      // [user, 2026-11-26] no Copy on schemas, and a processor is never copied: a pick with a card copies nothing
      if (ctx.commands.picks().some((p) => p.kind === 'schema' || p.kind === 'processor')) {
        return fail('schemas and processors are never copied: pick only workflows, steps or caches', 'copy');
      }
      refs = ctx.commands.picks().flatMap((p) => (p.kind === 'workflow' || p.kind === 'step' || p.kind === 'cache' ? [{ kind: p.kind, id: p.id }] : []));
    }
    const clip = copyClip(ctx.store.state(), refs);
    if (!clip) return fail('nothing to copy: pick workflows, steps or caches, or give their ids', 'copy');
    writeClip(ctx.session, clip);
    const msg = copyMessage(clip);
    ctx.output.log(msg, 'ok');
    return done(true, msg, 'copy');
  },
};

const paste: ToolDef = {
  name: 'paste', description: 'Paste what was copied as new workflows, steps and caches on free board (new names, every other field the same, unsaved; links and payloads as copy says) and pick them.',
  parameters: NO_ARGS,
  async run(ctx) {
    const clip = readClip(ctx.session);
    if (!clip) return fail('nothing copied yet', 'paste');
    let pasted: PastedRef[] = [];
    const out = applyState(ctx, (b) => { const r = pasteClip(b, clip, ctx.newId); pasted = r.pasted; return r.state; }, 'paste', '');
    if (!out.ok) return out;
    writeClip(ctx.session, { ...clip, pasted: clip.pasted + 1 });
    ctx.commands.setPicks(pasted.map((p) => ({ ...p })));
    const s = ctx.store.state();
    const names = pasted.map((p) => `${p.kind} ${(p.kind === 'step' ? s.steps : p.kind === 'cache' ? s.caches : s.workflows)[p.id]!.name}`).join(', ');
    const msg = pasteMessage(pasted);
    ctx.output.log(msg, 'ok');
    const n = (k: ItemRef['kind']) => pasted.filter((p) => p.kind === k).length;
    return done(true, `pasted ${countWords({ workflows: n('workflow'), steps: n('step'), caches: n('cache') })}: ${names}; they are picked and not saved yet`, 'paste');
  },
};

const describePicks = (picks: Pick[]): string => {
  const n = (k: Pick['kind']) => picks.filter((p) => p.kind === k).length;
  return ([['workflow', 'workflow'], ['step', 'step'], ['cache', 'cache'], ['wire', 'wire'], ['entry', 'entry arrow'], ['cacheLink', 'cache line'], ['schema', 'orphan schema'], ['processor', 'processor']] as const)
    .flatMap(([k, w]) => (n(k) > 0 ? [plural(n(k), w)] : [])).join(', ');
};

const parsePicks = (pin: string | undefined): Pick[] | null => {
  try { const v: unknown = JSON.parse(pin ?? ''); return Array.isArray(v) ? (v as Pick[]) : null; } catch { return null; }
};

const deletePicked: ToolDef = {
  name: 'delete_picked',
  description: 'Delete what is picked: workflows (with the payloads only they use), steps (with their wires, entry arrows and payloads), caches, wires, entry arrows and cache lines, as one change; or, picked on their own, orphan schemas. Each is a ghost until Save. Nothing is deleted when a picked workflow runs (or its run state is not known), nor when the picks hold a wired or held schema, a processor (never deleted), or orphan schemas mixed with other items. The user is asked first; what they confirm is exactly what was picked then.',
  parameters: NO_ARGS,
  async run(ctx, _args, answer, pin) {
    const asked = answer === undefined;
    const picks = asked ? ctx.commands.picks() : parsePicks(pin);
    if (picks === null) return fail('the question lost what it named: pick again', 'delete picked');
    const live = livePicks(picks, ctx.store.state());
    if (live.length === 0) return fail('nothing is picked: pick what to delete first', 'delete picked');
    const refused = [...cardDeleteRefusal(live, ctx.store.state()), ...deleteRefusal(live, ctx.store.state(), ctx.store.base(), (wf) => statusOf(ctx.live.getState(), wf))];
    if (refused.length) {
      for (const line of refused) ctx.output.log(line, 'warn');
      return fail(refused.join('; '), 'delete picked refused');
    }
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
  name: 'undo', description: "Undo the last change on the board (the one history the user's Undo uses).",
  parameters: NO_ARGS, run: async (ctx) => history(ctx, 'undo'),
};
const redo: ToolDef = {
  name: 'redo', description: 'Redo the change last undone on the board.',
  parameters: NO_ARGS, run: async (ctx) => history(ctx, 'redo'),
};

/** The name a ghost shows on the board (a link: its two ends). */
export function ghostName(g: GhostItem, lookup: (key: string) => GhostItem | undefined): string {
  const named = (key: string, id: string) => { const x = lookup(key); return x && 'row' in x ? x.row.name : id; };
  switch (g.kind) {
    case 'step': case 'cache': case 'workflow': case 'schema': return g.row.name;
    case 'wire': return `${named(`step:${g.from}`, g.from)} > ${named(`step:${g.to}`, g.to)}`;
    case 'entry': return `${named(`workflow:${g.workflowId}`, g.workflowId)} > ${named(`step:${g.stepId}`, g.stepId)}`;
    case 'cacheLink': return `${named(`workflow:${g.workflowId}`, g.workflowId)} > ${named(`cache:${g.cacheId}`, g.cacheId)}`;
  }
}

const GHOSTS_ARG = {
  type: 'object',
  properties: { ghosts: { type: 'array', items: { type: 'string' }, description: 'Ghost keys (list_ghosts gives them, e.g. step:<id>) or the names of deleted steps, caches or workflows.' } },
  required: ['ghosts'], additionalProperties: false,
};

/** The ghosts the call names, by key or by name (a name must match exactly one ghost), or the failed outcome. */
function ghostsOf(ctx: ToolContext, args: Record<string, unknown>, action: string): GhostItem[] | { out: ToolOutcome } {
  const store = ctx.ghosts;
  if (!store) return { out: fail('no ghosts here', action) };
  const wanted = Array.isArray(args.ghosts) ? args.ghosts.map(String) : [];
  if (wanted.length === 0) return { out: fail('no ghosts given', action) };
  const out: GhostItem[] = [];
  for (const w of wanted) {
    const byKey = store.get(w);
    const hits = byKey ? [byKey] : store.ghosts().filter((g) => ghostName(g, store.get) === w);
    if (hits.length === 0) return { out: fail(`no ghost ${w}: list_ghosts gives them`, action) };
    if (hits.length > 1) return { out: fail(`${hits.length} ghosts are named ${w}: give a key (${hits.map((g) => g.key).join(', ')})`, action) };
    if (!out.includes(hits[0]!)) out.push(hits[0]!);
  }
  return out;
}

const restoreGhostsTool: ToolDef = {
  name: 'restore_ghosts',
  description: "Put deleted items (ghosts) back on the board as one undoable edit, as the ghost toolbar's Restore does: the same row when BaseAPI still has it (an unsaved delete), else a new unsaved row. A restored step brings back its ghost wires (in and out) whose other end is on the board. A wire, entry arrow or cache line restored on its own comes back only when both its ends are on the board (else refused: restore <name> first).",
  parameters: GHOSTS_ARG,
  async run(ctx, args) {
    const items = ghostsOf(ctx, args, 'restore ghosts');
    if ('out' in items) return items.out;
    const store = ctx.ghosts!;
    const names = items.map((g) => ghostName(g, store.get)).join(', ');
    return applyEdit(ctx, (b) => restoreGhosts(b, ctx.store.base(), withTheirWires(b, items, store.ghosts()), store.get), 'restore ghosts', `restored ${names}; not saved yet`);
  },
};

const removeGhostsTool: ToolDef = {
  name: 'remove_ghosts',
  description: "Drop ghosts from the draft, as the ghost toolbar's Remove does. Nothing changes in BaseAPI and it is not an undo step.",
  parameters: GHOSTS_ARG,
  async run(ctx, args) {
    const items = ghostsOf(ctx, args, 'remove ghosts');
    if ('out' in items) return items.out;
    const store = ctx.ghosts!;
    const names = items.map((g) => ghostName(g, store.get)).join(', ');
    store.remove(items.map((g) => g.key));
    return done(true, `removed the ghost${items.length === 1 ? '' : 's'} ${names}`, 'remove ghosts');
  },
};

const setSchemasModeTool: ToolDef = {
  name: 'set_schemas_mode',
  description: "Turn the board's Schemas mode on or off, as the Schemas toggle above the board does (the browser remembers it). On: every schema is drawn as a card (wired, held or orphan), with the processors no step uses as read-only cards and the dotted reference wires, and the board is fitted to show them all; they can then be picked, moved, and orphans deleted. Off: they are hidden and let go of if picked. No board change: undo does not reverse it.",
  parameters: { type: 'object', properties: { on: { type: 'boolean' } }, required: ['on'], additionalProperties: false },
  async run(ctx, args) {
    if (typeof args.on !== 'boolean') return fail('on must be true or false', 'set schemas mode');
    const was = ctx.commands.schemasMode();
    if (was === args.on) return done(true, `the Schemas mode is already ${was ? 'on' : 'off'}`, `schemas mode ${was ? 'on' : 'off'}`);
    ctx.commands.setSchemasMode(args.on);
    return done(true, args.on ? 'turned the Schemas mode on: schema and processor cards are on the board' : 'turned the Schemas mode off: schema and processor cards are hidden', `schemas mode ${args.on ? 'on' : 'off'}`);
  },
};

export const DESIGN_TOOLS: ToolDef[] = [
  addStepTool, addCacheTool, connect, disconnect, setEntry, removeEntry, setEntryCronTool, linkCacheTool, unlinkCacheTool,
  moveBlocks, pickTool, copy, paste, deletePicked, undo, redo, restoreGhostsTool, removeGhostsTool, setSchemasModeTool,
];
