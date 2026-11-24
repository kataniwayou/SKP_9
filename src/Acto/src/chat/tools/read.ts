import type { ApiResult } from '../../api/client';
import { describeError } from '../../api/describeError';
import type { EntityKind } from '../../api/entities';
import { livenessText, statusOf, type LiveState } from '../../live/liveState';
import { reachOf } from '../../design/board';
import { affectedWorkflows } from '../../design/changes';
import { assignmentsOf, linkedBy } from '../../design/payloads';
import { conditionInfo } from '../../model/entryConditions';
import type { Id } from '../../model/graph';
import { withPicks } from '../../board/selection';
import { focusOf, listOf as pickListOf, processorTabsOf, stepTabsOf, tabsOf } from '../../inspector/tabs';
import type { ToolContext, ToolDef } from '../toolTypes';
import { ghostName } from './design';
import { done, fail, NO_ARGS } from './common';

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
  description: 'List every workflow on the board: id, name, version, Running or Stopped, whether the board has unsaved changes that touch it (and whether it was ever saved), and how many steps it reaches.',
  parameters: NO_ARGS,
  async run(ctx) {
    const b = ctx.store.state();
    const base = ctx.store.base();
    const touched = new Set(affectedWorkflows(base, b));
    const rows = Object.values(b.workflows).map((w) => ({
      id: w.id, name: w.name, version: w.version, status: runWord(ctx, w.id), unsaved: touched.has(w.id),
      saved: !!base.workflows[w.id], steps: reachOf(b, w.id).size,
    }));
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

const readBoard: ToolDef = {
  name: 'read_board',
  description: 'Read the whole board as it is now, unsaved edits included: every step (id, name, version, description, processor with health, entry condition, next step ids = wires, position), every cache (id, name, version, description, root, items as JSON text, position), and every workflow triangle (fields, Running or Stopped, unsaved and saved flags, problems of the last refused Start, entry steps (id and its own cron, or null), the steps it reaches, linked caches, and its payloads: assignment id, name, version, description, step id, payload, and the other workflows sharing that payload).',
  parameters: NO_ARGS,
  async run(ctx) {
    const b = ctx.store.state();
    const base = ctx.store.base();
    const live = ctx.live.getState();
    const touched = new Set(affectedWorkflows(base, b));
    const steps = Object.values(b.steps).map((st) => {
      const p = st.processorId ? b.processors[st.processorId] : undefined;
      return {
        id: st.id, name: st.name, version: st.version,
        processor: st.processorId ? { id: st.processorId, name: p?.name ?? null, version: p?.version ?? null, health: healthOf(live, st.processorId) } : null,
        description: st.description, entryCondition: conditionInfo(st.entryCondition).name, next: st.nextStepIds, at: st.at,
      };
    });
    const caches = Object.values(b.caches).map((c) => ({ id: c.id, name: c.name, version: c.version, description: c.description, root: c.root, items: c.items, at: c.at }));
    const workflows = Object.values(b.workflows).map((w) => ({
      id: w.id, name: w.name, version: w.version, description: w.description,
      status: runWord(ctx, w.id), unsaved: touched.has(w.id), saved: !!base.workflows[w.id], problems: ctx.store.problems(w.id),
      entrySteps: w.entryStepIds.map((id) => ({ id, cron: w.entryCrons[id] ?? null })), steps: [...reachOf(b, w.id)], caches: w.cacheIds, at: w.at,
      payloads: assignmentsOf(b, w.id).map((a) => ({
        assignmentId: a.id, name: a.name, version: a.version, description: a.description, stepId: a.stepId, payload: a.payload,
        sharedWith: linkedBy(b, a.id).filter((x) => x !== w.id),
      })),
    }));
    return json({ steps, caches, workflows }, `read board (${workflows.length} workflows)`);
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

const listGhosts: ToolDef = {
  name: 'list_ghosts',
  description: 'List the ghosts: deleted items, not on the board now (key, kind, name). They belong to the draft: a reload or a save keeps them until remove_ghosts drops them. restore_ghosts and remove_ghosts take the keys.',
  parameters: NO_ARGS,
  async run(ctx) {
    const store = ctx.ghosts;
    const rows = (store?.ghosts() ?? []).map((g) => ({ key: g.key, kind: g.kind, name: ghostName(g, store!.get) }));
    return json(rows, `list ghosts (${rows.length})`);
  },
};

const NO_GHOSTS = { get: () => undefined };

const readSelection: ToolDef = {
  name: 'read_selection',
  description: "Read what is selected on the board now (the user's clicks or your pick) and what the Inspector shows for it: its top tabs, the child tabs under Step (the selected workflow's assignment) and under Processor (its schemas), and the assignment shown; or the numbered pick list.",
  parameters: NO_ARGS,
  async run(ctx) {
    const b = ctx.store.state();
    const ghosts = ctx.ghosts ?? NO_GHOSTS;
    const sel = withPicks({ workflows: [], picks: [] }, ctx.commands.picks());
    const label = (p: (typeof sel.picks)[number]): string => {
      switch (p.kind) {
        case 'workflow': return `workflow ${b.workflows[p.id]?.name ?? p.id}`;
        case 'step': return `step ${b.steps[p.id]?.name ?? p.id}`;
        case 'cache': return `cache ${b.caches[p.id]?.name ?? p.id}`;
        case 'wire': return `wire ${b.steps[p.from]?.name ?? p.from} > ${b.steps[p.to]?.name ?? p.to}`;
        case 'entry': return `entry arrow ${b.workflows[p.workflowId]?.name ?? p.workflowId} > ${b.steps[p.stepId]?.name ?? p.stepId}`;
        case 'cacheLink': return `cache line ${b.workflows[p.workflowId]?.name ?? p.workflowId} > ${b.caches[p.cacheId]?.name ?? p.cacheId}`;
        case 'ghost': { const g = ghosts.get(p.key); return `ghost ${g ? ghostName(g, ghosts.get) : p.key}`; }
      }
    };
    const picked = sel.picks.map(label);
    const list = pickListOf(sel, b);
    if (list) return json({ selected: picked, inspector: { pickList: list.map(label) } }, `read selection (${picked.length})`);
    const focus = focusOf(sel, b);
    if (!focus) return json({ selected: [], inspector: 'nothing: no item is selected' }, 'read selection (0)');
    const tabs = tabsOf(sel, b, ghosts).map((t) => t.label);
    if (focus.kind !== 'step') return json({ selected: picked, inspector: { tabs } }, `read selection (${picked.length})`);
    const step = b.steps[focus.id];
    const stepChildren = stepTabsOf(sel, b, focus.id);
    const processorChildren = processorTabsOf(b, step?.processorId ?? null).map((c) => c.label);
    const shown = stepChildren.map((c) => {
      const wf = c.id.slice('assignment:'.length);
      const a = assignmentsOf(b, wf).find((x) => x.stepId === focus.id);
      return { workflow: c.label, assignment: a ? { id: a.id, name: a.name, payload: a.payload } : null };
    });
    return json({ selected: picked, inspector: { tabs, underStep: stepChildren.map((c) => c.label), underProcessor: processorChildren, assignmentsShown: shown } }, `read selection (${picked.length})`);
  },
};

export const READ_TOOLS: ToolDef[] = [listWorkflows, listProcessors, listCaches, listSchemas, readBoard, readEntity, readOutput, listGhosts, readSelection];
