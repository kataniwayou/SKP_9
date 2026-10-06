import { randomBytes } from 'node:crypto';
import { expect, test as base, type APIRequestContext, type Request } from '@playwright/test';
import type { LiveWorkflow } from './studio';

export { expect };

/** One test run's own entities (spec §9: e2e tests never edit shared data). Names start with `e2e-`. */
export interface Throwaway {
  workflow: LiveWorkflow;
  stepId: string;
  stepName: string;
  processorId: string;
  schemaId: string;
  cacheId: string;
}

/** The kinds the Inspector may PUT (spec §7.1). */
export type Kind = 'workflows' | 'steps' | 'processors' | 'schemas' | 'assignments' | 'caches';

/**
 * What this worker has created so far, each id recorded the moment its POST returns, so cleanup
 * finds a partial set even when `createThrowaway` fails halfway.
 */
export const created: { workflowId?: string; stepId?: string; processorId?: string; schemaId?: string; cacheId?: string } = {};

/** `kind/id` of every entity the browser may PUT. */
const allowed = new Set<string>();
/** Lets the browser PUT one of this run's entities (e.g. an assignment the test created). */
export const allow = (kind: Kind, id: string): void => { allowed.add(`${kind}/${id}`); };

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const label = (name: string, version: string, id: string) => `${name}_${version}-${GUID.test(id) ? id.slice(19).toLowerCase() : id}`;

async function post(request: APIRequestContext, kind: Kind, data: object): Promise<string> {
  const r = await request.post(`/api/v1/${kind}`, { data });
  expect(r.status(), `POST ${kind}: ${await r.text()}`).toBe(201);
  const { id } = (await r.json()) as { id: string };
  allow(kind, id);
  return id;
}

/** Creates a schema, a processor using it as its config schema, a step, a cache and a workflow. */
export async function createThrowaway(request: APIRequestContext): Promise<Throwaway> {
  const tag = `e2e-3b-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;
  created.schemaId = await post(request, 'schemas', { name: `${tag}-config`, version: '1.0.0', description: null, definition: '{"type":"object"}' });
  created.processorId = await post(request, 'processors', {
    name: `${tag}-proc`, version: '1.0.0', description: null, sourceHash: randomBytes(32).toString('hex'), instanceId: null,
    inputSchemaId: null, outputSchemaId: null, configSchemaId: created.schemaId,
  });
  const stepName = `${tag}-step`;
  created.stepId = await post(request, 'steps', { name: stepName, version: '1.0.0', description: null, processorId: created.processorId, nextStepIds: [], entryCondition: 1 });
  created.cacheId = await post(request, 'caches', { name: `${tag}-cache`, version: '1.0.0', description: null, root: `${tag}-root`, items: '{}' });
  created.workflowId = await post(request, 'workflows', {
    name: tag, version: '1.0.0', description: null, entryStepIds: [created.stepId], assignmentIds: [], cacheIds: [created.cacheId], cronExpression: null,
  });
  return {
    workflow: { id: created.workflowId, name: tag, version: '1.0.0', label: label(tag, '1.0.0', created.workflowId) },
    stepId: created.stepId, stepName, processorId: created.processorId, schemaId: created.schemaId, cacheId: created.cacheId,
  };
}

/**
 * Deletes whatever `created` holds (a partial set too), and any assignment made for the step. Every
 * delete is tried; a 404 is fine. Throws once at the end, listing every entity it could not remove.
 */
export async function removeThrowaway(request: APIRequestContext): Promise<void> {
  const failures: string[] = [];
  const del = async (path: string) => {
    try {
      const r = await request.delete(`/api/v1/${path}`);
      if (!r.ok() && r.status() !== 404) failures.push(`${path} (${r.status()}: ${await r.text()})`);
    } catch (e) {
      failures.push(`${path} (${e instanceof Error ? e.message : String(e)})`);
    }
  };
  const { workflowId, stepId, processorId, schemaId, cacheId } = created;
  if (workflowId) await del(`workflows/${workflowId}`);
  if (stepId) {
    try {
      const assignments = await request.get('/api/v1/assignments');
      if (!assignments.ok()) failures.push(`assignments of step ${stepId} (list: ${assignments.status()})`);
      else for (const a of (await assignments.json()) as { id: string; stepId: string }[]) if (a.stepId === stepId) await del(`assignments/${a.id}`);
    } catch (e) {
      failures.push(`assignments of step ${stepId} (${e instanceof Error ? e.message : String(e)})`);
    }
    await del(`steps/${stepId}`);
  }
  if (processorId) await del(`processors/${processorId}`);
  if (schemaId) await del(`schemas/${schemaId}`);
  if (cacheId) await del(`caches/${cacheId}`);
  for (const k of Object.keys(created) as (keyof typeof created)[]) delete created[k];
  if (failures.length > 0) throw new Error(`could not remove the throwaway entities:\n  ${failures.join('\n  ')}`);
}

const PUT_PATH = /^\/api\/v1\/(workflows|steps|processors|schemas|assignments|caches)\/([^/]+)$/;

/** Why a request may not reach BaseApi, or null when it may. */
function refusal(r: Request): string | null {
  const method = r.method();
  const path = new URL(r.url()).pathname;
  if (method === 'GET' || method === 'HEAD') return null;
  if (method === 'POST' && /^\/api\/v1\/workflows\/[^/]+\/validate$/.test(path)) return null;
  if (method === 'POST' && path === '/api/v1/assignments') {
    let stepId: unknown;
    try { stepId = (r.postDataJSON() as { stepId?: unknown } | null)?.stepId; } catch { stepId = undefined; }
    if (created.stepId !== undefined && stepId === created.stepId) return null;
    return `POST ${path} for step ${String(stepId)}`;
  }
  const put = method === 'PUT' ? PUT_PATH.exec(path) : null;
  if (put && allowed.has(`${put[1]}/${put[2]}`)) return null;
  return `${method} ${path}`;
}

/**
 * The page test for writing specs: the browser may write only to this run's entities (a PUT to one of
 * them, or POST /assignments for this run's step). Any other write is aborted before it reaches
 * BaseApi, and fails the test, like the read-only guard elsewhere.
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
