import { cancelDelete, deleteWarningLines, type DeletePlan } from '../../app/deleteWorkflow';
import type { Id } from '../../model/graph';
import { RUN_TIMEOUT_MS, runBlocked, type RunOp } from '../../store/run';
import { designDirty, saveBlocked, type OpenDocument } from '../../store/studioState';
import type { ChatEntry } from '../chatStore';
import { echoText, hasErrorLine, withEcho } from '../echo';
import type { ToolContext, ToolDef, ToolOutcome } from '../toolTypes';
import { workflowOf } from './read';

// The workflow tools (2026-10-23): the same paths as the menus and the toolbar, with their Output lines repeated in
// the chat and handed to the model. The ones that cannot be undone (stop, delete, close with a draft) ask first.

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
const labelOf = (d: { name: string; version: string }): string => `${d.name} ${d.version}`.trim();
const docOf = (ctx: ToolContext, id: Id): OpenDocument | undefined => ctx.store.getState().docs.find((d) => d.workflowId === id);

/** What the model hears is `head`, then the echoed Output lines and problems; the chat shows `action` and the same lines. */
function done(ok: boolean, head: string, action: string, entries: ChatEntry[] = []): ToolOutcome {
  const echo = echoText(entries);
  return { kind: 'done', ok, result: echo === '' ? head : `${head}\n${echo}`, action, entries };
}
const fail = (error: string, action: string): ToolOutcome => done(false, error, action);

const WORKFLOW_ARG = {
  type: 'string',
  description: 'The workflow: its id, name, or "name version". Leave out for the workflow the user has open (the active one).',
};
const WORKFLOW_REQUIRED = { ...WORKFLOW_ARG, description: 'The workflow: its id, name, or "name version".' };
const YES_NO = ['Yes', 'No'] as const;

/** An open workflow the tool means: the one named, else the active one; or why there is none. */
async function openDocOf(ctx: ToolContext, ref: string | undefined, action: string): Promise<{ doc: OpenDocument } | { out: ToolOutcome }> {
  const w = await workflowOf(ctx, ref);
  if (!w.ok) return { out: fail(w.error, action) };
  if (w.value.doc === null) return { out: fail(`workflow ${ref} is not open; open it first`, action) };
  return { doc: w.value.doc };
}

/** A Save, echoed; applied only when Output says "Saved and applied". */
async function saveEchoed(ctx: ToolContext, doc: OpenDocument): Promise<{ applied: boolean; entries: ChatEntry[]; blocked: string | null }> {
  const blocked = saveBlocked(doc);
  if (blocked !== null) return { applied: false, entries: [], blocked };
  const { entries } = await withEcho(ctx.store, () => [doc.workflowId], () => ctx.commands.save(doc.workflowId));
  const applied = entries.some((e) => e.kind === 'output' && e.text.startsWith('Saved and applied'));
  return { applied, entries, blocked: null };
}

const openWorkflow: ToolDef = {
  name: 'open_workflow',
  description: 'Open a workflow in the studio and make it the active one.',
  parameters: { type: 'object', properties: { workflow: WORKFLOW_REQUIRED }, required: ['workflow'], additionalProperties: false },
  async run(ctx, args) {
    const w = await workflowOf(ctx, text(args.workflow));
    if (!w.ok) return fail(w.error, 'open workflow');
    const id = w.value.id;
    const { value, entries } = await withEcho(ctx.store, () => [id], () => ctx.commands.open(id));
    const doc = docOf(ctx, id);
    if (value !== 'ready' || !doc) return done(false, `could not open the workflow: ${value}`, `open workflow ${text(args.workflow)} failed`, entries);
    return done(true, `opened ${labelOf(doc)}; it is the active workflow now`, `opened ${labelOf(doc)}`, entries);
  },
};

const newWorkflow: ToolDef = {
  name: 'new_workflow',
  description: 'Make a new, blank workflow (named "untitled" until renamed). It exists only in the studio until it is saved.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async run(ctx) {
    const { value: id, entries } = await withEcho(ctx.store, () => [], () => ctx.commands.newWorkflow());
    const doc = docOf(ctx, id);
    const label = doc ? labelOf(doc) : id;
    return done(true, `made a new workflow ${label} (id ${id}); it is the active workflow now and not saved yet`, `new workflow ${label}`, entries);
  },
};

const activate: ToolDef = {
  name: 'activate',
  description: 'Make an already open workflow the active one (the one tools use when no workflow is named).',
  parameters: { type: 'object', properties: { workflow: WORKFLOW_REQUIRED }, required: ['workflow'], additionalProperties: false },
  async run(ctx, args) {
    const found = await openDocOf(ctx, text(args.workflow), 'activate');
    if ('out' in found) return found.out;
    ctx.commands.activate(found.doc.workflowId);
    return done(true, `${labelOf(found.doc)} is the active workflow now`, `activated ${labelOf(found.doc)}`);
  },
};

const save: ToolDef = {
  name: 'save',
  description: 'Save the workflow (what the Save button does): sends the design to BaseApi. Answers what BaseApi applied or the errors it found.',
  parameters: { type: 'object', properties: { workflow: WORKFLOW_ARG }, additionalProperties: false },
  async run(ctx, args) {
    const found = await openDocOf(ctx, text(args.workflow), 'save');
    if ('out' in found) return found.out;
    const { applied, entries, blocked } = await saveEchoed(ctx, found.doc);
    const label = labelOf(docOf(ctx, found.doc.workflowId) ?? found.doc);
    if (blocked !== null) return fail(`not saved: ${blocked}`, `not saved ${label}`);
    return applied ? done(true, `saved ${label}`, `saved ${label}`, entries) : done(false, `not saved ${label}`, `save failed: ${label}`, entries);
  },
};

/**
 * Start and Stop: the press is over when the live set agreed (its line is in Output) or the timeout line is. The echo
 * waits a little longer than the press's own timeout so that the timeout line is in it.
 */
async function press(ctx: ToolContext, doc: OpenDocument, op: RunOp): Promise<ToolOutcome> {
  const id = doc.workflowId;
  const blocked = runBlocked(doc);
  if (blocked !== null) return fail(`cannot ${op} ${doc.name}: ${blocked}`, `${op} ${doc.name} refused`);
  const { entries } = await withEcho(ctx.store, () => [id], () => ctx.commands.run(id, op), () => (docOf(ctx, id)?.run ?? null) === null, RUN_TIMEOUT_MS + 2000);
  const past = op === 'start' ? 'started' : 'stopped';
  return hasErrorLine(entries)
    ? done(false, `${op} of ${doc.name} did not complete`, `${op} ${doc.name} failed`, entries)
    : done(true, `${past} ${doc.name}`, `${past} ${doc.name}`, entries);
}

const start: ToolDef = {
  name: 'start',
  description: 'Start the workflow in BaseApi (what the Start button does). Answers once it is running or why it is not. Starting does not include unsaved design changes: save first.',
  parameters: { type: 'object', properties: { workflow: WORKFLOW_ARG }, additionalProperties: false },
  async run(ctx, args) {
    const found = await openDocOf(ctx, text(args.workflow), 'start');
    return 'out' in found ? found.out : press(ctx, found.doc, 'start');
  },
};

const stop: ToolDef = {
  name: 'stop',
  description: 'Stop the workflow in BaseApi (what the Stop button does). The user is asked first.',
  parameters: { type: 'object', properties: { workflow: WORKFLOW_ARG }, additionalProperties: false },
  async run(ctx, args, answer) {
    const found = await openDocOf(ctx, text(args.workflow), 'stop');
    if ('out' in found) return found.out;
    if (answer === undefined) return { kind: 'ask', question: { text: `Stop ${labelOf(found.doc)}?`, choices: YES_NO } };
    if (answer !== 'Yes') return fail('the user declined', `user declined: stop ${found.doc.name}`);
    return press(ctx, found.doc, 'stop');
  },
};

/** A deletion prepared and waiting for the user's answer: the plan, and the Output lines its preparation wrote. */
const pendingDeletes = new Map<Id, { plan: DeletePlan; entries: ChatEntry[] }>();

const deleteWorkflow: ToolDef = {
  name: 'delete_workflow',
  description: 'Delete a workflow for good (it must be open and not running). The user is shown what goes and asked first.',
  parameters: { type: 'object', properties: { workflow: WORKFLOW_REQUIRED }, required: ['workflow'], additionalProperties: false },
  async run(ctx, args, answer) {
    const found = await openDocOf(ctx, text(args.workflow), 'delete workflow');
    if ('out' in found) return found.out;
    const { doc } = found;
    const id = doc.workflowId;
    const label = labelOf(doc);
    // after the answer the plan made for the question is used; one lost meanwhile (a refresh) is made and asked again
    const pending = answer !== undefined ? pendingDeletes.get(id) : undefined;
    pendingDeletes.delete(id);
    if (!pending) {
      const { value: plan, entries } = await withEcho(ctx.store, () => [id], () => ctx.commands.prepareDelete(id));
      if (plan === null) return done(false, `not deleted ${label}`, `delete refused: ${doc.name}`, entries);
      pendingDeletes.set(id, { plan, entries });
      return { kind: 'ask', question: { text: `Delete workflow ${label} for good?`, choices: YES_NO, warnings: deleteWarningLines(plan) } };
    }
    if (answer !== 'Yes') {
      const { entries } = await withEcho(ctx.store, () => [id], async () => { cancelDelete(ctx.store, id); });
      return done(false, 'the user declined', `user declined: delete ${doc.name}`, [...pending.entries, ...entries]);
    }
    const { value: deleted, entries } = await withEcho(ctx.store, () => [id], () => ctx.commands.commitDelete(pending.plan));
    const all = [...pending.entries, ...entries];
    if (deleted) return done(true, `deleted workflow ${label}`, `deleted workflow ${label}`, all);
    // a refused deletion says why in Output; with no new error line, another deletion of it was already running
    const why = hasErrorLine(entries) ? '' : ': a deletion of this workflow is already running';
    return done(false, `not deleted ${label}${why}`, `delete failed: ${doc.name}`, all);
  },
};

const closeWorkflow: ToolDef = {
  name: 'close_workflow',
  description: 'Close an open workflow in the studio (it stays in BaseApi). When it has unsaved changes the user is asked whether to save them, discard them or cancel.',
  parameters: { type: 'object', properties: { workflow: WORKFLOW_ARG }, additionalProperties: false },
  async run(ctx, args, answer) {
    const found = await openDocOf(ctx, text(args.workflow), 'close workflow');
    if ('out' in found) return found.out;
    const { doc } = found;
    const id = doc.workflowId;
    const label = labelOf(doc);
    const close = async (before: ChatEntry[]): Promise<ToolOutcome> => {
      const { entries } = await withEcho(ctx.store, () => [id], async () => { ctx.commands.close(id); });
      const all = [...before, ...entries];
      return docOf(ctx, id) ? done(false, `${label} was not closed`, `close refused: ${doc.name}`, all) : done(true, `closed ${label}`, `closed ${label}`, all);
    };
    if (!designDirty(doc)) return close([]);
    if (answer === undefined) return { kind: 'ask', question: { text: `${label} has unsaved changes. Save them before closing?`, choices: ['Save', 'Discard', 'Cancel'] } };
    if (answer === 'Discard') return close([]);
    if (answer !== 'Save') return fail('the user cancelled', `user cancelled: close ${doc.name}`);
    const { applied, entries, blocked } = await saveEchoed(ctx, doc);
    if (blocked !== null) return done(false, `not closed: the save did not happen (${blocked})`, `close refused: ${doc.name}`);
    if (!applied) return done(false, `not closed: ${label} was not saved, so its changes are kept`, `save failed: ${label}`, entries);
    return close(entries);
  },
};

export const WORKFLOW_TOOLS: ToolDef[] = [openWorkflow, newWorkflow, activate, save, start, stop, deleteWorkflow, closeWorkflow];
