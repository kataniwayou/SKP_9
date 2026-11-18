import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** BaseAPI itself (not through Vite): what global setup, teardown and the specs' seeding talk to. */
export const API = `${process.env.SKP_API ?? 'http://localhost:18080'}/api/v1`;

export const PREFIX = 'e2e-';
export const isE2e = (name: unknown): boolean => typeof name === 'string' && name.startsWith(PREFIX);

export type Row = Record<string, unknown> & { id: string; name: string };
export type TableName = 'workflows' | 'steps' | 'caches' | 'assignments';
export const TABLES: readonly TableName[] = ['workflows', 'steps', 'caches', 'assignments'];
export type Snapshot = Record<TableName, Row[]>;

/** Fields a Save may change on a real row (controller ruling R5: Acto's placed locations, and the stamp that comes with them). */
export const LOCATION_FIELDS = ['boardX', 'boardY', 'updatedAt'] as const;

/** Where the run's snapshot of the real rows is kept (workers and teardown read it). */
export const BASELINE_FILE = resolve(process.cwd(), 'test-results', 'e2e-baseline.json');

export interface Baseline {
  startedAt: string;
  /** Every real (non-e2e-) row, all fields, as the run found it. */
  snapshot: Snapshot;
  workflows: { id: string; name: string }[];
}

export function writeBaseline(b: Baseline) {
  mkdirSync(dirname(BASELINE_FILE), { recursive: true });
  writeFileSync(BASELINE_FILE, JSON.stringify(b));
}
export function baseline(): Baseline {
  try { return JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as Baseline; } catch {
    throw new Error('the e2e baseline is missing: run the specs through playwright.config.ts (global-setup.ts)');
  }
}

export async function getJson<T = unknown>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`);
  if (!r.ok) throw new Error(`GET ${path} answered ${r.status}`);
  return (await r.json()) as T;
}

export async function readAll(): Promise<Snapshot> {
  const out = {} as Snapshot;
  for (const t of TABLES) out[t] = await getJson<Row[]>(`/${t}`);
  return out;
}

export interface Change { op: 'create' | 'update' | 'delete'; table: string; id: string; row?: object; updatedAt?: string }
export interface ApplyAnswer {
  applied?: boolean;
  made?: Record<string, string>;
  results?: { ok?: boolean; op?: string; table?: string; id?: string; status?: number; problem?: { detail?: string; title?: string } }[];
}

export async function apply(changes: Change[]): Promise<ApplyAnswer> {
  const r = await fetch(`${API}/model/apply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changes }) });
  const body = (await r.json().catch(() => ({}))) as ApplyAnswer;
  if (!r.ok || body.applied !== true) {
    const why = (body.results ?? []).filter((x) => x.ok === false).map((x) => `${x.op ?? ''} ${x.table}: ${x.problem?.detail ?? x.problem?.title ?? x.status}`).join('; ');
    throw new Error(`model/apply refused (${r.status}): ${why || JSON.stringify(body).slice(0, 300)}`);
  }
  return body;
}

const READ_ONLY = new Set(['id', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy']);
/** A read DTO as the write body of its row. */
export const bodyOf = (r: Row): Record<string, unknown> => Object.fromEntries(Object.entries(r).filter(([k]) => !READ_ONLY.has(k)));

/**
 * Deletes every e2e- workflow, step, cache and assignment through /model/apply, in the order BaseAPI's keys need: the
 * workflows (their junction rows go with them), the e2e steps' wires cleared, then assignments, steps and caches.
 * Returns how many rows went.
 */
export async function deleteE2eRows(): Promise<number> {
  const all = await readAll();
  const wf = all.workflows.filter((w) => isE2e(w.name));
  const steps = all.steps.filter((s) => isE2e(s.name));
  const stepIds = new Set(steps.map((s) => s.id));
  const assignments = all.assignments.filter((a) => isE2e(a.name) || stepIds.has(a.stepId as string));
  const caches = all.caches.filter((c) => isE2e(c.name));
  const total = wf.length + steps.length + assignments.length + caches.length;
  if (total === 0) return 0;
  const changes: Change[] = [];
  for (const w of wf) changes.push({ op: 'delete', table: 'workflows', id: w.id });
  // a step's next-step rows are not cleared by its delete: clear every e2e step's wires first
  for (const s of steps) {
    if (((s.nextStepIds as string[]) ?? []).length === 0) continue;
    changes.push({ op: 'update', table: 'steps', id: s.id, row: { ...bodyOf(s), nextStepIds: [] }, updatedAt: s.updatedAt as string });
  }
  for (const a of assignments) changes.push({ op: 'delete', table: 'assignments', id: a.id });
  for (const s of steps) changes.push({ op: 'delete', table: 'steps', id: s.id });
  for (const c of caches) changes.push({ op: 'delete', table: 'caches', id: c.id });
  await apply(changes);
  return total;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (v: unknown) => (Array.isArray(v) ? [...v].sort() : v);

/** Every difference in a real row between two snapshots, location fields aside; a row that is missing or new counts. */
export function realDifferences(before: Snapshot, after: Snapshot): string[] {
  const out: string[] = [];
  for (const t of TABLES) {
    const was = new Map(before[t].map((r) => [r.id, r]));
    const now = new Map(after[t].filter((r) => !isE2e(r.name)).map((r) => [r.id, r]));
    for (const [id, r] of was) {
      const n = now.get(id);
      if (!n) { out.push(`${t} ${r.name} (${id}) is gone`); continue; }
      for (const k of new Set([...Object.keys(r), ...Object.keys(n)])) {
        if ((LOCATION_FIELDS as readonly string[]).includes(k)) continue;
        if (!same(sorted(r[k]), sorted(n[k]))) out.push(`${t} ${r.name}: ${k} changed ${JSON.stringify(r[k])} -> ${JSON.stringify(n[k])}`);
      }
    }
    for (const [id, n] of now) if (!was.has(id)) out.push(`${t} ${n.name} (${id}) appeared`);
  }
  return out;
}
