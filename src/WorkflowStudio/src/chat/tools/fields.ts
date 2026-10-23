import { applyBlocks } from '../../design/blocks';
import { fieldsOf, hasEdit, valueText } from '../../design/design';
import { cronText } from '../../model/cronText';
import { CONDITIONS, conditionInfo } from '../../model/entryConditions';
import type { Id } from '../../model/graph';
import { dictText, parseDict } from '../../store/dict';
import { FIELDS, fieldValue, jsonProblem, savedText, type FieldSpec } from '../../store/entityForms';
import { editBaseOf } from '../../store/inspectorBase';
import { editTargetOf, targetKey, type InspectorTarget } from '../../store/inspectorTarget';
import type { Selection } from '../../store/selection';
import { shownTargetOf, type OpenDocument } from '../../store/studioState';
import { findStep, type Found } from '../resolve';
import type { ToolContext, ToolDef, ToolOutcome } from '../toolTypes';
import { act, askedDocOf, designDocOf, docOf, done, fail, layersOf, text, WORKFLOW_ARG, YES_NO } from './design';
import { inspectorTargetOf, TARGET_ARG, targetOf, type Target } from './read';

// The field tools (2026-10-23): the Inspector's own edits. Each first shows its entity in the Inspector, as the user's
// clicks would (select, then the drill-downs), waits for the Inspector's read of it, and then edits what the Inspector
// shows, so the user sees the field change. Field edits have no Undo, as in the Inspector: Revert entity undoes them.

/** How long a field tool waits for the Inspector's read of the entity it shows. */
export const INSPECTOR_READ_MS = 10_000;

/** The entity a target names, in words: "step fetch", "fetch's assignment", "fetch's processor's config schema". */
function entityText(doc: OpenDocument, target: InspectorTarget): string {
  const { saved } = layersOf(doc);
  const g = saved.graph;
  const step = (id: Id) => g.steps.get(id)?.name ?? id;
  const stepOfProcessor = (pid: Id) => [...g.steps.values()].find((s) => s.processorId === pid)?.name;
  switch (target.kind) {
    case 'workflow': return `workflow ${g.workflow.name}`;
    case 'step': return `step ${step(target.id)}`;
    case 'cache': { const c = g.caches.get(target.id); return `cache ${c ? `${c.name} ${c.version}` : target.id}`; }
    case 'assignment': return `${step(target.stepId)}'s assignment`;
    case 'processor': { const p = g.processors.get(target.id); return `processor ${p ? `${p.name} ${p.version}` : target.id}`; }
    case 'schema': { const p = g.processors.get(target.processorId); return `${p ? `${p.name} ${p.version}` : 'the processor'}'s ${target.slot} schema${stepOfProcessor(target.processorId) ? ` (step ${stepOfProcessor(target.processorId)})` : ''}`; }
  }
}

/** The clicks that show `target`: the canvas selection, then the Inspector's drill-downs from it. */
function pathOf(doc: OpenDocument, t: Target, target: InspectorTarget): { selection: Selection; trail: InspectorTarget[] } {
  if (target.kind === 'workflow') return { selection: { kind: 'workflow' }, trail: [] };
  if (target.kind === 'cache') return { selection: { kind: 'cache', cacheId: target.id }, trail: [] };
  const stepId = target.kind === 'step' ? target.id : target.kind === 'assignment' ? target.stepId : (findStep(doc, 'step' in t ? t.step : '') as { value: Id }).value;
  const selection: Selection = { kind: 'step', stepId };
  if (target.kind === 'step') return { selection, trail: [] };
  if (target.kind === 'assignment') return { selection, trail: [target] };
  const processor: InspectorTarget = { kind: 'processor', id: target.kind === 'processor' ? target.id : target.processorId };
  return { selection, trail: target.kind === 'processor' ? [processor] : [processor, target] };
}

/** The base the Inspector judges an edit against now, or null while it waits for its read. */
function editBaseNow(doc: OpenDocument, target: InspectorTarget) {
  if (doc.status.kind !== 'ready') return null;
  const graph = applyBlocks(doc.status.doc, doc.design.draft.blocks).graph;
  return editBaseOf(graph, target, doc.inspector.saved, targetKey(target), doc.generation);
}

/** Resolves when `ready` holds, or after `ms`. */
function until(ctx: ToolContext, ready: () => boolean, ms: number): Promise<void> {
  if (ready()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let stop = (): void => {};
    const timer = setTimeout(() => { stop(); resolve(); }, ms);
    stop = ctx.store.subscribe(() => { if (ready()) { clearTimeout(timer); stop(); resolve(); } });
  });
}

/**
 * Shows `target` in the Inspector of its workflow, made the active one (the Inspector follows the model): the canvas
 * selection and the drill-downs, as the user's clicks; nothing when it is shown already. Then waits for the Inspector's
 * read of it. Answers the document then, or why the entity cannot be edited.
 */
async function showInInspector(ctx: ToolContext, doc: OpenDocument, t: Target, target: InspectorTarget): Promise<Found<OpenDocument>> {
  const id = doc.workflowId, key = targetKey(target);
  const { store } = ctx;
  store.dispatch({ type: 'activate', workflowId: id });
  if (store.getState().toolboxPick !== null) store.dispatch({ type: 'toolboxPick', pick: null });
  if (targetKey(shownTargetOf(doc)) !== key) {
    const { selection, trail } = pathOf(doc, t, target);
    store.dispatch({ type: 'select', workflowId: id, selection });
    store.dispatch({ type: 'back', workflowId: id, depth: 0 });
    for (const next of trail) store.dispatch({ type: 'drill', workflowId: id, target: next });
  }
  ctx.service.read(id);
  const shown = () => docOf(ctx, id) ?? null;
  const landed = () => {
    const d = shown();
    return d === null || targetKey(shownTargetOf(d)) !== key || d.inspector.saved?.key === key || d.inspector.readError !== null;
  };
  await until(ctx, landed, INSPECTOR_READ_MS);
  const d = shown();
  if (d === null) return { ok: false, error: 'the workflow closed meanwhile; nothing was done' };
  if (targetKey(shownTargetOf(d)) !== key) return { ok: false, error: 'the Inspector was moved to another entity meanwhile; nothing was done: try again' };
  if (editBaseNow(d, target) === null) return { ok: false, error: d.inspector.readError ?? `the Inspector could not read it in ${INSPECTOR_READ_MS / 1000} s; nothing was done` };
  return { ok: true, value: d };
}

/** The workflow (loaded, not locked), the parsed target and the Inspector's target for it; or the outcome saying why not. */
async function targetIn(ctx: ToolContext, args: Record<string, unknown>, tool: string): Promise<{ doc: OpenDocument; t: Target; target: InspectorTarget } | { out: ToolOutcome }> {
  const t = targetOf(args.target);
  if (!t.ok) return { out: fail(t.error, tool) };
  const found = await designDocOf(ctx, text(args.workflow), tool);
  if ('out' in found) return found;
  const { doc } = found;
  // the Inspector's layers, as read_entity finds its target: the design as edited, a slot's schema from the base
  const { base, saved } = layersOf(doc);
  const target = await inspectorTargetOf(ctx, doc, t.value, saved.graph, applyBlocks(base, doc.design.draft.blocks).graph);
  if (!target.ok) return { out: fail(target.error, tool) };
  // the lookup may have waited for BaseApi's cache list: the document as it is now
  const now = docOf(ctx, doc.workflowId);
  return now ? { doc: now, t: t.value, target: target.value } : { out: fail('the workflow closed meanwhile', tool) };
}

/**
 * The text the Inspector's field would hold for `value`, or the Inspector's own message about it (2026-10-23: what its
 * field marks red is refused here, nothing typed). An entry condition by name or number; a JSON field and a cache's
 * items as text or as the value itself.
 */
function fieldText(spec: FieldSpec, value: unknown): Found<string> {
  if (value === null || value === undefined) {
    return spec.nullable ? { ok: true, value: '' } : { ok: false, error: `${spec.label} cannot be blank` };
  }
  if (spec.kind === 'condition') {
    const c = CONDITIONS.find((x) => String(x.value) === String(value).trim() || x.name.toLowerCase() === String(value).trim().toLowerCase());
    return c ? { ok: true, value: String(c.value) } : { ok: false, error: `the entry condition must be one of ${CONDITIONS.map((x) => x.name).join(', ')}` };
  }
  const raw = typeof value === 'string' ? value : (spec.kind === 'json' || spec.kind === 'dict') ? JSON.stringify(value) : String(value);
  if (spec.kind === 'json') {
    const problem = jsonProblem(raw);
    return problem === null ? { ok: true, value: raw } : { ok: false, error: problem };
  }
  if (spec.kind === 'dict') {
    const d = parseDict(raw);
    return d.ok ? { ok: true, value: dictText(d.entries) } : { ok: false, error: d.reason };
  }
  if (spec.kind === 'cron') {
    const c = cronText(raw);
    return 'problem' in c ? { ok: false, error: c.problem } : { ok: true, value: raw };
  }
  if (spec.required && raw.trim() === '') return { ok: false, error: `${spec.label} cannot be blank` };
  return { ok: true, value: raw };
}

/** What the Inspector's field shows now: the design's edit, else the base value. */
function shownField(doc: OpenDocument, target: InspectorTarget, key: string): string | null {
  const base = editBaseNow(doc, target);
  if (base === null) return null;
  const edits = fieldsOf(doc.edits, editTargetOf(target));
  return Object.hasOwn(edits, key) ? valueText(edits[key]) : savedText(base, key);
}

const readable = (spec: FieldSpec, v: string): string => (spec.kind === 'condition' ? conditionInfo(Number(v)).name : v);
/** A value short enough for the chat's one action line. */
const inLine = (v: string): string | null => (v.length <= 40 && !v.includes('\n') ? v : null);

const setField: ToolDef = {
  name: 'set_field',
  description: `Set one field of an entity, as typed into the Inspector (the Inspector shows the entity while it is edited). Fields by target kind: ${Object.entries(FIELDS).map(([k, f]) => `${k}: ${f.map((x) => x.key).join(', ')}`).join('; ')}. entryCondition takes a name (Completed, Failed, Cancelled, Always, Never); payload and definition JSON text; items a JSON object of strings. Answers the field as the Inspector shows it after, or the Inspector's message.`,
  parameters: {
    type: 'object',
    properties: {
      workflow: WORKFLOW_ARG,
      target: { ...TARGET_ARG, description: `The entity. ${TARGET_ARG.description}` },
      field: { type: 'string', description: 'The field key, as listed above.' },
      value: { description: 'The new value: text (a number or a name for entryCondition; blank or null clears an optional field).' },
    },
    required: ['target', 'field', 'value'],
    additionalProperties: false,
  },
  async run(ctx, args) {
    const found = await targetIn(ctx, args, 'set field');
    if ('out' in found) return found.out;
    const { t, target } = found;
    const field = text(args.field) ?? '';
    const spec = FIELDS[target.kind].find((f) => f.key === field);
    if (!spec) return fail(`a ${target.kind} has no field ${field}; its fields are ${FIELDS[target.kind].map((f) => f.key).join(', ')}`, 'set field');
    const what = `${spec.label.toLowerCase()} of ${entityText(found.doc, target)}`;
    const value = fieldText(spec, args.value);
    if (!value.ok) return fail(`not set, nothing was changed: the Inspector says "${value.error}" for the ${what}`, `${what} not set: ${value.error}`);
    const shown = await showInInspector(ctx, found.doc, t, target);
    if (!shown.ok) return fail(shown.error, `${what} not set`);
    const id = found.doc.workflowId;
    // judged as the Inspector's edit would land: an entry condition that makes a net disagree is refused
    const r = await act(ctx, id, { type: 'editField', workflowId: id, key: spec.key, value: fieldValue(spec, value.value), copyId: ctx.newId() }, {
      run: () => ctx.service.edit(id, spec, value.value),
    });
    if (!r.ok) return fail(r.error, `${what} not set`);
    const now = shownField(r.after, target, spec.key);
    const wanted = fieldValue(spec, value.value);
    if (now === null || (spec.kind === 'condition' ? Number(now) !== wanted : now !== valueText(wanted))) {
      return done(false, `the Inspector did not take the edit: the ${what} shows ${JSON.stringify(now === null ? '' : readable(spec, now))}`, `${what} not set`, r.entries);
    }
    // the last Save's errors on this field stay under it until the next Save
    const entityId = target.kind === 'workflow' ? id : target.id;
    const errors = (r.after.errors ?? []).filter((e) => e.id === entityId && e.field === spec.key).map((e) => e.message);
    const note = errors.length > 0 ? `; the last Save's error on this field (until the next Save): ${errors.join('; ')}` : '';
    const shownValue = readable(spec, now);
    const short = inLine(shownValue);
    return done(true, `${what} is ${JSON.stringify(shownValue)} now (unsaved)${note}`, `${what} set${short !== null && short !== '' ? ` to ${short}` : ''}`, r.entries);
  },
};

/** The step a create or remove names, with its current assignment (as the Inspector shows the step's). */
function stepIn(doc: OpenDocument, ref: string): Found<{ stepId: Id; name: string; assignment: { id: Id } | undefined }> {
  const s = findStep(doc, ref);
  if (!s.ok) return s;
  const { saved } = layersOf(doc);
  const step = saved.graph.steps.get(s.value)!;
  return { ok: true, value: { stepId: step.id, name: step.name, assignment: saved.graph.assignments.find((a) => a.stepId === step.id) } };
}

const STEP_ARG = { type: 'string', description: 'The step: name or id.' };

const createAssignmentTool: ToolDef = {
  name: 'create_assignment',
  description: 'Create a step\'s assignment (the Inspector\'s ＋ Create): named {step}-assignment, version 1.0.0, payload {}; set its payload with set_field (target assignment, field payload).',
  parameters: { type: 'object', properties: { workflow: WORKFLOW_ARG, step: STEP_ARG }, required: ['step'], additionalProperties: false },
  async run(ctx, args) {
    const found = await designDocOf(ctx, text(args.workflow), 'create assignment');
    if ('out' in found) return found.out;
    const s = stepIn(found.doc, text(args.step) ?? '');
    if (!s.ok) return fail(s.error, 'create assignment');
    const { stepId, name, assignment } = s.value;
    if (assignment) return fail(`step ${name} already has an assignment (id ${assignment.id})`, `create assignment of ${name} refused`);
    const t: Target = { kind: 'step', step: stepId };
    const shown = await showInInspector(ctx, found.doc, t, { kind: 'step', id: stepId });
    if (!shown.ok) return fail(shown.error, `create assignment of ${name}`);
    const id = found.doc.workflowId;
    const r = await act(ctx, id, { type: 'createAssignment', workflowId: id, stepId, stepName: name, id: ctx.newId() }, {
      unchanged: `the assignment of step ${name} could not be created`, run: () => ctx.service.createAssignment(id, stepId, name),
    });
    if (!r.ok) return fail(r.error, `create assignment of ${name} refused`);
    const made = stepIn(r.after, stepId);
    const op = r.after.edits.assignments[stepId];
    const label = op && op.op !== 'delete' ? `${String(op.fields.name ?? '')} ${String(op.fields.version ?? '')}`.trim() : '';
    if (!made.ok || !made.value.assignment) return done(false, `the assignment of step ${name} was not created`, `create assignment of ${name} failed`, r.entries);
    return done(true, `created assignment ${label} (id ${made.value.assignment.id}) of step ${name}, payload {}; the Inspector shows it`, `+ assignment of ${name}`, r.entries);
  },
};

const removeAssignmentTool: ToolDef = {
  name: 'remove_assignment',
  description: 'Remove a step\'s assignment from the design (deleted in BaseApi on Save). The user is asked first.',
  parameters: { type: 'object', properties: { workflow: WORKFLOW_ARG, step: STEP_ARG }, required: ['step'], additionalProperties: false },
  async run(ctx, args, answer, pin) {
    const found = await askedDocOf(ctx, 'remove_assignment', text(args.workflow), answer, pin);
    if ('out' in found) return found.out;
    const { doc } = found;
    const s = stepIn(doc, text(args.step) ?? '');
    if (!s.ok) return fail(s.error, 'remove assignment');
    const { stepId, name, assignment } = s.value;
    if (!assignment) return fail(`step ${name} has no assignment`, `remove assignment of ${name}: none`);
    if (answer === undefined) return { kind: 'ask', question: { text: `Remove the assignment of step ${name} from ${doc.name} ${doc.version}?`, choices: YES_NO, pin: doc.workflowId } };
    if (answer !== 'Yes') return fail('the user declined', `user declined: remove assignment of ${name}`);
    const shown = await showInInspector(ctx, doc, { kind: 'step', step: stepId }, { kind: 'step', id: stepId });
    if (!shown.ok) return fail(shown.error, `remove assignment of ${name}`);
    const id = doc.workflowId;
    const r = await act(ctx, id, { type: 'removeAssignment', workflowId: id, stepId }, {
      unchanged: `the assignment of step ${name} could not be removed`, run: () => ctx.service.removeAssignment(id, stepId),
    });
    if (!r.ok) return fail(r.error, `remove assignment of ${name} refused`);
    const left = stepIn(r.after, stepId);
    if (left.ok && left.value.assignment) return done(false, `the assignment of step ${name} is still there`, `remove assignment of ${name} failed`, r.entries);
    return done(true, `removed the assignment of step ${name} (unsaved; Save deletes it in BaseApi, Discard design brings it back)`, `- assignment of ${name}`, r.entries);
  },
};

const revertEntityTool: ToolDef = {
  name: 'revert_entity',
  description: 'Drop every unsaved Inspector edit of one entity (the Inspector\'s Revert), back to its saved values.',
  parameters: { type: 'object', properties: { workflow: WORKFLOW_ARG, target: { ...TARGET_ARG, description: `The entity. ${TARGET_ARG.description}` } }, required: ['target'], additionalProperties: false },
  async run(ctx, args) {
    const found = await targetIn(ctx, args, 'revert');
    if ('out' in found) return found.out;
    const { doc, t, target } = found;
    const what = entityText(doc, target);
    if (!hasEdit(doc.edits, editTargetOf(target))) return done(true, `${what} has no unsaved edits; nothing to revert`, `nothing to revert: ${what}`);
    const shown = await showInInspector(ctx, doc, t, target);
    if (!shown.ok) return fail(shown.error, `revert ${what}`);
    const id = doc.workflowId;
    const r = await act(ctx, id, { type: 'revertEntity', workflowId: id }, { unchanged: `${what} could not be reverted`, run: () => ctx.service.revert(id) });
    if (!r.ok) return fail(r.error, `revert ${what} refused`);
    return done(true, `reverted ${what} to its saved values`, `reverted ${what}`, r.entries);
  },
};

export const FIELD_TOOLS: ToolDef[] = [setField, createAssignmentTool, removeAssignmentTool, revertEntityTool];
