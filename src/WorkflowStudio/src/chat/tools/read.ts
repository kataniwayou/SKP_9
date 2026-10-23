import type { ApiResult } from '../../api/client';
import { describeError } from '../../api/describeError';
import type { EntityReadDto } from '../../api/entities';
import { graphOf } from '../../ai/drawing';
import type { StudioDocument } from '../../app/document';
import { baseDtoOf } from '../../app/inspectorService';
import { applyEdits } from '../../design/apply';
import { applyBlocks } from '../../design/blocks';
import { fieldsOf, hasEdit, slotKey, valueText } from '../../design/design';
import { runningOf } from '../../live/liveState';
import { conditionInfo } from '../../model/entryConditions';
import { entityName } from '../../model/entityNames';
import type { Graph } from '../../model/graph';
import { FIELDS, savedText } from '../../store/entityForms';
import { inspectorBaseOf } from '../../store/inspectorBase';
import { editTargetOf, type InspectorTarget, type SchemaSlot } from '../../store/inspectorTarget';
import { entityLabel, problemsFrom, shownDesignOf } from '../../store/problems';
import { activeDocument, type OpenDocument } from '../../store/studioState';
import { findCache, findStep, findWorkflow, type Found } from '../resolve';
import type { ToolContext, ToolDef, ToolOutcome } from '../toolTypes';

// The model's eyes (2026-10-23): lists, the design, one entity, Output. Each answers compact JSON text and changes
// nothing, the user's Inspector included.

const done = (ok: boolean, result: string, action: string): ToolOutcome => ({ kind: 'done', ok, result, action, entries: [] });
const fail = (error: string, action: string): ToolOutcome => done(false, error, action);
const json = (value: unknown, action: string): ToolOutcome => done(true, JSON.stringify(value), action);
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
const label = (x: { name?: string | null; version?: string | null }): string => `${x.name ?? ''} ${x.version ?? ''}`.trim();

const WORKFLOW_ARG = {
  type: 'string',
  description: 'The workflow: its id, name, or "name version". Leave out for the workflow the user has open (the active one).',
};
const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false };

/** A list from the API; the Toolbox's three are optional on the API object (a test's fake may lack them). */
async function listOf<T>(call: (() => Promise<ApiResult<T[]>>) | undefined, what: string): Promise<Found<T[]>> {
  if (!call) return { ok: false, error: `cannot list ${what} here` };
  const r = await call();
  return r.ok ? { ok: true, value: r.value } : { ok: false, error: `could not list ${what}. ${describeError(r.error)}` };
}

/** The workflow a tool means: the one named, else the active one; `doc` is its open document, null when it is not open. */
export async function workflowOf(ctx: ToolContext, ref: string | undefined): Promise<Found<{ id: string; doc: OpenDocument | null }>> {
  const state = ctx.store.getState();
  if (ref === undefined) {
    const active = activeDocument(state);
    return active ? { ok: true, value: { id: active.workflowId, doc: active } } : { ok: false, error: 'no workflow is open' };
  }
  const list = await ctx.api.listWorkflows();
  // an open document is found without the list; otherwise "no workflow named X" would blame the name for a failed list
  const found = findWorkflow(list.ok ? list.value : [], state.docs, ref);
  if (!found.ok && !list.ok && !found.ambiguous) return { ok: false, error: `could not read the list of workflows. ${describeError(list.error)}` };
  if (!found.ok) return found;
  return { ok: true, value: { id: found.value, doc: state.docs.find((d) => d.workflowId === found.value) ?? null } };
}

/** A workflow's open document with its loaded workflow, or why there is none. */
async function readyDocOf(ctx: ToolContext, ref: string | undefined): Promise<Found<{ doc: OpenDocument; loaded: StudioDocument }>> {
  const w = await workflowOf(ctx, ref);
  if (!w.ok) return w;
  const doc = w.value.doc;
  if (doc === null) return { ok: false, error: `workflow ${ref} is not open; open it first` };
  if (doc.status.kind !== 'ready') return { ok: false, error: `workflow ${doc.name} is not loaded yet` };
  return { ok: true, value: { doc, loaded: doc.status.doc } };
}

const listWorkflows: ToolDef = {
  name: 'list_workflows',
  description: 'List every workflow: id, name, version, whether it is running and whether it is open in the studio.',
  parameters: NO_ARGS,
  async run(ctx) {
    const list = await listOf(() => ctx.api.listWorkflows(), 'workflows');
    if (!list.ok) return fail(list.error, 'list workflows');
    const running = runningOf(await ctx.api.listLive());
    const open = new Set(ctx.store.getState().docs.map((d) => d.workflowId.toLowerCase()));
    return json(list.value.map((w) => ({
      id: w.id, name: w.name, version: w.version, running: running ? running.has((w.id ?? '').toLowerCase()) : null, open: open.has((w.id ?? '').toLowerCase()),
    })), `list workflows (${list.value.length})`);
  },
};

const listProcessors: ToolDef = {
  name: 'list_processors',
  description: 'List every processor: id, name, version and the schema names of its input, output and config slots (null: an empty slot).',
  parameters: NO_ARGS,
  async run(ctx) {
    const list = await listOf(ctx.api.listProcessors?.bind(ctx.api), 'processors');
    if (!list.ok) return fail(list.error, 'list processors');
    const schemas = await listOf(ctx.api.listSchemas?.bind(ctx.api), 'schemas');
    const nameOf = (id: string | null | undefined): string | null => {
      if (!id) return null;
      const s = schemas.ok ? schemas.value.find((x) => x.id === id) : undefined;
      return s ? label(s) : id;
    };
    return json(list.value.map((p) => ({
      id: p.id, name: p.name, version: p.version,
      schemas: { input: nameOf(p.inputSchemaId), output: nameOf(p.outputSchemaId), config: nameOf(p.configSchemaId) },
    })), `list processors (${list.value.length})`);
  },
};

const listCaches: ToolDef = {
  name: 'list_caches',
  description: 'List every cache: id, name, version and root.',
  parameters: NO_ARGS,
  async run(ctx) {
    const list = await listOf(ctx.api.listCaches?.bind(ctx.api), 'caches');
    if (!list.ok) return fail(list.error, 'list caches');
    return json(list.value.map((c) => ({ id: c.id, name: c.name, version: c.version, root: c.root })), `list caches (${list.value.length})`);
  },
};

const listSchemas: ToolDef = {
  name: 'list_schemas',
  description: 'List every schema: id, name and version.',
  parameters: NO_ARGS,
  async run(ctx) {
    const list = await listOf(ctx.api.listSchemas?.bind(ctx.api), 'schemas');
    if (!list.ok) return fail(list.error, 'list schemas');
    return json(list.value.map((s) => ({ id: s.id, name: s.name, version: s.version })), `list schemas (${list.value.length})`);
  },
};

const readDesign: ToolDef = {
  name: 'read_design',
  description: 'Read the drawing of an open workflow as it is now, unsaved edits included: every block and wire with positions, each step with its name, processor, entry condition, assignment id and next steps, and the current problems (the ones Output pins).',
  parameters: { type: 'object', properties: { workflow: WORKFLOW_ARG }, additionalProperties: false },
  async run(ctx, args) {
    const found = await readyDocOf(ctx, text(args.workflow));
    if (!found.ok) return fail(found.error, 'read design');
    const { doc, loaded } = found.value;
    const draft = doc.design.draft;
    const edited = applyEdits(loaded, doc.edits, draft.blocks);
    const shown = shownDesignOf(doc);
    const { graph } = edited;
    const steps = [...graph.steps.values()].map((s) => {
      const p = s.processorId ? graph.processors.get(s.processorId) : undefined;
      return {
        id: s.id, name: s.name, version: s.version, processor: p ? { name: p.name, version: p.version } : null,
        entryCondition: conditionInfo(s.entryCondition).name, assignmentId: graph.assignments.find((a) => a.stepId === s.id)?.id ?? null, next: s.nextStepIds,
      };
    });
    const problems = problemsFrom(doc, shown).map((e) => ({ entity: entityLabel(e, (shown ?? edited).graph, shown, loaded.graph), kind: e.kind, field: e.field, message: e.message }));
    return json({ workflow: { id: doc.workflowId, name: graph.workflow.name, version: graph.workflow.version }, steps, ...graphOf(edited, draft), problems }, `read design of ${doc.name}`);
  },
};

type Target =
  | { kind: 'workflow' }
  | { kind: 'step'; step: string }
  | { kind: 'processor'; step: string }
  | { kind: 'assignment'; step: string }
  | { kind: 'schema'; step: string; slot: SchemaSlot }
  | { kind: 'cache'; cache: string };

function targetOf(v: unknown): Found<Target> {
  const t = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const step = text(t.step);
  switch (t.kind) {
    case 'workflow': return { ok: true, value: { kind: 'workflow' } };
    case 'step': case 'processor': case 'assignment':
      return step ? { ok: true, value: { kind: t.kind, step } as Target } : { ok: false, error: `target ${t.kind} needs "step": the step's name or id` };
    case 'schema':
      if (!step) return { ok: false, error: `target schema needs "step": the step's name or id` };
      return t.slot === 'input' || t.slot === 'output' || t.slot === 'config'
        ? { ok: true, value: { kind: 'schema', step, slot: t.slot } }
        : { ok: false, error: 'target schema needs "slot": input, output or config' };
    case 'cache': return text(t.cache) ? { ok: true, value: { kind: 'cache', cache: text(t.cache)! } } : { ok: false, error: `target cache needs "cache": the cache's name or id` };
    default: return { ok: false, error: 'target.kind must be one of workflow, step, processor, schema, assignment, cache' };
  }
}

/** The Inspector's target for what the model named, found in the design as shown (`shown`); a slot's schema is the base's (`base`), as the Inspector's drill reads it. */
async function inspectorTargetOf(ctx: ToolContext, doc: OpenDocument, t: Target, shown: Graph, base: Graph): Promise<Found<InspectorTarget>> {
  if (t.kind === 'workflow') return { ok: true, value: { kind: 'workflow', id: doc.workflowId } };
  if (t.kind === 'cache') {
    // this workflow's caches (the design's included) first, else any cache BaseApi lists
    const here = findCache([...shown.caches.values()], t.cache);
    if (here.ok) return { ok: true, value: { kind: 'cache', id: here.value.id } };
    if (here.ambiguous) return here;
    const all = ctx.api.listCaches ? await ctx.api.listCaches() : null;
    const any = all?.ok ? findCache(all.value, t.cache) : here;
    return any.ok ? { ok: true, value: { kind: 'cache', id: any.value.id! } } : any;
  }
  const stepId = findStep(doc, t.step);
  if (!stepId.ok) return stepId;
  const step = shown.steps.get(stepId.value)!;
  if (t.kind === 'step') return { ok: true, value: { kind: 'step', id: step.id } };
  if (t.kind === 'assignment') {
    const a = shown.assignments.find((x) => x.stepId === step.id);
    return a ? { ok: true, value: { kind: 'assignment', id: a.id, stepId: step.id } } : { ok: false, error: `step ${step.name} has no assignment` };
  }
  if (!step.processorId) return { ok: false, error: `step ${step.name} has no processor` };
  if (t.kind === 'processor') return { ok: true, value: { kind: 'processor', id: step.processorId } };
  const key = ({ input: 'inputSchemaId', output: 'outputSchemaId', config: 'configSchemaId' } as const)[t.slot];
  return { ok: true, value: { kind: 'schema', id: base.processors.get(step.processorId)?.[key] ?? '', slot: t.slot, processorId: step.processorId } };
}

/** The entity as the Inspector first shows it: the graph's values, else what the design made up, else BaseApi's row. */
async function baseOf(ctx: ToolContext, doc: OpenDocument, base: Graph, target: InspectorTarget): Promise<Found<EntityReadDto>> {
  const fromGraph = inspectorBaseOf(base, target, null);
  if (fromGraph !== null) return { ok: true, value: fromGraph };
  const r = await baseDtoOf(ctx.api, doc, target);
  return r.ok ? { ok: true, value: inspectorBaseOf(base, target, r.dto) ?? r.dto } : { ok: false, error: r.message };
}

const readEntity: ToolDef = {
  name: 'read_entity',
  description: `Read one entity the way the Inspector shows it, unsaved edits applied: its fields (name, version, description and the entity's own, such as entry condition, payload, schema definition, cache root and items).`,
  parameters: {
    type: 'object',
    properties: {
      workflow: WORKFLOW_ARG,
      target: {
        type: 'object',
        description: `What to read. kind workflow; step, processor or assignment with "step" (a step name or id; the processor and assignment are that step's); schema with "step" and "slot" (input, output or config); cache with "cache" (name or id).`,
        properties: {
          kind: { type: 'string', enum: ['workflow', 'step', 'processor', 'schema', 'assignment', 'cache'] },
          step: { type: 'string' },
          slot: { type: 'string', enum: ['input', 'output', 'config'] },
          cache: { type: 'string' },
        },
        required: ['kind'],
      },
    },
    required: ['target'],
    additionalProperties: false,
  },
  async run(ctx, args) {
    const t = targetOf(args.target);
    if (!t.ok) return fail(t.error, 'read entity');
    const found = await readyDocOf(ctx, text(args.workflow));
    if (!found.ok) return fail(found.error, 'read entity');
    const { doc, loaded } = found.value;
    // the Inspector's own layers: the base (with the draft's blocks), then the entity edits over it
    const base = applyBlocks(loaded, doc.design.draft.blocks).graph;
    const edited = applyEdits(loaded, doc.edits, doc.design.draft.blocks).graph;
    const target = await inspectorTargetOf(ctx, doc, t.value, edited, base);
    if (!target.ok) return fail(target.error, 'read entity');
    const at = target.value;
    const dto = await baseOf(ctx, doc, base, at);
    if (!dto.ok) return fail(dto.error, 'read entity');
    const editTarget = editTargetOf(at);
    const edits = fieldsOf(doc.edits, editTarget);
    const fields: Record<string, string> = {};
    for (const spec of FIELDS[at.kind]) {
      const shown = Object.hasOwn(edits, spec.key) ? valueText(edits[spec.key]) : savedText(dto.value, spec.key); // as the Inspector's form shows it
      fields[spec.key] = spec.kind === 'condition' ? conditionInfo(Number(shown)).name : shown;
    }
    const copy = at.kind === 'schema' ? doc.edits.schemas[slotKey(at.processorId, at.slot)] : undefined;
    const id = copy?.id ?? (at.kind === 'workflow' ? doc.workflowId : at.id);
    const out: Record<string, unknown> = {
      kind: at.kind, id, name: entityName(fields.name ?? '', fields.version ?? '', id), fields, unsaved: hasEdit(doc.edits, editTarget),
    };
    if (at.kind === 'step') {
      const s = edited.steps.get(at.id);
      const p = s?.processorId ? edited.processors.get(s.processorId) : undefined;
      out.processor = p ? label(p) : null;
      out.assignmentId = edited.assignments.find((a) => a.stepId === at.id)?.id ?? null;
    }
    if (at.kind === 'processor') {
      const p = edited.processors.get(at.id);
      const slot = (sid: string | null | undefined) => {
        const s = sid ? edited.schemas.get(sid) : undefined;
        return s ? label(s) : sid ?? null;
      };
      out.schemas = { input: slot(p?.inputSchemaId), output: slot(p?.outputSchemaId), config: slot(p?.configSchemaId) };
    }
    return json(out, `read ${at.kind} ${fields.name ?? ''}`.trim());
  },
};

const readOutput: ToolDef = {
  name: 'read_output',
  description: 'Read the last lines of Output (what Save, Start and Stop did), oldest first.',
  parameters: {
    type: 'object',
    properties: { workflow: WORKFLOW_ARG, last: { type: 'integer', description: 'How many lines, the newest (default 20, at most 200).' } },
    additionalProperties: false,
  },
  async run(ctx, args) {
    const ref = text(args.workflow);
    // no workflow named and none active: every workflow's lines
    const w = ref === undefined && activeDocument(ctx.store.getState()) === null ? null : await workflowOf(ctx, ref);
    if (w !== null && !w.ok) return fail(w.error, 'read output');
    const n = typeof args.last === 'number' && args.last >= 1 ? Math.min(200, Math.floor(args.last)) : 20;
    const lines = ctx.store.getState().output.filter((l) => w === null || !w.ok || l.workflowId === w.value.id).slice(-n);
    return json(lines.map((l) => ({ at: l.at, workflow: l.name, level: l.level, text: l.text })), `read output (${lines.length} lines)`);
  },
};

export const READ_TOOLS: ToolDef[] = [listWorkflows, listProcessors, listCaches, listSchemas, readDesign, readEntity, readOutput];
