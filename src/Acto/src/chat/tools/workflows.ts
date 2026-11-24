import { describeError } from '../../api/describeError';
import { deletePicks, deleteRefusal } from '../../board/picks';
import { boardChanges } from '../../design/changes';
import { addWorkflow, setWorkflowField } from '../../design/edits';
import { nameOf, saveBoard, takeStored } from '../../design/saveBoard';
import { runWorkflow, type RunOp } from '../../operate/runWorkflow';
import { statusOf } from '../../live/liveState';
import type { ToolContext, ToolDef, ToolOutcome } from '../toolTypes';
import { applyState, done, fail, linesSince, NO_ARGS, target, textOf, withOutput, WORKFLOW_ID } from './common';

const ARG = { type: 'object', properties: { workflow_id: WORKFLOW_ID }, required: ['workflow_id'], additionalProperties: false };

const newWorkflow: ToolDef = {
  name: 'new_workflow',
  description: 'Make a new triangle on free board, named `name` or untitled, untitled-2, … (version 1.0.0, no entry arrows, so it is not scheduled). It exists only on the board until the board is saved. Answers its id.',
  parameters: { type: 'object', properties: { name: { type: 'string' } }, additionalProperties: false },
  async run(ctx, args) {
    const id = ctx.newId();
    const wanted = typeof args.name === 'string' ? args.name.trim() : '';
    ctx.store.edit((b) => {
      const made = addWorkflow(b, ctx.commands.newWorkflowAt(), id);
      return wanted === '' ? made : setWorkflowField(made, id, 'name', wanted);
    });
    const name = ctx.store.state().workflows[id]?.name;
    if (!name) return fail('the board refused the new workflow (it is saving)', 'new workflow failed');
    ctx.output.log(`${name} created — it is saved only when you press Save`, 'ok');
    ctx.commands.focus(id);
    return done(true, `made workflow ${name} (id ${id}); it is not saved yet`, `new workflow ${name}`);
  },
};

const save: ToolDef = {
  name: 'save',
  description: "Save the whole board in one go, all or nothing: every unsaved change of every workflow, step, cache, payload and processor goes to BaseAPI as drawn (free style: cycles, schema edges and payloads are checked only at Start). Deleted items (ghosts) are deleted then. BaseAPI may refuse a row (a missing field, a duplicate name, a row changed elsewhere): then nothing is kept. The user is asked first.",
  parameters: NO_ARGS,
  async run(ctx, _args, answer) {
    const base = ctx.store.base();
    const n = boardChanges(base, ctx.store.state()).length;
    if (n === 0) return done(true, 'nothing to save: the board has no unsaved changes', 'save: nothing to save');
    if (answer === undefined) return { kind: 'ask', question: { text: `Save the board: ${n} change${n === 1 ? '' : 's'}?`, choices: ['Save', 'Cancel'] } };
    if (answer !== 'Save') return fail('the user declined', 'user declined: save');
    const before = ctx.output.lines().at(-1);
    const present = ctx.store.state();
    let made: Readonly<Record<string, string>> = {};
    let affected: readonly string[] = [];
    const r = await saveBoard(ctx.api, ctx.store, ctx.output, ctx.ghosts, (m, a) => { made = m; affected = a; });
    const lines = linesSince(ctx, before);
    const entries = lines.map((l) => ({ kind: 'output' as const, text: l.text, level: l.level, name: 'board' }));
    const said = textOf(lines, r);
    if (r === 'saved') {
      // the created rows have BaseAPI's ids now: every id read before the save that is in this map is gone
      const after = ctx.store.state();
      const ids = Object.entries(made).map(([client, id]) => {
        const name = present.workflows[client]?.name ?? present.steps[client]?.name ?? present.caches[client]?.name ?? present.assignments[client]?.name;
        return `${name ?? client}: ${client} -> ${id}`;
      });
      const wfs = affected.map((id) => `${after.workflows[id]?.name ?? id} (id ${id})`);
      return done(true, `saved. ${said}`
        + `${ids.length ? ` New ids (client id -> BaseAPI id): ${ids.join('; ')}.` : ''}${wfs.length ? ` Affected workflows: ${wfs.join(', ')}.` : ''}`, 'saved the board', entries);
    }
    return fail(`the board was not saved (${r}): ${said}`, 'save failed', entries);
  },
};

async function press(ctx: ToolContext, id: string, name: string, op: RunOp): Promise<ToolOutcome> {
  ctx.commands.focus(id);
  const { value, lines, entries } = await withOutput(ctx, name, () => runWorkflow(ctx.api, ctx.store, ctx.output, ctx.live, id, op));
  if (value === 'requested') {
    return done(true, `${op} of ${name} requested and accepted; not confirmed yet: read list_workflows for ${op === 'start' ? 'Running' : 'Stopped'}. ${textOf(lines)}`, `${op} ${name}`, entries);
  }
  return fail(`${op} of ${name} did not go through: ${textOf(lines, value)}`, `${op} ${name} failed`, entries);
}

const start: ToolDef = {
  name: 'start',
  description: "Start the saved workflow in BaseAPI (what its Start button does). It runs the saved version: unsaved changes do not block it and are not run. A workflow never saved is refused (save it first). Not undoable. The user is asked first. Answers BaseAPI's refusal reason, or that the start was accepted.",
  parameters: ARG,
  async run(ctx, args, answer, pin) {
    const t = target(ctx, args, 'start', answer === undefined ? undefined : pin);
    if ('out' in t) return t.out;
    // a never-saved workflow cannot be started [user, 2026-11-23 rev 2]
    if (!ctx.store.base().workflows[t.id]) return fail(`${t.name} was never saved: save it first`, `start ${t.name} refused`);
    if (answer === undefined) return { kind: 'ask', question: { text: `Start ${t.name}?`, choices: ['Start', 'Cancel'], pin: t.id } };
    if (answer !== 'Start') return fail('the user declined', `user declined: start ${t.name}`);
    return press(ctx, t.id, t.name, 'start');
  },
};

const stop: ToolDef = {
  name: 'stop',
  description: 'Stop the workflow in BaseAPI (what its Stop button does). Not undoable. The user is asked first.',
  parameters: ARG,
  async run(ctx, args, answer, pin) {
    const t = target(ctx, args, 'stop', answer === undefined ? undefined : pin);
    if ('out' in t) return t.out;
    if (answer === undefined) return { kind: 'ask', question: { text: `Stop ${t.name}?`, choices: ['Stop', 'Cancel'], pin: t.id } };
    if (answer !== 'Stop') return fail('the user declined', `user declined: stop ${t.name}`);
    return press(ctx, t.id, t.name, 'stop');
  },
};

const deleteWorkflow: ToolDef = {
  name: 'delete_workflow',
  description: 'Delete the workflow from the board: it becomes a ghost until Save pushes the delete (with the payloads no other workflow uses); its steps and caches stay, and Undo or Restore brings it back. Refused while it runs (or while its run state is not known). The user is asked first.',
  parameters: ARG,
  async run(ctx, args, answer, pin) {
    const t = target(ctx, args, 'delete workflow', answer === undefined ? undefined : pin);
    if ('out' in t) return t.out;
    // a running workflow is never ghosted [user, 2026-11-23]: refused before the question and again on the answer
    const refused = deleteRefusal([{ kind: 'workflow', id: t.id }], ctx.store.state(), ctx.store.base(), (wf) => statusOf(ctx.live.getState(), wf));
    if (refused.length) {
      for (const line of refused) ctx.output.log(line, 'warn');
      return fail(refused.join('; '), `delete ${t.name} refused`);
    }
    if (answer === undefined) return { kind: 'ask', question: { text: `Delete ${t.name}? It is a ghost until Save; its steps and caches stay.`, choices: ['Delete', 'Cancel'], pin: t.id } };
    if (answer !== 'Delete') return fail('the user declined', `user declined: delete ${t.name}`);
    return applyState(ctx, (b) => deletePicks(b, [{ kind: 'workflow', id: t.id }]), `delete ${t.name}`, `deleted ${t.name}: a ghost until Save (Undo brings it back)`);
  },
};

const takeStoredTool: ToolDef = {
  name: 'take_stored',
  description: "After a Save refused rows as changed elsewhere (or gone), take the stored version (BaseAPI's) of exactly those rows (what the Take stored button does): your unsaved changes to them are dropped, as one undoable edit; the rest of the unsaved board stays. The user is asked first.",
  parameters: NO_ARGS,
  async run(ctx, _args, answer) {
    const rows = ctx.store.stale();
    if (rows.length === 0) return fail('nothing to take: no row was refused as changed elsewhere by the last Save', 'take stored');
    const names = rows.map((r) => nameOf([ctx.store.state(), ctx.store.base()], r.table, r.id));
    if (answer === undefined) {
      return { kind: 'ask', question: { text: `Take the stored ${names.join(', ')}? Your changes to ${rows.length === 1 ? 'it' : 'them'} are dropped.`, choices: ['Take stored', 'Cancel'] } };
    }
    if (answer !== 'Take stored') return fail('the user declined', 'user declined: take stored');
    const before = ctx.output.lines().at(-1);
    await takeStored(ctx.api, ctx.store, ctx.output);
    const lines = linesSince(ctx, before);
    const entries = lines.map((l) => ({ kind: 'output' as const, text: l.text, level: l.level, name: 'board' }));
    const ok = ctx.store.stale().length === 0;
    return ok ? done(true, textOf(lines, 'took the stored rows'), 'took stored', entries) : fail(textOf(lines, 'the stored rows could not be taken'), 'take stored failed', entries);
  },
};

/** What a Start would refuse, asked of BaseAPI without starting (Save checks only the design rules) [user, 2026-11-23 rev 2]. */
const checkWorkflow: ToolDef = {
  name: 'check_workflow',
  description: "Ask BaseAPI what a Start of the saved workflow would refuse — cycles, missing steps, schema-edge mismatches, payloads off their config schema, missing required payloads, processor liveness — without starting it. It checks the saved version: save first to check unsaved changes. Answers every problem, or that there is none.",
  parameters: ARG,
  async run(ctx, args) {
    const t = target(ctx, args, 'check workflow');
    if ('out' in t) return t.out;
    if (!ctx.store.base().workflows[t.id]) return fail(`${t.name} was never saved: save it first`, `check ${t.name} refused`);
    const r = await ctx.api.validateWorkflow(t.id);
    if (!r.ok) return fail(`could not check ${t.name}: ${describeError(r.error)}`, `check ${t.name} failed`);
    const problems = r.value.problems ?? [];
    return done(true, problems.length === 0
      ? `${t.name}: nothing a Start would refuse`
      : `${t.name}: ${problems.length} problem${problems.length === 1 ? '' : 's'} a Start would refuse: ${problems.map((p) => `${p.title ?? p.gate} — ${p.detail ?? ''}`).join('; ')}`, `checked ${t.name}`);
  },
};

export const WORKFLOW_TOOLS: ToolDef[] = [newWorkflow, save, start, stop, deleteWorkflow, takeStoredTool, checkWorkflow];
