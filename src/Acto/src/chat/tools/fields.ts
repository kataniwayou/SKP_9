import { SLOT_FIELD, type Slot } from '../../design/board';
import { setCacheField, setProcessorField, setSlotSchema, setStepField, setWorkflowField } from '../../design/edits';
import { removeAssignment, setAssignmentField, setPayload } from '../../design/payloads';
import { CONDITIONS } from '../../model/entryConditions';
import type { ToolDef, ToolOutcome } from '../toolTypes';
import { applyState, done, fail, onBoard, STEP_ID, text, WORKFLOW_ID } from './common';

const FIELDS = {
  workflow: ['name', 'version', 'description', 'cronExpression'],
  step: ['name', 'version', 'description', 'entryCondition'],
  cache: ['name', 'version', 'description', 'root', 'items'],
  processor: ['name', 'version', 'description'],
  schema: ['name', 'version', 'description', 'definition'],
  assignment: ['name', 'version', 'description'],
} as const;
type Kind = keyof typeof FIELDS;
const NULLABLE = new Set(['description', 'cronExpression']);

const setField: ToolDef = {
  name: 'set_field',
  description: "Set one field of a workflow (name, version, description, cronExpression), step (name, version, description, entryCondition: 1 Completed, 2 Failed, 3 Cancelled, 4 Always, 5 Never), cache (name, version, description, root, items), processor (name, version, description), schema (name, version, description; its definition is read-only: a change needs the processor restarted) or assignment (name, version, description: a workflow's payload row, id from read_board's payloads, with that workflow's workflow_id), as the Inspector does. A processor or schema shared with other things is changed for all of them; a schema edit gives the processor a schema of its own; an assignment other workflows also link is copied for this workflow only. `value` null clears a description or cron.",
  parameters: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: Object.keys(FIELDS) }, id: { type: 'string' }, field: { type: 'string' },
      value: { type: ['string', 'number', 'null'] },
      workflow_id: { ...WORKFLOW_ID, description: 'Only for kind assignment: the workflow whose payload it is.' },
    },
    required: ['kind', 'id', 'field', 'value'], additionalProperties: false,
  },
  async run(ctx, args) {
    const kind = args.kind as Kind;
    if (!(kind in FIELDS)) return fail(`kind must be one of ${Object.keys(FIELDS).join(', ')}`, 'set field');
    const id = text(args, 'id');
    const field = text(args, 'field');
    const b = ctx.store.state();
    const table = kind === 'workflow' ? b.workflows : kind === 'step' ? b.steps : kind === 'cache' ? b.caches : kind === 'processor' ? b.processors
      : kind === 'assignment' ? b.assignments : b.schemas;
    if (id === '' || !table[id]) return fail(`no ${kind} ${id === '' ? '(none given)' : id} on the board`, 'set field');
    const wfId = text(args, 'workflow_id');
    if (kind === 'assignment') {
      const w = b.workflows[wfId];
      if (!w) return fail(`no workflow ${wfId === '' ? '(none given)' : wfId} on the board: an assignment is set through the workflow whose payload it is`, 'set field');
      if (!w.assignmentIds.includes(id)) return fail(`workflow ${w.name} has no assignment ${id}`, 'set field');
    }
    const names: readonly string[] = FIELDS[kind];
    if (!names.includes(field)) return fail(`a ${kind} has no field ${field}: the fields are ${names.join(', ')}`, 'set field');
    // [user, 2026-11-19] a definition change needs the processor restarted: read-only, as in the Inspector
    if (kind === 'schema' && field === 'definition') return fail('a schema definition is read-only: a change needs the processor restarted', 'set field');
    const raw = args.value;
    let value: string | number | null;
    if (field === 'entryCondition') {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
      if (!CONDITIONS.some((c) => c.value === n)) return fail(`entryCondition must be one of ${CONDITIONS.map((c) => `${c.value} ${c.name}`).join(', ')}`, 'set field');
      value = n;
    } else if (raw === null) {
      if (!NULLABLE.has(field)) return fail(`${field} cannot be cleared: give a text`, 'set field');
      value = null;
    } else if (typeof raw === 'string') value = raw;
    else return fail(`${field} takes a text`, 'set field');
    const what = `${kind} ${(table[id] as { name: string }).name}`;
    const edit = (cur: typeof b) => {
      switch (kind) {
        case 'workflow': return setWorkflowField(cur, id, field as 'name', value as string);
        case 'step': return setStepField(cur, id, field as 'name', value as string);
        case 'cache': return setCacheField(cur, id, field as 'name', value as string);
        case 'processor': return setProcessorField(cur, id, field as 'name', value as string | null);
        case 'schema': {
          const holder = Object.values(cur.processors).find((p) => (['input', 'output', 'config'] as Slot[]).some((s) => p[SLOT_FIELD[s]] === id));
          const slot = holder && (['input', 'output', 'config'] as Slot[]).find((s) => holder[SLOT_FIELD[s]] === id);
          const sc = cur.schemas[id]!;
          if (!holder || !slot) return cur;
          const copy = { id, name: sc.name, version: sc.version, description: sc.description, definition: sc.definition ?? '', [field]: value } as
            { id: string; name: string; version: string; description: string | null; definition: string };
          return setSlotSchema(cur, holder.id, slot, copy, ctx.newId);
        }
        case 'assignment': return setAssignmentField(cur, wfId, id, field as 'name', value as string | null, ctx.newId);
      }
    };
    if (kind === 'schema' && edit(b) === b) return fail(`schema ${id} is held by no processor on the board`, 'set field');
    return applyState(ctx, edit, `set ${field} of ${what}`, `set ${field} of ${what}`);
  },
};

const setPayloadTool: ToolDef = {
  name: 'set_payload',
  description: "Set the workflow's payload (the JSON its step's processor gets as config) on a step. In place when only this workflow has one there; a payload other workflows share is copied for this workflow only; none yet makes one. Not checked against the config schema: the dry run on Save reports problems.",
  parameters: {
    type: 'object',
    properties: { workflow_id: WORKFLOW_ID, step_id: STEP_ID, payload: { type: 'string', description: 'The payload as JSON text.' } },
    required: ['workflow_id', 'step_id', 'payload'], additionalProperties: false,
  },
  async run(ctx, args) {
    const wf = onBoard(ctx, 'workflow', text(args, 'workflow_id'), 'set payload');
    if ('out' in wf) return wf.out;
    const st = onBoard(ctx, 'step', text(args, 'step_id'), 'set payload');
    if ('out' in st) return st.out;
    if (typeof args.payload !== 'string') return fail('payload must be the JSON as text', 'set payload');
    const payload = args.payload;
    const b = ctx.store.state();
    const out = applyState(ctx, (cur) => setPayload(cur, wf.id, st.id, payload, ctx.newId), 'set payload', '');
    if (!out.ok) return out;
    return done(true, `set the payload of ${b.workflows[wf.id]!.name} on step ${b.steps[st.id]!.name}; not saved yet`, `set payload on ${b.steps[st.id]!.name}`);
  },
};

/** A remove_assignment question's pin: the workflow and the assignment it named (JSON). */
function assignmentPin(pin: string | undefined): { w: string; a: string } | undefined {
  try {
    const v: unknown = JSON.parse(pin ?? '');
    if (typeof v === 'object' && v !== null && typeof (v as { w?: unknown }).w === 'string' && typeof (v as { a?: unknown }).a === 'string') return v as { w: string; a: string };
  } catch { /* not a pin of ours */ }
  return undefined;
}

const removeAssignmentTool: ToolDef = {
  name: 'remove_assignment',
  description: "Remove a workflow's payload (assignment) from the workflow; the payload itself goes only when no other workflow has it. The user is asked first.",
  parameters: {
    type: 'object',
    properties: { workflow_id: WORKFLOW_ID, assignment_id: { type: 'string', description: 'The id of the assignment (read_board gives it in the triangle\'s payloads).' } },
    required: ['workflow_id', 'assignment_id'], additionalProperties: false,
  },
  async run(ctx, args, answer, pin): Promise<ToolOutcome> {
    const pinned = answer === undefined ? undefined : assignmentPin(pin);
    if (answer !== undefined && !pinned) return fail('the question lost what it named: ask again', 'remove assignment');
    const wfId = pinned?.w ?? text(args, 'workflow_id');
    const aId = pinned?.a ?? text(args, 'assignment_id');
    const wf = onBoard(ctx, 'workflow', wfId, 'remove assignment');
    if ('out' in wf) return wf.out;
    const b = ctx.store.state();
    const w = b.workflows[wf.id]!;
    if (!w.assignmentIds.includes(aId)) return fail(`workflow ${wf.id} has no assignment ${aId}`, 'remove assignment');
    const step = b.steps[b.assignments[aId]?.stepId ?? '']?.name ?? aId;
    if (answer === undefined) {
      return { kind: 'ask', question: { text: `Remove ${w.name}'s payload on ${step}?`, choices: ['Remove', 'Cancel'], pin: JSON.stringify({ w: wf.id, a: aId }) } };
    }
    if (answer !== 'Remove') return fail('the user declined', `user declined: remove payload on ${step}`);
    return applyState(ctx, (cur) => removeAssignment(cur, wf.id, aId), 'remove assignment', `removed ${w.name}'s payload on ${step}; not saved yet`);
  },
};

const setProcessor: ToolDef = {
  name: 'set_processor', description: "Change a step's processor (list_processors gives the ids).",
  parameters: { type: 'object', properties: { step_id: STEP_ID, processor_id: { type: 'string' } }, required: ['step_id', 'processor_id'], additionalProperties: false },
  async run(ctx, args) {
    const st = onBoard(ctx, 'step', text(args, 'step_id'), 'set processor');
    if ('out' in st) return st.out;
    const pid = text(args, 'processor_id');
    const p = ctx.store.state().processors[pid] ?? ctx.processors().find((x) => x.id === pid);
    if (!p) return fail(`no processor ${pid === '' ? '(none given)' : pid}`, 'set processor');
    const name = ctx.store.state().steps[st.id]!.name;
    return applyState(ctx, (b) => setStepField(b, st.id, 'processorId', pid), 'set processor', `step ${name} now runs ${p.name}`);
  },
};

export const FIELD_TOOLS: ToolDef[] = [setField, setPayloadTool, removeAssignmentTool, setProcessor];
