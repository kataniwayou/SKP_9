import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from '@playwright/test';

/**
 * The BaseApi the suite talks to (handover 2026-10-21 §4: a fresh copy of the cluster's project, every non-GET aborted,
 * never Apply on real data). By default a stand-in, answered in the browser by route interception: the six list endpoints
 * from the fixture (the cluster's rows), `GET /model/fields` from the generated snapshot, the processors' liveness, and the
 * dry run (`POST /model/validate`) judged by the test. VALENCE_E2E_LIVE=1: the cluster's BaseApi through the dev proxy,
 * GETs and the dry run only (BaseApi rolls the dry run back).
 */
export const LIVE = process.env.VALENCE_E2E_LIVE === '1';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => JSON.parse(readFileSync(join(here, '..', p), 'utf8')) as unknown;

type Row = Record<string, unknown> & { id: string; name: string };
export interface Project { workflows: Row[]; steps: Row[]; processors: Row[]; schemas: Row[]; assignments: Row[]; caches: Row[] }

/**
 * The cluster's rows (src/test/fixtures/project.json), with the texts the fixture leaves out filled in as BaseApi's rules
 * want them, so an untouched row is a valid one: a definition, a source hash, a payload, items, and when it was read.
 */
export function project(): Project {
  const p = structuredClone(read('src/test/fixtures/project.json')) as Project;
  const stamp = { createdAt: '2026-10-19T00:00:00Z', createdBy: 'e2e', updatedAt: '2026-10-19T00:00:00Z', updatedBy: 'e2e' };
  for (const rows of Object.values(p)) for (const r of rows) Object.assign(r, { ...stamp, ...r });
  for (const s of p.schemas) s.definition ??= '{"type":"object"}';
  for (const x of p.processors) { x.sourceHash ??= x.id.replace(/-/g, '').toLowerCase().repeat(2); x.instanceId ??= null; }
  for (const a of p.assignments) a.payload ??= '{}';
  for (const c of p.caches) c.items ??= '{}';
  return p;
}

/** One change as Valence sends it to the dry run. */
export interface SentChange { op: 'create' | 'update' | 'delete'; table: string; id: string; row?: Record<string, unknown>; updatedAt?: string }
/** BaseApi's ProblemDetails for a refused change. */
export interface Problem { status: number; title: string; detail?: string; errors?: Record<string, string[]>; [k: string]: unknown }

export interface StandIn {
  readonly project: Project;
  /** Every dry run asked, in order (the stand-in's and the live one's). */
  readonly dryRuns: SentChange[][];
  /** Every request that would write: aborted. The suite expects none. */
  readonly writes: string[];
  /** Judges each change of a dry run (stand-in only); null passes it. Set by a test. */
  refuse: (c: SentChange) => Problem | null;
  /** The processors' liveness answer (stand-in only): by processor id; absent from the map = not listed. null: HTTP 503. */
  liveness: Map<string, { live: boolean; healthy: number; replicas: number }> | null;
  /** The AI model's route (stand-in model only): 'drawing' answers a placement; 'off' answers as an unconfigured Valence. */
  ai: 'drawing' | 'off';
  /** How many times the model was asked. */
  readonly aiCalls: number;
}

const json = (route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) =>
  route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });

const okStatus = (op: string) => (op === 'create' ? 201 : op === 'delete' ? 204 : 200);

/** Installs the stand-in BaseApi and model on the page (before it loads). */
export async function standIn(page: Page): Promise<StandIn> {
  const data = project();
  const fields = read('src/api/model-fields.snapshot.json');
  const state = {
    project: data, dryRuns: [] as SentChange[][], writes: [] as string[],
    refuse: (() => null) as StandIn['refuse'],
    liveness: new Map(data.processors.map((p) => [p.id, { live: true, healthy: 1, replicas: 1 }])) as StandIn['liveness'],
    ai: 'drawing' as StandIn['ai'],
    aiCalls: 0,
  };

  // BaseApi's paths only: the dev server's own modules live under /src/api/
  await page.route((u) => u.pathname.startsWith('/api/'), async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api\/v1/, '');
    if (req.method() === 'POST' && path === '/model/validate') {
      const changes = ((req.postDataJSON() as { changes?: SentChange[] }).changes ?? []);
      state.dryRuns.push(changes);
      if (LIVE) return route.continue();
      const results = changes.map((c, index) => {
        const problem = state.refuse(c);
        return { index, op: c.op, table: c.table, id: c.id, ok: problem === null, status: problem?.status ?? okStatus(c.op), problem };
      });
      return json(route, { ok: results.every((r) => r.ok), results });
    }
    if (req.method() !== 'GET') { state.writes.push(`${req.method()} ${url.pathname}`); return route.abort('blockedbyclient'); }
    if (LIVE) return route.continue();
    if (path === '/model/fields') return json(route, fields, 200, { ETag: '"e2e-snapshot"' });
    if (path === '/processors/liveness') {
      if (state.liveness === null) return route.fulfill({ status: 503, body: '' });
      return json(route, [...state.liveness].map(([processorId, l]) => ({ processorId, ...l, absent: 0, unhealthy: l.live ? 0 : l.replicas, stale: 0, malformed: 0 })));
    }
    const table = /^\/(workflows|steps|processors|schemas|assignments|caches)$/.exec(path)?.[1] as keyof Project | undefined;
    if (table) return json(route, data[table]);
    return route.fulfill({ status: 404, body: '' });
  });

  // the chat's model: Valence's own /ai/ route, answered here so no key and no model are needed
  await page.route('**/ai/config', (route) => (state.ai === 'off'
    ? json(route, { error: 'The chat is not configured' }, 503)
    : json(route, { model: 'stand-in' })));
  await page.route('**/ai/chat/completions', (route) => {
    state.aiCalls++;
    if (state.ai === 'off') return route.fulfill({ status: 503, body: '' });
    // a plain answer, no tool called
    const chunk = (delta: object) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
    return route.fulfill({
      status: 200, contentType: 'text/event-stream',
      body: chunk({ reasoning_content: 'reading' }) + chunk({ content: 'Done.' }) + 'data: [DONE]\n\n',
    });
  });

  return state;
}
