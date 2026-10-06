import { randomBytes } from 'node:crypto';
import { expect, test as base, type APIRequestContext } from '@playwright/test';
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

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const label = (name: string, version: string, id: string) => `${name}_${version}-${GUID.test(id) ? id.slice(19).toLowerCase() : id}`;

async function post(request: APIRequestContext, path: string, data: object): Promise<{ id: string }> {
  const r = await request.post(`/api/v1/${path}`, { data });
  expect(r.status(), `POST ${path}: ${await r.text()}`).toBe(201);
  return (await r.json()) as { id: string };
}

/** Creates a schema, a processor using it as its config schema, a step, a cache and a workflow. */
export async function createThrowaway(request: APIRequestContext): Promise<Throwaway> {
  const tag = `e2e-3b-${Date.now().toString(36)}`;
  const schema = await post(request, 'schemas', { name: `${tag}-config`, version: '1.0.0', description: null, definition: '{"type":"object"}' });
  const processor = await post(request, 'processors', {
    name: `${tag}-proc`, version: '1.0.0', description: null, sourceHash: randomBytes(32).toString('hex'), instanceId: null,
    inputSchemaId: null, outputSchemaId: null, configSchemaId: schema.id,
  });
  const stepName = `${tag}-step`;
  const step = await post(request, 'steps', { name: stepName, version: '1.0.0', description: null, processorId: processor.id, nextStepIds: [], entryCondition: 1 });
  const cache = await post(request, 'caches', { name: `${tag}-cache`, version: '1.0.0', description: null, root: `${tag}-root`, items: '{}' });
  const workflow = await post(request, 'workflows', {
    name: tag, version: '1.0.0', description: null, entryStepIds: [step.id], assignmentIds: [], cacheIds: [cache.id], cronExpression: null,
  });
  return {
    workflow: { id: workflow.id, name: tag, version: '1.0.0', label: label(tag, '1.0.0', workflow.id) },
    stepId: step.id, stepName, processorId: processor.id, schemaId: schema.id, cacheId: cache.id,
  };
}

/** Deletes them all, and any assignment made for the step; a missing one is fine. */
export async function removeThrowaway(request: APIRequestContext, t: Throwaway): Promise<void> {
  const del = (path: string) => request.delete(`/api/v1/${path}`);
  await del(`workflows/${t.workflow.id}`);
  const assignments = await request.get('/api/v1/assignments');
  if (assignments.ok()) {
    for (const a of (await assignments.json()) as { id: string; stepId: string }[]) if (a.stepId === t.stepId) await del(`assignments/${a.id}`);
  }
  await del(`steps/${t.stepId}`);
  await del(`processors/${t.processorId}`);
  await del(`schemas/${t.schemaId}`);
  await del(`caches/${t.cacheId}`);
}

/**
 * The page test for writing specs: the browser may write only to this run's entities (a PUT to one of
 * them, or POST /assignments). Every other write fails the test, like the read-only guard elsewhere.
 */
export const allowed = new Set<string>();
export const test = base.extend<{ writeGuard: void }>({
  writeGuard: [async ({ context }, use) => {
    const stray: string[] = [];
    context.on('request', (r) => {
      const url = new URL(r.url());
      if (r.method() === 'GET' || r.method() === 'HEAD') return;
      if (r.method() === 'POST' && /^\/api\/v1\/workflows\/[^/]+\/validate$/.test(url.pathname)) return;
      if (r.method() === 'POST' && url.pathname === '/api/v1/assignments') return;
      const id = url.pathname.split('/').at(-1) ?? '';
      if (r.method() === 'PUT' && allowed.has(id)) return;
      stray.push(`${r.method()} ${url.pathname}`);
    });
    await use();
    expect(stray, 'the browser may only write to this run\'s throwaway entities').toEqual([]);
  }, { auto: true }],
});
