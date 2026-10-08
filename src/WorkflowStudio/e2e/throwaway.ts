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
  const { workflowId, stepId, stepBId, extraStepIds, processorId, schemaId, cacheId, tag } = created;
  const steps = [stepId, stepBId, ...(extraStepIds ?? [])].filter((id): id is string => id !== undefined);
  if (workflowId) await del(`workflows/${workflowId}`);
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
  for (const k of Object.keys(created) as (keyof typeof created)[]) delete created[k];
  if (failures.length > 0) throw new Error(`could not remove the throwaway entities:\n  ${failures.join('\n  ')}`);
}

/** Why a request may not reach BaseApi, or null when it may: GETs, and Save of this run's workflow (plan 8 §8). */
function refusal(r: Request): string | null {
  const method = r.method();
  const path = new URL(r.url()).pathname;
  if (method === 'GET' || method === 'HEAD') return null;
  if (method === 'PUT' && created.workflowId !== undefined && path === `/api/v1/workflows/${created.workflowId}/design`) return null;
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
