import { checkPayload } from '../../model/payloadCheck';
import { CONDITIONS } from '../../model/entryConditions';
import { removeAssignment, setCacheField, setPayload, setProcessorField, setSlotField, setStepField, setWorkflowField, SLOT_FIELD, SLOTS, type Slot, type WorkflowState } from '../../design/state';
import type { Id } from '../../model/graph';
import type { ToolContext, ToolDef, ToolOutcome } from '../toolTypes';
import { done, edit, fail, target, WORKFLOW_ID } from './common';

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

/** The keys the Inspector edits, per kind of thing. */
const KEYS: Readonly<Record<string, readonly string[]>> = {
  workflow: ['name', 'version', 'description', 'cronExpression'],
  step: ['name', 'version', 'description', 'entryCondition'],
  cache: ['name', 'version', 'description', 'root', 'items'],
  processor: ['name', 'version', 'description'],
  slot: ['name', 'version', 'description', 'definition'],
};
/** Fields the Inspector stores as null when emptied. */
const NULLABLE = new Set(['description', 'cronExpression']);

/** The config schema's definition a step's processor is checked against, as the board shows it now (a copy included). */
function configDefinition(ctx: ToolContext, wf: Id, s: WorkflowState, processorId: Id): string | null {
  const e = s.processors?.[processorId]?.slots.config;
  if (e && 'copy' in e) return e.copy.definition;
  if (e) return null;
  const base = ctx.store.processor(processorId, wf);
  const id = base?.configSchemaId;
  return id ? ctx.store.schema(id, wf)?.definition ?? null : null;
}

/** The payload check's words for the model: its problems, or why it could not be checked, or nothing. */
function checkText(ctx: ToolContext, wf: Id, s: WorkflowState, stepId: Id): string {
  const step = s.steps[stepId];
  const payload = s.assignments[stepId]?.payload;
  if (!step?.processorId || payload === undefined) return '';
  const def = configDefinition(ctx, wf, s, step.processorId);
  if (!def) return '';
  const r = checkPayload(def, payload);
  if ('unchecked' in r) return `${step.name}: ${r.unchecked}`;
  return r.problems.map((p) => `${step.name} payload: ${p}`).join('; ');
}

const setField: ToolDef = {
  name: 'set_field',
  description: "Set one field, as the Inspector does. target.kind: 'workflow' (keys name, version, description, cronExpression) · 'step' with target.id (name, version, description, entryCondition: 1 Completed, 2 Failed, 3 Cancelled, 4 Always, 5 Never) · 'cache' with target.id (name, version, description, root, items) · 'processor' with target.id (name, version, description) · 'slot' with target.id = the processor and target.slot input|output|config (name, version, description, definition; the first edit makes a copy of the schema). An empty description or cronExpression clears it.",
  parameters: {
    type: 'object',
    properties: {
      workflow_id: WORKFLOW_ID,
      target: { type: 'object', properties: { kind: { type: 'string', enum: ['workflow', 'step', 'cache', 'processor', 'slot'] }, id: { type: 'string' }, slot: { type: 'string', enum: ['input', 'output', 'config'] } }, required: ['kind'] },
      key: { type: 'string' },
      value: { type: ['string', 'number'] },
    },
    required: ['workflow_id', 'target', 'key', 'value'], additionalProperties: false,
  },
  async run(ctx, args) {
    const t = target(ctx, args, 'set field');
    if ('out' in t) return t.out;
    const tg = (args.target ?? {}) as Record<string, unknown>;
    const kind = str(tg.kind), key = str(args.key), id = str(tg.id), slot = str(tg.slot);
    const keys = KEYS[kind];
    if (!keys) return fail(`unknown target kind ${kind} (workflow, step, cache, processor or slot)`, 'set field failed');
    if (!keys.includes(key)) return fail(`${kind} has no field ${key} (it has ${keys.join(', ')})`, 'set field failed');
    const s0 = ctx.store.entry(t.id)!.history.present;
    const raw = args.value;
    let text: string | null = typeof raw === 'string' ? raw : null;
    let cond = 0;
    if (key === 'entryCondition') {
      const c = CONDITIONS.find((x) => x.value === Number(raw) || x.name.toLowerCase() === str(raw).toLowerCase());
      if (!c) return fail(`entryCondition must be one of ${CONDITIONS.map((x) => `${x.value} ${x.name}`).join(', ')}`, 'set field failed');
      cond = c.value;
    } else if (text === null) {
      if (typeof raw === 'number') text = String(raw);
      else return fail(`${key} needs a text value`, 'set field failed');
    }
    const v: string | null = text !== null && text === '' && NULLABLE.has(key) ? null : text;
    let label: string;
    let r: Awaited<ReturnType<typeof edit>>;
    let extra = '';
    if (kind === 'workflow') {
      label = `${t.name} ${key}`;
      r = await edit(ctx, t.id, (s) => setWorkflowField(s, key as 'name', v), `chat:field:${t.id}:${key}`);
    } else if (kind === 'step') {
      const step = s0.steps[id];
      if (!step) return fail(`no step ${id} in ${t.name}`, 'set field failed');
      label = `step ${step.name} ${key}`;
      r = await edit(ctx, t.id, (s) => setStepField(s, id, key as 'name', key === 'entryCondition' ? cond : v), `chat:field:${id}:${key}`);
    } else if (kind === 'cache') {
      const c = s0.caches[id];
      if (!c) return fail(`no cache ${id} in ${t.name}`, 'set field failed');
      label = `cache ${c.name} ${key}`;
      r = await edit(ctx, t.id, (s) => setCacheField(s, id, key as 'name', v), `chat:field:${id}:${key}`);
    } else {
      const base = ctx.store.processor(id, t.id);
      if (!base) return fail(`no processor ${id} in ${t.name}`, 'set field failed');
      if (kind === 'processor') {
        label = `processor ${base.name} ${key}`;
        r = await edit(ctx, t.id, (s) => setProcessorField(s, base, key as 'name', v), `chat:field:processor:${id}:${key}`);
      } else {
        if (!SLOTS.includes(slot as Slot)) return fail('target.slot must be input, output or config', 'set field failed');
        const sl = slot as Slot;
        const originalId = base[SLOT_FIELD[sl]];
        if (originalId === null) return fail(`processor ${base.name} has no ${sl} schema`, 'set field failed');
        const original = ctx.store.schema(originalId, t.id);
        if (!original || original.definition === null || original.definition === undefined) return fail(`the ${sl} schema of processor ${base.name} is not loaded (definition not loaded)`, 'set field failed');
        label = `processor ${base.name} ${sl} schema ${key}`;
        r = await edit(ctx, t.id, (s) => setSlotField(s, base, sl, original, key as 'name', v, ctx.newId), `chat:field:slot:${id}:${sl}:${key}`);
        if (r.ok && sl === 'config' && key === 'definition') {
          // the payloads of this workflow's steps that run the processor are checked against the new definition
          const now = ctx.store.entry(t.id)!.history.present;
          extra = Object.values(now.steps).filter((st) => st.processorId === id).map((st) => checkText(ctx, t.id, now, st.id)).filter((x) => x !== '').join('; ');
        }
      }
    }
    if (!r.ok) return fail(`${t.name}: ${r.result}`, 'set field failed', r.entries);
    ctx.commands.focus(t.id, kind === 'step' ? [id] : undefined);
    const said = r.result === 'done' ? `set ${label} in ${t.name}` : `${label}: ${r.result}`;
    return done(true, extra === '' ? said : `${said}. Payload check: ${extra}`, `set ${label}`, r.entries);
  },
};

const createAssignment: ToolDef = {
  name: 'create_assignment',
  description: "Give a step an assignment, or replace its payload: the JSON text its processor gets as config. The payload is checked against the processor's config schema and the problems are returned; it is kept either way.",
  parameters: { type: 'object', properties: { workflow_id: WORKFLOW_ID, step_id: { type: 'string' }, payload: { type: 'string' } }, required: ['workflow_id', 'step_id', 'payload'], additionalProperties: false },
  async run(ctx, args) {
    const t = target(ctx, args, 'create assignment');
    if ('out' in t) return t.out;
    const stepId = str(args.step_id);
    if (typeof args.payload !== 'string' || args.payload === '') return fail('create_assignment needs a payload (JSON text)', 'create assignment failed');
    const payload = args.payload;
    const step = ctx.store.entry(t.id)!.history.present.steps[stepId];
    if (!step) return fail(`no step ${stepId} in ${t.name}`, 'create assignment failed');
    const r = await edit(ctx, t.id, (s) => setPayload(s, stepId, payload, ctx.newId), `chat:field:${stepId}:payload`);
    if (!r.ok) return fail(`${t.name}: ${r.result}`, 'create assignment failed', r.entries);
    ctx.commands.focus(t.id, [stepId]);
    const problems = checkText(ctx, t.id, ctx.store.entry(t.id)!.history.present, stepId);
    const text = `set the payload of step ${step.name} in ${t.name}`;
    return done(true, problems === '' ? text : `${text}, kept. Payload check: ${problems}`, `set the payload of ${step.name}`, r.entries);
  },
};

const removeAssignmentTool: ToolDef = {
  name: 'remove_assignment',
  description: "Remove a step's assignment (its payload). The user is asked first.",
  parameters: { type: 'object', properties: { workflow_id: WORKFLOW_ID, step_id: { type: 'string' } }, required: ['workflow_id', 'step_id'], additionalProperties: false },
  async run(ctx, args, answer, pin): Promise<ToolOutcome> {
    // the question names the workflow and step and pins them: an answer removes exactly that
    let stepId = str(args.step_id);
    let pinWf: string | undefined;
    if (answer !== undefined) {
      try { const v = JSON.parse(pin ?? '{}') as { w?: unknown; s?: unknown }; pinWf = str(v.w); stepId = str(v.s); } catch { pinWf = ''; }
    }
    const t = target(ctx, args, 'remove assignment', pinWf);
    if ('out' in t) return t.out;
    const state = ctx.store.entry(t.id)!.history.present;
    const step = state.steps[stepId];
    if (!step) return fail(`no step ${stepId} in ${t.name}`, 'remove assignment failed');
    if (!state.assignments[stepId]) return fail(`step ${step.name} in ${t.name} has no assignment`, 'remove assignment failed');
    if (answer === undefined) {
      return { kind: 'ask', question: { text: `Remove the assignment of step ${step.name} in ${t.name}?`, choices: ['Remove', 'Cancel'], pin: JSON.stringify({ w: t.id, s: stepId }) } };
    }
    if (answer !== 'Remove') return fail('the user declined', `user declined: remove assignment of ${step.name}`);
    const r = await edit(ctx, t.id, (s) => removeAssignment(s, stepId));
    if (!r.ok) return fail(`${t.name}: ${r.result}`, 'remove assignment failed', r.entries);
    ctx.commands.focus(t.id, [stepId]);
    return done(true, `removed the assignment of step ${step.name} in ${t.name}`, `removed the assignment of ${step.name}`, r.entries);
  },
};

export const FIELD_TOOLS: ToolDef[] = [setField, createAssignment, removeAssignmentTool];
