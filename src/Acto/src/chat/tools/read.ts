import type { ApiResult } from '../../api/client';
import { describeError } from '../../api/describeError';
import type { EntityKind } from '../../api/entities';
import { livenessText, statusOf, type LiveState } from '../../live/liveState';
import { conditionInfo } from '../../model/entryConditions';
import type { Id } from '../../model/graph';
import type { ToolContext, ToolDef } from '../toolTypes';
import { done, fail, NO_ARGS, target, WORKFLOW_ID } from './common';

const json = (value: unknown, action: string) => done(true, JSON.stringify(value), action);
const KINDS: EntityKind[] = ['workflow', 'step', 'processor', 'schema', 'assignment', 'cache'];

const healthOf = (live: LiveState, id: Id | null | undefined): string =>
  livenessText(live.processorsKnown, id ? live.processors.get(id.toLowerCase()) ?? null : null);

/** The run word of a workflow: Running, Stopped, or that it is not known. */
function runWord(ctx: ToolContext, id: Id): string {
  const s = statusOf(ctx.live.getState(), id);
  return s === 'running' ? 'Running' : s === 'stopped' ? 'Stopped' : s === 'checking' ? 'checking' : 'unknown';
}

/** What the list tools show of a processor, cache or schema, whether it comes from the API or the page's own list. */
interface Row { id?: string; name?: string | null; version?: string | null; root?: string | null }

async function listOf(call: (() => Promise<ApiResult<Row[]>>) | undefined, fallback: (() => Row[]) | undefined, what: string):
  Promise<{ ok: true; value: Row[] } | { ok: false; error: string }> {
  if (!call) return fallback ? { ok: true, value: fallback() } : { ok: false, error: `cannot list ${what} here` };
  const r = await call();
  return r.ok ? { ok: true, value: r.value } : { ok: false, error: `could not list ${what}. ${describeError(r.error)}` };
}

const listWorkflows: ToolDef = {
  name: 'list_workflows',
  description: 'List every workflow on the board: id, name, version, Running or Stopped, whether it has unsaved changes (and whether it was ever saved), and its step count.',
  parameters: NO_ARGS,
  async run(ctx) {
    const rows = ctx.store.boards().map((b) => {
      const id = b.graph.workflow.id;
      const e = ctx.store.entry(id);
      const s = e?.history.present;
      return {
        id, name: s?.fields.name ?? b.graph.workflow.name, version: s?.fields.version ?? b.graph.workflow.version,
        status: runWord(ctx, id), unsaved: e?.unsaved ?? false, saved: e ? e.base !== null : true, steps: s ? Object.keys(s.steps).length : b.stepIds.length,
      };
    });
    return json(rows, `list workflows (${rows.length})`);
  },
};

const listProcessors: ToolDef = {
  name: 'list_processors',
  description: 'List every processor: id, name, version and health now (e.g. "live · 1 of 1 replica healthy", "not live · why", "not reported", "unknown").',
  parameters: NO_ARGS,
  async run(ctx) {
    const list = await listOf(ctx.api.listProcessors?.bind(ctx.api), ctx.processors, 'processors');
    if (!list.ok) return fail(list.error, 'list processors');
    const live = ctx.live.getState();
    return json(list.value.map((p) => ({ id: p.id, name: p.name, version: p.version, health: healthOf(live, p.id) })), `list processors (${list.value.length})`);
  },
};

const listCaches: ToolDef = {
  name: 'list_caches',
  description: 'List every cache: id, name, version and root.',
  parameters: NO_ARGS,
  async run(ctx) {
    const list = await listOf(ctx.api.listCaches?.bind(ctx.api), ctx.caches, 'caches');
    if (!list.ok) return fail(list.error, 'list caches');
    return json(list.value.map((c) => ({ id: c.id, name: c.name, version: c.version, root: c.root })), `list caches (${list.value.length})`);
  },
};

const listSchemas: ToolDef = {
  name: 'list_schemas',
  description: 'List every schema: id, name and version.',
  parameters: NO_ARGS,
  async run(ctx) {
    const list = await listOf(ctx.api.listSchemas?.bind(ctx.api), undefined, 'schemas');
    if (!list.ok) return fail(list.error, 'list schemas');
    return json(list.value.map((s) => ({ id: s.id, name: s.name, version: s.version })), `list schemas (${list.value.length})`);
  },
};

const readDesign: ToolDef = {
  name: 'read_design',
  description: 'Read one workflow as the board shows it now, unsaved edits included: its fields, steps (id, name, version, processor with health, entry condition, role first/parked/reached, next step ids, position), caches, assignments, the problems count of the last save and whether it has unsaved changes.',
  parameters: { type: 'object', properties: { workflow_id: WORKFLOW_ID }, required: ['workflow_id'], additionalProperties: false },
  async run(ctx, args) {
    const t = target(ctx, args, 'read design');
    if ('out' in t) return t.out;
    const bw = ctx.store.boards().find((b) => b.graph.workflow.id === t.id);
    const e = ctx.store.entry(t.id);
    if (!bw || !e) return fail(`no workflow ${t.id} on the board`, 'read design');
    const s = e.history.present;
    const live = ctx.live.getState();
    const steps = bw.stepIds.map((id) => {
      const st = s.steps[id]!;
      const p = st.processorId ? bw.graph.processors.get(st.processorId) : undefined;
      return {
        id, name: st.name, version: st.version,
        processor: st.processorId ? { id: st.processorId, name: p?.name ?? null, version: p?.version ?? null, health: healthOf(live, st.processorId) } : null,
        entryCondition: conditionInfo(st.entryCondition).name, role: bw.roles.get(id) ?? 'parked', next: st.nextStepIds, at: st.at,
      };
    });
    return json({
      id: t.id, fields: s.fields, status: runWord(ctx, t.id), unsaved: e.unsaved, saved: e.base !== null, problems: e.problems, steps,
      caches: Object.values(s.caches).map((c) => ({ id: c.id, name: c.name, version: c.version, root: c.root })),
      assignments: Object.values(s.assignments).map((a) => ({ id: a.id, stepId: a.stepId, name: a.name, version: a.version })),
    }, `read design of ${s.fields.name}`);
  },
};

const readEntity: ToolDef = {
  name: 'read_entity',
  description: 'Read one entity as BaseAPI stores it (the saved version, not unsaved edits): kind workflow, step, processor, schema, assignment or cache, and its id.',
  parameters: {
    type: 'object',
    properties: { kind: { type: 'string', enum: KINDS }, id: { type: 'string' } },
    required: ['kind', 'id'], additionalProperties: false,
  },
  async run(ctx, args) {
    const kind = args.kind as EntityKind;
    const id = typeof args.id === 'string' ? args.id : '';
    if (!KINDS.includes(kind)) return fail(`kind must be one of ${KINDS.join(', ')}`, 'read entity');
    if (id === '') return fail("id is needed: the entity's id", 'read entity');
    const r = await ctx.api.getEntity(kind, id);
    if (!r.ok) return fail(`could not read ${kind} ${id}. ${describeError(r.error)}`, `read ${kind} failed`);
    return json(r.value, `read ${kind} ${id}`);
  },
};

const readOutput: ToolDef = {
  name: 'read_output',
  description: 'Read the newest Output lines (time, level, text), oldest first. `last` is how many (default 20, at most 200).',
  parameters: { type: 'object', properties: { last: { type: 'number' } }, additionalProperties: false },
  async run(ctx, args) {
    const n = typeof args.last === 'number' && Number.isFinite(args.last) ? Math.min(200, Math.max(1, Math.floor(args.last))) : 20;
    const lines = ctx.output.lines().slice(-n).map((l) => ({ at: l.at, level: l.level, text: l.text }));
    return json(lines, `read output (${lines.length})`);
  },
};

export const READ_TOOLS: ToolDef[] = [listWorkflows, listProcessors, listCaches, listSchemas, readDesign, readEntity, readOutput];
