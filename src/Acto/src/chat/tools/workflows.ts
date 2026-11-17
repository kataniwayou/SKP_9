import { saveWorkflow } from '../../design/saveWorkflow';
import { newWorkflowState } from '../../design/state';
import { commitDelete, confirmText, prepareDelete } from '../../operate/deleteWorkflow';
import { runWorkflow, type RunOp } from '../../operate/runWorkflow';
import type { ToolContext, ToolDef, ToolOutcome } from '../toolTypes';
import { done, fail, target, textOf, withOutput, WORKFLOW_ID } from './common';

const ARG = { type: 'object', properties: { workflow_id: WORKFLOW_ID }, required: ['workflow_id'], additionalProperties: false };

const newWorkflow: ToolDef = {
  name: 'new_workflow',
  description: 'Make a new, blank workflow as a frame on free board, named `name` or new-workflow-N. It exists only on the board until it is saved. Answers its id.',
  parameters: { type: 'object', properties: { name: { type: 'string' } }, additionalProperties: false },
  async run(ctx, args) {
    let name = typeof args.name === 'string' ? args.name.trim() : '';
    if (name === '') {
      const taken = new Set(ctx.store.boards().map((b) => b.graph.workflow.name));
      let n = 1;
      while (taken.has(`new-workflow-${n}`)) n++;
      name = `new-workflow-${n}`;
    }
    const id = ctx.newId();
    ctx.store.addWorkflow(newWorkflowState(id, name, ctx.commands.newWorkflowAt()));
    ctx.output.log(`${name} created — it is saved only when you press Save`, 'ok');
    ctx.commands.focus(id);
    return done(true, `made workflow ${name} (id ${id}); it is not saved yet`, `new workflow ${name}`);
  },
};

const save: ToolDef = {
  name: 'save',
  description: 'Save one workflow (what its Save button does): the design goes to BaseAPI, which applies it or reports its errors. Answers what Output said.',
  parameters: ARG,
  async run(ctx, args) {
    const t = target(ctx, args, 'save');
    if ('out' in t) return t.out;
    ctx.commands.focus(t.id);
    const { value, lines, entries } = await withOutput(ctx, t.name, () => saveWorkflow(ctx.api, ctx.store, ctx.output, t.id));
    const e = ctx.store.entry(t.id);
    const problems = e && e.problems > 0 ? `; ${e.problems} problem${e.problems === 1 ? '' : 's'} found` : '';
    if (value === 'saved') return done(true, `saved ${t.name}${problems}. ${textOf(lines)}`, `saved ${t.name}`, entries);
    return fail(`${t.name} was not saved: ${textOf(lines, value)}`, `save ${t.name} failed`, entries);
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
  description: 'Delete the workflow (a saved one goes from BaseAPI with its steps and assignments; a never-saved one is discarded). The user is asked first. Refused while it runs or saves.',
  parameters: ARG,
  async run(ctx, args, answer, pin) {
    const t = target(ctx, args, 'delete workflow', answer === undefined ? undefined : pin);
    if ('out' in t) return t.out;
    if (answer !== undefined && answer !== 'Delete') return fail('the user declined', `user declined: delete ${t.name}`);
    const prepared = await withOutput(ctx, t.name, () => prepareDelete(ctx.api, ctx.store, ctx.output, [t.id]));
    const plan = prepared.value;
    if (plan === null) return fail(`${t.name} was not deleted: ${textOf(prepared.lines, 'refused')}`, `delete ${t.name} refused`, prepared.entries);
    if (answer === undefined) return { kind: 'ask', question: { text: confirmText(plan), choices: ['Delete', 'Cancel'], pin: t.id } };
    const ran = await withOutput(ctx, t.name, () => commitDelete(ctx.api, ctx.store, ctx.output, plan));
    if (ran.value.includes(t.id)) return done(true, `deleted ${t.name}. ${textOf(ran.lines)}`, `deleted ${t.name}`, ran.entries);
    return fail(`${t.name} was not deleted: ${textOf(ran.lines, 'refused')}`, `delete ${t.name} failed`, ran.entries);
  },
};

export const WORKFLOW_TOOLS: ToolDef[] = [newWorkflow, save, start, stop, deleteWorkflow];
