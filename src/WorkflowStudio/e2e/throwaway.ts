import { randomBytes } from 'node:crypto';
import { expect, test as base, type APIRequestContext, type Request } from '@playwright/test';
import type { LiveWorkflow } from './studio';

export { expect };

/** One test run's own entities (spec §9: e2e tests never edit shared data). Names start with `e2e-`. */
export interface Throwaway {
  workflow: LiveWorkflow;
  stepId: string;
  stepName: string;
  stepBId: string;
  assignmentId: string;
  tag: string;
  processorId: string;
  schemaId: string;
  cacheId: string;
}

/**
 * What this worker has created so far, each id recorded the moment its POST returns, so cleanup
 * finds a partial set even when `createThrowaway` fails halfway.
 */
export const created: {
  workflowId?: string; stepId?: string; stepBId?: string; extraStepIds?: string[]; assignmentId?: string; processorId?: string; schemaId?: string; cacheId?: string; tag?: string;
  /** More throwaway workflows of this run (copy and paste: a second one to paste into and to share a step with). */
  otherWorkflowIds?: string[];
} = {};

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const label = (name: string, version: string, id: string) => `${name}_${version}-${GUID.test(id) ? id.slice(19).toLowerCase() : id}`;

async function post(request: APIRequestContext, kind: string, data: object): Promise<string> {
  const r = await request.post(`/api/v1/${kind}`, { data });
  expect(r.status(), `POST ${kind}: ${await r.text()}`).toBe(201);
  const { id } = (await r.json()) as { id: string };
  return id;
}

/** A schema, a processor using it as its config schema, steps A → B, an assignment on A, a cache, and a workflow with entry A. */
export async function createThrowaway(request: APIRequestContext): Promise<Throwaway> {
  const tag = `e2e-8-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;
  created.tag = tag;
  created.schemaId = await post(request, 'schemas', { name: `${tag}-config`, version: '1.0.0', description: null, definition: '{"type":"object"}' });
  created.processorId = await post(request, 'processors', {
    name: `${tag}-proc`, version: '1.0.0', description: null, sourceHash: randomBytes(32).toString('hex'), instanceId: null,
    inputSchemaId: null, outputSchemaId: null, configSchemaId: created.schemaId,
  });
  created.stepBId = await post(request, 'steps', { name: `${tag}-b`, version: '1.0.0', description: null, processorId: created.processorId, nextStepIds: [], entryCondition: 1 });
  const stepName = `${tag}-a`;
  created.stepId = await post(request, 'steps', { name: stepName, version: '1.0.0', description: null, processorId: created.processorId, nextStepIds: [created.stepBId], entryCondition: 1 });
  created.assignmentId = await post(request, 'assignments', { name: `${tag}-asg`, version: '1.0.0', description: null, stepId: created.stepId, payload: '{}' });
  created.cacheId = await post(request, 'caches', { name: `${tag}-cache`, version: '1.0.0', description: null, root: `${tag}-root`, items: '{}' });
  created.workflowId = await post(request, 'workflows', {
    name: tag, version: '1.0.0', description: null, entryStepIds: [created.stepId], assignmentIds: [created.assignmentId], cacheIds: [created.cacheId], cronExpression: null,
  });
  return {
    workflow: { id: created.workflowId, name: tag, version: '1.0.0', label: label(tag, '1.0.0', created.workflowId) }, tag,
    stepId: created.stepId, stepName, stepBId: created.stepBId, assignmentId: created.assignmentId,
    processorId: created.processorId, schemaId: created.schemaId, cacheId: created.cacheId,
  };
}

/** The circuit specs' workflow (plan 9 decision 15): steps a, b, c (Completed) and d (Failed); wf -> a, a -> b, a -> d, b -> c; one cache. */
export interface CircuitThrowaway { workflow: LiveWorkflow; tag: string; a: string; b: string; c: string; d: string; cacheId: string }

/**
 * Creates the circuit throwaway through BaseApi's CRUD (`e2e-9-…`): a schema, a processor, four steps, a cache (a drop
 * target that leaves an end open, plan 9 §6) and the workflow; no assignment.
 */
export async function createCircuitThrowaway(request: APIRequestContext): Promise<CircuitThrowaway> {
  const tag = `e2e-9-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;
  created.tag = tag;
  created.schemaId = await post(request, 'schemas', { name: `${tag}-config`, version: '1.0.0', description: null, definition: '{"type":"object"}' });
  created.processorId = await post(request, 'processors', {
    name: `${tag}-proc`, version: '1.0.0', description: null, sourceHash: randomBytes(32).toString('hex'), instanceId: null,
    inputSchemaId: null, outputSchemaId: null, configSchemaId: created.schemaId,
  });
  const step = async (name: string, nextStepIds: string[], entryCondition: number): Promise<string> => {
    const id = await post(request, 'steps', { name: `${tag}-${name}`, version: '1.0.0', description: null, processorId: created.processorId, nextStepIds, entryCondition });
    created.extraStepIds = [...(created.extraStepIds ?? []), id];
    return id;
  };
  const c = await step('c', [], 1);
  const d = await step('d', [], 2);
  const b = await step('b', [c], 1);
  const a = await step('a', [b, d], 1);
  created.cacheId = await post(request, 'caches', { name: `${tag}-cache`, version: '1.0.0', description: null, root: `${tag}-root`, items: '{}' });
  created.workflowId = await post(request, 'workflows', {
    name: tag, version: '1.0.0', description: null, entryStepIds: [a], assignmentIds: [], cacheIds: [created.cacheId], cronExpression: null,
  });
  return { workflow: { id: created.workflowId, name: tag, version: '1.0.0', label: label(tag, '1.0.0', created.workflowId) }, tag, a, b, c, d, cacheId: created.cacheId };
}

/**
 * The copy and paste throwaway (2026-10-10, `e2e-cp-…`): a processor with a config schema, steps a -> b, an assignment on
 * a (payload {"k":7}), the workflow (entry a), and a second workflow `{tag}-other` whose entry step is b, so b is used by
 * another workflow (its delete is refused). Pasted copies keep their names, so cleanup finds them by the tag.
 */
export interface CopyThrowaway { workflow: LiveWorkflow; other: LiveWorkflow; tag: string; a: string; b: string; assignmentId: string; processorId: string; cacheId: string; root: string }

export async function createCopyThrowaway(request: APIRequestContext): Promise<CopyThrowaway> {
  const tag = `e2e-cp-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;
  created.tag = tag;
  created.schemaId = await post(request, 'schemas', { name: `${tag}-config`, version: '1.0.0', description: null, definition: '{"type":"object"}' });
  created.processorId = await post(request, 'processors', {
    name: `${tag}-proc`, version: '1.0.0', description: null, sourceHash: randomBytes(32).toString('hex'), instanceId: null,
    inputSchemaId: null, outputSchemaId: null, configSchemaId: created.schemaId,
  });
  created.stepBId = await post(request, 'steps', { name: `${tag}-b`, version: '1.0.0', description: null, processorId: created.processorId, nextStepIds: [], entryCondition: 1 });
  created.stepId = await post(request, 'steps', { name: `${tag}-a`, version: '1.0.0', description: null, processorId: created.processorId, nextStepIds: [created.stepBId], entryCondition: 1 });
  created.assignmentId = await post(request, 'assignments', { name: `${tag}-asg`, version: '2.0.0', description: 'copied', stepId: created.stepId, payload: '{"k":7}' });
  created.cacheId = await post(request, 'caches', { name: `${tag}-cache`, version: '1.0.0', description: null, root: `${tag}-root`, items: '{}' });
  created.workflowId = await post(request, 'workflows', {
    name: tag, version: '1.0.0', description: null, entryStepIds: [created.stepId], assignmentIds: [created.assignmentId], cacheIds: [created.cacheId], cronExpression: null,
  });
  const other = await post(request, 'workflows', {
    name: `${tag}-other`, version: '1.0.0', description: null, entryStepIds: [created.stepBId], assignmentIds: [], cacheIds: [], cronExpression: null,
  });
  created.otherWorkflowIds = [other];
  return {
    workflow: { id: created.workflowId, name: tag, version: '1.0.0', label: label(tag, '1.0.0', created.workflowId) },
    other: { id: other, name: `${tag}-other`, version: '1.0.0', label: label(`${tag}-other`, '1.0.0', other) },
    tag, a: created.stepId, b: created.stepBId, assignmentId: created.assignmentId, processorId: created.processorId,
    cacheId: created.cacheId, root: `${tag}-root`,
  };
}

/** The Start/Stop throwaway (2026-10-09): one step on a live, schema-less processor of the cluster, unscheduled. */
export interface RunThrowaway { workflow: LiveWorkflow; tag: string; stepId: string; processorId: string }

/**
 * Creates a workflow BaseApi will start (`e2e-run-…`): one step on a processor the live poll says is live and that
 * has no schemas (so no payload or schema edge can refuse it), no cron (it never fires). The processor is the
 * cluster's and is only referenced, never changed or deleted. Null when no such processor is live.
 */
export async function createRunThrowaway(request: APIRequestContext): Promise<RunThrowaway | null> {
  const liveness = await request.get('/api/v1/processors/liveness');
  expect(liveness.ok()).toBe(true);
  const live = new Set(((await liveness.json()) as { processorId: string; live: boolean }[]).filter((p) => p.live).map((p) => p.processorId));
  const listed = await request.get('/api/v1/processors');
  expect(listed.ok()).toBe(true);
  type P = { id: string; inputSchemaId: string | null; outputSchemaId: string | null; configSchemaId: string | null };
  const proc = ((await listed.json()) as P[]).find((p) => live.has(p.id) && !p.inputSchemaId && !p.outputSchemaId && !p.configSchemaId);
  if (!proc) return null;
  const tag = `e2e-run-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;
  created.tag = tag;
  const stepId = await post(request, 'steps', { name: `${tag}-a`, version: '1.0.0', description: null, processorId: proc.id, nextStepIds: [], entryCondition: 1 });
  created.extraStepIds = [stepId];
  created.workflowId = await post(request, 'workflows', {
    name: tag, version: '1.0.0', description: null, entryStepIds: [stepId], assignmentIds: [], cacheIds: [], cronExpression: null,
  });
  return { workflow: { id: created.workflowId, name: tag, version: '1.0.0', label: label(tag, '1.0.0', created.workflowId) }, tag, stepId, processorId: proc.id };
}

/** Stops this run's workflow through BaseApi (never another), and waits until the live set no longer lists it. */
export async function stopRunThrowaway(request: APIRequestContext): Promise<void> {
  const id = created.workflowId;
  if (!id || !created.tag?.startsWith('e2e-')) return;
  const r = await request.post('/api/v1/orchestration/stop', { data: JSON.stringify(id), headers: { 'Content-Type': 'application/json' } });
  expect([202, 400], `POST stop: ${await r.text()}`).toContain(r.status());
  await expect.poll(async () => ((await (await request.get('/api/v1/orchestration/live')).json()) as string[]).includes(id), { timeout: 30_000 }).toBe(false);
}

/**
 * Deletes whatever `created` holds (a partial set too): the workflow; every assignment on step A or B (the
 * one made here and any a Save created); every step this run made, unwired first (a wire restricts both its ends); the
 * processor; every schema named after this run's tag (the original and any copy a Save made, which keeps
 * its name); the cache. Every step is tried; a 404 is fine. Throws once at the end, listing every entity it
 * could not remove.
 */
export async function removeThrowaway(request: APIRequestContext): Promise<void> {
  const failures: string[] = [];
  const attempt = async (what: string, run: () => Promise<void>) => {
    try { await run(); } catch (e) { failures.push(`${what} (${e instanceof Error ? e.message : String(e)})`); }
  };
  const del = (path: string) => attempt(path, async () => {
    const r = await request.delete(`/api/v1/${path}`);
    if (!r.ok() && r.status() !== 404) failures.push(`${path} (${r.status()}: ${await r.text()})`);
  });
  /** The ids of a list's items that `keep` accepts; a list that cannot be read is a failure. */
  const listed = async <T extends { id: string }>(kind: string, keep: (item: T) => boolean): Promise<string[]> => {
    const r = await request.get(`/api/v1/${kind}`);
    if (!r.ok()) { failures.push(`${kind} (list: ${r.status()})`); return []; }
    return ((await r.json()) as T[]).filter(keep).map((x) => x.id);
  };
  const { workflowId, stepId, stepBId, extraStepIds, processorId, schemaId, cacheId, tag, otherWorkflowIds } = created;
  const steps = [stepId, stepBId, ...(extraStepIds ?? [])].filter((id): id is string => id !== undefined);
  if (workflowId) await del(`workflows/${workflowId}`);
  for (const id of otherWorkflowIds ?? []) await del(`workflows/${id}`);
  // steps and caches a Save made by pasting (2026-10-10) keep the copied names: found by this run's tag
  if (tag?.startsWith('e2e-')) {
    await attempt(`steps named ${tag}…`, async () => {
      for (const id of await listed<{ id: string; name: string }>('steps', (x) => x.name.startsWith(tag))) if (!steps.includes(id)) steps.push(id);
    });
  }
  if (steps.length > 0) {
    await attempt(`assignments of steps ${steps.join(', ')}`, async () => {
      for (const id of await listed<{ id: string; stepId: string }>('assignments', (a) => steps.includes(a.stepId))) await del(`assignments/${id}`);
    });
    // as WorkflowGraphLiveTests.DisposeAsync does: read the step, put it back with no wires
    for (const id of steps) {
      await attempt(`unwire steps/${id}`, async () => {
        const r = await request.get(`/api/v1/steps/${id}`);
        if (!r.ok()) return;
        const s = (await r.json()) as { name: string; version: string; processorId: string; entryCondition: number };
        const put = await request.put(`/api/v1/steps/${id}`, {
          data: { name: s.name, version: s.version, description: null, processorId: s.processorId, nextStepIds: [], entryCondition: s.entryCondition },
        });
        if (!put.ok()) failures.push(`unwire steps/${id} (${put.status()}: ${await put.text()})`);
      });
    }
    for (const id of steps) await del(`steps/${id}`);
  }
  if (processorId) await del(`processors/${processorId}`);
  if (tag) {
    await attempt(`schemas named ${tag}…`, async () => {
      for (const id of await listed<{ id: string; name: string }>('schemas', (x) => x.name.startsWith(tag))) await del(`schemas/${id}`);
    });
  } else if (schemaId) await del(`schemas/${schemaId}`);
  if (cacheId) await del(`caches/${cacheId}`);
  if (tag?.startsWith('e2e-')) {
    await attempt(`caches named ${tag}…`, async () => {
      for (const id of await listed<{ id: string; name: string }>('caches', (x) => x.name.startsWith(tag) && x.id !== cacheId)) await del(`caches/${id}`);
    });
  }
  for (const k of Object.keys(created) as (keyof typeof created)[]) delete created[k];
  if (failures.length > 0) throw new Error(`could not remove the throwaway entities:\n  ${failures.join('\n  ')}`);
}

/**
 * Why a request may not reach BaseApi, or null when it may: GETs, Save of this run's workflow (plan 8 §8), and Start
 * or Stop of this run's workflow, an `e2e-` throwaway (2026-10-09), never of any other.
 */
function refusal(r: Request): string | null {
  const method = r.method();
  const path = new URL(r.url()).pathname;
  if (method === 'GET' || method === 'HEAD') return null;
  if (method === 'PUT' && created.workflowId !== undefined && path === `/api/v1/workflows/${created.workflowId}/design`) return null;
  if (method === 'PUT' && (created.otherWorkflowIds ?? []).some((id) => path === `/api/v1/workflows/${id}/design`)) return null;
  // Workspace › Delete workflow… (2026-10-10): the dry run and the real run of this run's throwaway only
  if (method === 'POST' && created.workflowId !== undefined && created.tag?.startsWith('e2e-') && path === `/api/v1/workflows/${created.workflowId}/delete`) return null;
  if (method === 'POST' && (path === '/api/v1/orchestration/start' || path === '/api/v1/orchestration/stop')
    && created.workflowId !== undefined && created.tag?.startsWith('e2e-') && r.postDataJSON() === created.workflowId) return null;
  return `${method} ${path}`;
}

/**
 * The page test for writing specs: the browser may write only Save of this run's throwaway workflow; any
 * other write is aborted before it reaches BaseApi and fails the test.
 */
export const test = base.extend<{ writeGuard: void }>({
  writeGuard: [async ({ context }, use) => {
    const stray: string[] = [];
    await context.route('**/api/v1/**', async (route) => {
      const why = refusal(route.request());
      if (why === null) return route.continue();
      stray.push(why);
      return route.abort();
    });
    await use();
    expect(stray, 'the browser may only write to this run\'s throwaway entities').toEqual([]);
  }, { auto: true }],
});
