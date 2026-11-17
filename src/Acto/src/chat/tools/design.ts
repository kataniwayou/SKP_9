import { FRAME_PAD, STEP_W } from '../../board/geometry';
import type { Pick } from '../../board/picks';
import { stepSharing } from '../../design/shared';
import { addCache, addStep, addWire, deleteParts, linkCache, moveMany, removeWire, swapProcessor, unlinkCache, type WorkflowState } from '../../design/state';
import type { Id } from '../../model/graph';
import { copyClip, copyMessage, pasteClip, readClip, writeClip } from '../../operate/clipboard';
import { keepExistingSelection } from '../../session/view';
import type { ToolContext, ToolDef, ToolOutcome } from '../toolTypes';
import { done, edit, fail, linesSince, NO_ARGS, target, textOf, WORKFLOW_ID } from './common';

type Entries = Extract<ToolOutcome, { kind: 'done' }>['entries'];

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The outcome of one edit, as the tool's result; the board is panned to `focus` only when the edit went through. */
function outcome(ctx: ToolContext, wf: { id: Id; name: string }, r: Awaited<ReturnType<typeof edit>>, okText: string, action: string, focus: Id[] = []): ToolOutcome {
  if (!r.ok) return fail(`${wf.name}: ${r.result}`, `${action} failed`, r.entries);
  ctx.commands.focus(wf.id, focus);
  return done(true, r.result === 'done' ? okText : `${okText}. ${r.result}`, action, r.entries);
}

const STEP_ID = { type: 'string', description: 'The id of the step (read_design gives it).' };
const ARG = { type: 'object', properties: { workflow_id: WORKFLOW_ID }, required: ['workflow_id'], additionalProperties: false };

const addStepTool: ToolDef = {
  name: 'add_step',
  description: 'Add a step that runs a processor (list_processors gives them) to a workflow. Without x and y it goes right of the rightmost step, on its row. Answers the new step id.',
  parameters: { type: 'object', properties: { workflow_id: WORKFLOW_ID, processor_id: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }, required: ['workflow_id', 'processor_id'], additionalProperties: false },
  async run(ctx, args) {
    const t = target(ctx, args, 'add step');
    if ('out' in t) return t.out;
    const pid = str(args.processor_id);
    if (pid === '') return fail('add_step needs processor_id', 'add step failed');
    const p = ctx.processors().find((x) => x.id === pid);
    if (!p) return fail(`no processor ${pid} is listed (list_processors gives them)`, 'add step failed');
    const id = ctx.newId();
    const r = await edit(ctx, t.id, (s) => {
      const steps = Object.values(s.steps);
      const right = steps.length === 0 ? null : steps.reduce((a, b) => (b.at.x > a.at.x ? b : a));
      const dflt = right ? { x: right.at.x + STEP_W + 40, y: right.at.y } : { x: FRAME_PAD, y: FRAME_PAD };
      return addStep(s, p, { x: num(args.x) ?? dflt.x, y: num(args.y) ?? dflt.y }, id);
    });
    return outcome(ctx, t, r, `added step ${id} (${p.name}) to ${t.name}`, `added a ${p.name} step to ${t.name}`, [id]);
  },
};

const setProcessor: ToolDef = {
  name: 'set_processor',
  description: 'Change the processor a step runs (the step keeps its wires and settings).',
  parameters: { type: 'object', properties: { workflow_id: WORKFLOW_ID, step_id: STEP_ID, processor_id: { type: 'string' } }, required: ['workflow_id', 'step_id', 'processor_id'], additionalProperties: false },
  async run(ctx, args) {
    const t = target(ctx, args, 'set processor');
    if ('out' in t) return t.out;
    const stepId = str(args.step_id), pid = str(args.processor_id);
    const p = ctx.processors().find((x) => x.id === pid);
    if (!p) return fail(`no processor ${pid} is listed (list_processors gives them)`, 'set processor failed');
    if (!ctx.store.entry(t.id)?.history.present.steps[stepId]) return fail(`no step ${stepId} in ${t.name}`, 'set processor failed');
    const r = await edit(ctx, t.id, (s) => swapProcessor(s, stepId, p));
    return outcome(ctx, t, r, `step ${stepId} now runs ${p.name}`, `step runs ${p.name}`, [stepId]);
  },
};

const addCacheTool: ToolDef = {
  name: 'add_cache',
  description: 'Give a workflow a cache: link the existing cache `cache_id` (list_caches gives them), or without it make a new one named new-cache-N.',
  parameters: { type: 'object', properties: { workflow_id: WORKFLOW_ID, cache_id: { type: 'string' } }, required: ['workflow_id'], additionalProperties: false },
  async run(ctx, args) {
    const t = target(ctx, args, 'add cache');
    if ('out' in t) return t.out;
    const cid = str(args.cache_id);
    if (cid !== '') {
      const c = ctx.caches().find((x) => x.id === cid);
      if (!c) return fail(`no cache ${cid} is listed (list_caches gives them)`, 'add cache failed');
      const r = await edit(ctx, t.id, (s) => linkCache(s, c));
      return outcome(ctx, t, r, `linked cache ${c.name} to ${t.name}`, `linked cache ${c.name}`);
    }
    const taken = new Set([...ctx.store.boards().flatMap((b) => [...b.graph.caches.values()].map((c) => c.name)), ...ctx.caches().map((c) => c.name)]);
    let n = 1;
    while (taken.has(`new-cache-${n}`)) n++;
    const name = `new-cache-${n}`;
    const id = ctx.newId();
    const r = await edit(ctx, t.id, (s) => addCache(s, { id, name, version: '1.0.0', description: null, root: '', items: '{}', isNew: true }));
    return outcome(ctx, t, r, `added cache ${name} (id ${id}) to ${t.name}`, `added cache ${name}`);
  },
};

const WIRE = { type: 'object', properties: { workflow_id: WORKFLOW_ID, from: STEP_ID, to: STEP_ID }, required: ['workflow_id', 'from', 'to'], additionalProperties: false };

const connect: ToolDef = {
  name: 'connect',
  description: 'Draw a wire from one step to the next one in the same workflow.',
  parameters: WIRE,
  async run(ctx, args) {
    const t = target(ctx, args, 'connect');
    if ('out' in t) return t.out;
    const from = str(args.from), to = str(args.to);
    const r = await edit(ctx, t.id, (s) => {
      const w = addWire(s, from, to);
      return 'refused' in w ? w : w.state;
    });
    return outcome(ctx, t, r, `wired ${from} to ${to} in ${t.name}`, `wired ${from} to ${to}`, [from, to]);
  },
};

const disconnect: ToolDef = {
  name: 'disconnect',
  description: 'Remove the wire from one step to another.',
  parameters: WIRE,
  async run(ctx, args) {
    const t = target(ctx, args, 'disconnect');
    if ('out' in t) return t.out;
    const from = str(args.from), to = str(args.to);
    const s0 = ctx.store.entry(t.id)?.history.present;
    if (!s0?.steps[from]?.nextStepIds.includes(to)) return fail(`there is no wire from ${from} to ${to} in ${t.name}`, 'disconnect failed');
    const r = await edit(ctx, t.id, (s) => removeWire(s, from, to));
    return outcome(ctx, t, r, `removed the wire ${from} to ${to} in ${t.name}`, `removed wire ${from} to ${to}`, [from, to]);
  },
};

const moveBlocks: ToolDef = {
  name: 'move_blocks',
  description: 'Move steps to new positions inside their workflow frame (x, y from the frame body top-left), all as one undo step.',
  parameters: {
    type: 'object',
    properties: { workflow_id: WORKFLOW_ID, moves: { type: 'array', items: { type: 'object', properties: { step_id: STEP_ID, x: { type: 'number' }, y: { type: 'number' } }, required: ['step_id', 'x', 'y'] } } },
    required: ['workflow_id', 'moves'], additionalProperties: false,
  },
  async run(ctx, args) {
    const t = target(ctx, args, 'move');
    if ('out' in t) return t.out;
    const raw = Array.isArray(args.moves) ? (args.moves as Record<string, unknown>[]) : [];
    const s0 = ctx.store.entry(t.id)!.history.present;
    const steps: { id: Id; at: { x: number; y: number } }[] = [];
    for (const m of raw) {
      const id = str(m?.step_id), x = num(m?.x), y = num(m?.y);
      if (!s0.steps[id]) return fail(`no step ${id} in ${t.name}`, 'move failed');
      if (x === null || y === null) return fail(`move of ${id} needs numeric x and y`, 'move failed');
      steps.push({ id, at: { x: Math.max(FRAME_PAD, x), y: Math.max(FRAME_PAD, y) } });
    }
    if (steps.length === 0) return fail('move_blocks needs at least one move', 'move failed');
    const r = await edit(ctx, t.id, (s) => moveMany(s, { steps }));
    const n = `${steps.length} step${steps.length === 1 ? '' : 's'}`;
    return outcome(ctx, t, r, `moved ${n} in ${t.name}`, `moved ${n}`, steps.map((m) => m.id));
  },
};

const pick: ToolDef = {
  name: 'pick',
  description: "Set what is picked on the board (what the user sees selected), replacing the picks. Items: {kind:'workflow',workflowId} · {kind:'step',workflowId,stepId} · {kind:'wire',workflowId,wireId:'from>to'} · {kind:'cache',workflowId,cacheId}. An empty list clears them. copy and delete_picked act on the picks.",
  parameters: {
    type: 'object',
    properties: { items: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string', enum: ['workflow', 'step', 'wire', 'cache'] }, workflowId: { type: 'string' }, stepId: { type: 'string' }, wireId: { type: 'string' }, cacheId: { type: 'string' } }, required: ['kind', 'workflowId'] } } },
    required: ['items'], additionalProperties: false,
  },
  async run(ctx, args) {
    const items = Array.isArray(args.items) ? (args.items as Record<string, unknown>[]) : [];
    const picks: Pick[] = [];
    for (const it of items) {
      const kind = str(it?.kind), workflowId = str(it?.workflowId);
      let p: Pick | null = null;
      if (kind === 'workflow') p = { kind, workflowId };
      else if (kind === 'step') p = { kind, workflowId, stepId: str(it.stepId) };
      else if (kind === 'wire') p = { kind, workflowId, wireId: str(it.wireId) };
      else if (kind === 'cache') p = { kind, workflowId, cacheId: str(it.cacheId) };
      if (!p) return fail(`cannot pick ${JSON.stringify(it)}: unknown kind ${kind}`, 'pick failed');
      if (keepExistingSelection(p, ctx.store.boards()) === null) return fail(`cannot pick ${JSON.stringify(it)}: it is not on the board`, 'pick failed');
      picks.push(p);
    }
    ctx.commands.setPicks(picks);
    const last = picks.at(-1);
    if (last) {
      const steps = picks.flatMap((p) => (p.kind === 'step' && p.workflowId === last.workflowId ? [p.stepId] : []));
      ctx.commands.focus(last.workflowId, steps.length > 0 ? steps : undefined);
    }
    const text = picks.length === 0 ? 'cleared the picks' : `picked ${picks.length} item${picks.length === 1 ? '' : 's'}`;
    return done(true, text, text);
  },
};

const copy: ToolDef = {
  name: 'copy',
  description: 'Copy the picked steps (and the wires between them) to the board clipboard. paste puts them into a workflow.',
  parameters: NO_ARGS,
  async run(ctx) {
    const ids = new Map<Id, Set<Id>>();
    for (const p of ctx.commands.picks()) if (p.kind === 'step') (ids.get(p.workflowId) ?? ids.set(p.workflowId, new Set()).get(p.workflowId)!).add(p.stepId);
    const parts = [...ids].flatMap(([id, set]) => {
      const state = ctx.store.entry(id)?.history.present;
      return state ? [{ state, stepIds: [...set] }] : [];
    });
    const clip = copyClip(parts);
    if (!clip) return fail('Nothing to copy — pick steps first', 'copy failed');
    writeClip(ctx.session, clip);
    ctx.output.log(copyMessage(clip), 'ok');
    return done(true, copyMessage(clip), copyMessage(clip));
  },
};

const paste: ToolDef = {
  name: 'paste',
  description: 'Paste the copied steps into a workflow (new ids, free space, near the last picked step when it is in that workflow). The pasted steps become the picks.',
  parameters: ARG,
  async run(ctx, args) {
    const t = target(ctx, args, 'paste');
    if ('out' in t) return t.out;
    const clip = readClip(ctx.session);
    if (!clip) return fail('Nothing copied yet', 'paste failed');
    const last = ctx.commands.picks().at(-1);
    const near = last && last.kind === 'step' && last.workflowId === t.id ? last.stepId : null;
    let pasted: Id[] = [];
    const r = await edit(ctx, t.id, (s) => { const x = pasteClip(s, clip, near, ctx.newId); pasted = x.pasted; return x.state; });
    if (!r.ok || pasted.length === 0) return fail(`${t.name}: ${r.ok ? 'nothing was pasted' : r.result}`, 'paste failed', r.entries);
    writeClip(ctx.session, { ...clip, pasted: clip.pasted + 1 });
    ctx.commands.setPicks(pasted.map((stepId) => ({ kind: 'step' as const, workflowId: t.id, stepId })));
    ctx.commands.focus(t.id, pasted);
    const n = `${pasted.length} step${pasted.length === 1 ? '' : 's'}`;
    return done(true, `pasted ${n} into ${t.name} (ids ${pasted.join(', ')})`, `pasted ${n}`, r.entries);
  },
};

const deletePicked: ToolDef = {
  name: 'delete_picked',
  description: 'Delete the picked steps, wires and caches (what the selection bar Delete does; a shared step goes from this workflow only). The user is asked first. Picked workflows are not deleted here (delete_workflow).',
  parameters: NO_ARGS,
  async run(ctx, _args, answer, pin) {
    // the question names the picks it was asked about and pins them: an answer deletes exactly those
    let picked: Pick[] = [];
    if (answer === undefined) picked = ctx.commands.picks();
    else {
      try { const v: unknown = JSON.parse(pin ?? '[]'); if (Array.isArray(v)) picked = v as Pick[]; } catch { /* no pin: nothing */ }
    }
    const per = new Map<Id, { steps: Id[]; wires: [Id, Id][]; caches: Id[] }>();
    const named: string[] = [];
    const stepName = (wf: Id, step: Id) => ctx.store.entry(wf)?.history.present.steps[step]?.name ?? step;
    for (const p of picked) {
      if (p.kind === 'workflow') continue;
      const wfName = ctx.store.entry(p.workflowId)?.history.present.fields.name ?? p.workflowId;
      const e = per.get(p.workflowId) ?? { steps: [], wires: [], caches: [] };
      per.set(p.workflowId, e);
      if (p.kind === 'step') { e.steps.push(p.stepId); named.push(`step ${stepName(p.workflowId, p.stepId)} (${wfName})`); }
      else if (p.kind === 'wire') {
        const i = p.wireId.indexOf('>');
        const from = p.wireId.slice(0, i), to = p.wireId.slice(i + 1);
        e.wires.push([from, to]);
        named.push(`wire ${stepName(p.workflowId, from)} → ${stepName(p.workflowId, to)} (${wfName})`);
      } else {
        e.caches.push(p.cacheId);
        named.push(`cache ${ctx.store.entry(p.workflowId)?.history.present.caches[p.cacheId]?.name ?? p.cacheId} (${wfName})`);
      }
    }
    if (per.size === 0) return fail('nothing is picked to delete (pick steps, wires or caches first)', 'delete failed');
    if (answer === undefined) {
      const shown = named.slice(0, 5).join(', ') + (named.length > 5 ? ` and ${named.length - 5} more` : '');
      return { kind: 'ask', question: { text: `Delete ${shown}?`, choices: ['Delete', 'Cancel'], pin: JSON.stringify(picked) } };
    }
    if (answer !== 'Delete') return fail('the user declined', 'user declined: delete picked');
    const notes: string[] = [];
    const entries: Entries = [];
    let failed = 0;
    for (const [wf, e] of per) {
      const name = ctx.store.entry(wf)?.history.present.fields.name;
      if (name === undefined) { notes.push(`no workflow ${wf} on the board`); failed++; continue; }
      const { shared, others } = stepSharing(ctx.store.boards(), wf);
      let refused: string[] = [];
      const before = ctx.store.entry(wf)?.history.present;
      const r = await edit(ctx, wf, (st: WorkflowState) => {
        const out = deleteParts(st, e.steps, e.wires, shared, others);
        refused = out.refused;
        return e.caches.reduce(unlinkCache, out.state);
      });
      entries.push(...r.entries);
      notes.push(...refused);
      if (r.ok && ctx.store.entry(wf)?.history.present !== before) ctx.commands.focus(wf);
      else {
        failed++;   // refused, or nothing there to delete any more
        if (!r.ok) notes.push(`${name}: ${r.result}`);
      }
    }
    const last = ctx.commands.picks().at(-1);
    if (last && failed < per.size) ctx.commands.setPicks([{ kind: 'workflow', workflowId: last.workflowId }]);
    const tail = notes.length > 0 ? ` ${notes.join('; ')}` : '';
    if (failed === per.size) return fail(`nothing was deleted.${tail}`, 'delete failed', entries);
    return done(true, `deleted the picked items.${tail}`, 'deleted the picked items', entries);
  },
};

async function history(ctx: ToolContext, args: Record<string, unknown>, way: 'undo' | 'redo'): Promise<ToolOutcome> {
  const t = target(ctx, args, way);
  if ('out' in t) return t.out;
  const before = ctx.store.entry(t.id)!.history.present;
  const mark = ctx.output.lines().at(-1);
  if (way === 'undo') ctx.store.undo(t.id); else ctx.store.redo(t.id);
  const lines = linesSince(ctx, mark);
  const entries: Entries = lines.map((l) => ({ kind: 'output' as const, text: l.text, level: l.level, name: t.name }));
  if (ctx.store.entry(t.id)!.history.present === before) {
    return fail(textOf(lines, `${t.name}: nothing to ${way}`), `${way} ${t.name} failed`, entries);
  }
  ctx.commands.focus(t.id);
  return done(true, `${way === 'undo' ? 'undid' : 'redid'} the last change in ${t.name}`, `${way} ${t.name}`, entries);
}

const undo: ToolDef = {
  name: 'undo', description: "Undo the last change in a workflow (the history the user's Ctrl+Z uses, fields included).",
  parameters: ARG, run: (ctx, args) => history(ctx, args, 'undo'),
};
const redo: ToolDef = {
  name: 'redo', description: 'Redo the change last undone in a workflow.',
  parameters: ARG, run: (ctx, args) => history(ctx, args, 'redo'),
};

export const DESIGN_TOOLS: ToolDef[] = [addStepTool, setProcessor, addCacheTool, connect, disconnect, moveBlocks, pick, copy, paste, deletePicked, undo, redo];
