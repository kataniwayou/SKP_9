import { confirmText } from '../../board/Toolbar';
import { boardChanges } from '../../design/changes';
import { addWorkflow, setWorkflowField } from '../../design/edits';
import { saveBoard } from '../../design/saveBoard';
import { commitDelete, prepareDelete } from '../../operate/deleteWorkflow';
import { runWorkflow, type RunOp } from '../../operate/runWorkflow';
import type { ToolContext, ToolDef, ToolOutcome } from '../toolTypes';
import { done, fail, linesSince, NO_ARGS, target, textOf, withOutput, WORKFLOW_ID } from './common';

/**
 * A delete question's pin: the workflow and the confirm text it was asked with (JSON), what an answer is checked
 * against. It is stored with the question, so it outlives a refresh. A bare id (a chat stored before) has no text: asked again.
 */
function deletePin(pin: string | undefined): { w: string; text: string | null } | undefined {
  if (pin === undefined) return undefined;
  try {
    const v: unknown = JSON.parse(pin);
    if (typeof v === 'object' && v !== null && typeof (v as { w?: unknown }).w === 'string') {
      const { w, text } = v as { w: string; text?: unknown };
      return { w, text: typeof text === 'string' ? text : null };
    }
  } catch { /* not JSON: a bare workflow id */ }
  return { w: pin, text: null };
}

const ARG = { type: 'object', properties: { workflow_id: WORKFLOW_ID }, required: ['workflow_id'], additionalProperties: false };

const newWorkflow: ToolDef = {
  name: 'new_workflow',
  description: 'Make a new triangle on free board, named `name` or new-workflow-N (version 1.0.0, no cron, no entry arrows). It exists only on the board until the board is saved. Answers its id.',
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
  description: "Save the whole board in one go (all or nothing): every unsaved change of every workflow, step, cache, payload and processor goes to BaseAPI; then the dry run reports each affected workflow's problems in Output. The report never blocks or undoes the save. The user is asked first.",
  parameters: NO_ARGS,
  async run(ctx, _args, answer) {
    const base = ctx.store.base();
    const n = boardChanges(base, ctx.store.state()).length;
    if (n === 0) return done(true, 'nothing to save: the board has no unsaved changes', 'save: nothing to save');
    if (answer === undefined) return { kind: 'ask', question: { text: `Save the board: ${n} change${n === 1 ? '' : 's'}?`, choices: ['Save', 'Cancel'] } };
    if (answer !== 'Save') return fail('the user declined', 'user declined: save');
    const before = ctx.output.lines().at(-1);
    const r = await saveBoard(ctx.api, ctx.store, ctx.output);
    const lines = linesSince(ctx, before);
    const entries = lines.map((l) => ({ kind: 'output' as const, text: l.text, level: l.level, name: 'board' }));
    const said = textOf(lines, r);
    const problems = Object.values(ctx.store.state().workflows).flatMap((w) => (ctx.store.problems(w.id) > 0 ? [`${w.name}: ${ctx.store.problems(w.id)} problem(s)`] : []));
    if (r === 'saved') return done(true, `saved. ${said}${problems.length ? ` Dry run: ${problems.join('; ')}.` : ''}`, 'saved the board', entries);
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
  description: "Start the saved workflow in BaseAPI (what its Start button does). It runs the saved version, never unsaved changes: save first. Answers BaseAPI's refusal reason, or that the start was accepted.",
  parameters: ARG,
  async run(ctx, args) {
    const t = target(ctx, args, 'start');
    return 'out' in t ? t.out : press(ctx, t.id, t.name, 'start');
  },
};

const stop: ToolDef = {
  name: 'stop',
  description: 'Stop the workflow in BaseAPI (what its Stop button does). The user is asked first.',
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
  description: 'Delete the workflow (BaseAPI deletes it with the payloads no other workflow uses; its steps and caches stay; a never-saved one is discarded). The user is asked first. Refused while it runs or the board saves.',
  parameters: ARG,
  async run(ctx, args, answer, pin) {
    const pinned = answer === undefined ? undefined : deletePin(pin);
    const t = target(ctx, args, 'delete workflow', pinned?.w);
    if ('out' in t) return t.out;
    if (answer !== undefined && answer !== 'Delete') return fail('the user declined', `user declined: delete ${t.name}`);
    const prepared = await withOutput(ctx, t.name, () => prepareDelete(ctx.api, ctx.store, ctx.output, t.id));
    const plan = prepared.value;
    if (plan === null) return fail(`${t.name} was not deleted: ${textOf(prepared.lines, 'refused')}`, `delete ${t.name} refused`, prepared.entries);
    const text = confirmText(plan);
    // what the user confirmed is what is deleted: a plan that changed since the question is asked again
    if (answer === undefined || pinned?.text !== text) {
      return { kind: 'ask', question: { text, choices: ['Delete', 'Cancel'], pin: JSON.stringify({ w: t.id, text }) } };
    }
    const ran = await withOutput(ctx, t.name, () => commitDelete(ctx.api, ctx.store, ctx.output, plan));
    if (ran.value) return done(true, `deleted ${t.name}. ${textOf(ran.lines)}`, `deleted ${t.name}`, ran.entries);
    return fail(`${t.name} was not deleted: ${textOf(ran.lines, 'refused')}`, `delete ${t.name} failed`, ran.entries);
  },
};

export const WORKFLOW_TOOLS: ToolDef[] = [newWorkflow, save, start, stop, deleteWorkflow];
