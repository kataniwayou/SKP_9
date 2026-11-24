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

// ---- Elasticsearch (the live specs read the orchestrator's and processors' own records) ----------------------------

/** Elasticsearch through its port-forward, and the index the collector writes every service's logs to. */
export const ES = process.env.SKP_ES_URL ?? 'http://localhost:19200';
export const LOG_INDEX = 'logs-generic.otel-default';

/** The orchestrator's record of one entry step reaching its queue (WorkflowFireJob), one per entry step per fire. */
export const ENTRY_DISPATCHED = 'dispatched an entry step';
/** The orchestrator's record of a finished step's successor being dispatched (StepOutcomeHandler): StepId is the finished step. */
export const HANDED_OFF = 'handed off to {NextStepId} on {NextProcessorId} with {NextEntryId}';
/** An entry step's own outcome, beside its advancement record (OutcomeTemplates.EntryCompleted). */
export const ENTRY_COMPLETED = 'the entry step completed with {Result}';
/** A Failed or Cancelled step whose successors still accept it (OutcomeTemplates.AdvancedAnyway). */
export const ADVANCED_ANYWAY = 'advancing {SuccessorCount} successor(s) on a {Result} step — their entry conditions accept it';
/** The scheduler's warning for an entry group whose cron has no future fire (WorkflowScheduler). */
export const NO_FUTURE_FIRE = 'cron of entry group {EntryGroupIndex} of workflow {WorkflowId} yields no future fire time; nothing scheduled for it';

/** One log record as the collector indexed it: its time (ms since the epoch) and its attributes. */
export interface LogRecord { at: number; attributes: Record<string, string>; body: string; service: string; level: string; raw: unknown }

/** The collector writes @timestamp as epoch milliseconds with a fraction, as a string. */
const parseStamp = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : Date.parse(String(v));
};

/** One search over the log index: the records matching every term filter (attribute name → value) in [from, to] (ms). */
export async function searchLogs(terms: Record<string, string>, from: number, to: number, size = 5000): Promise<LogRecord[]> {
  const filter: unknown[] = Object.entries(terms).map(([k, v]) => ({ term: { [k]: v } }));
  filter.push({ range: { '@timestamp': { gte: from, lte: to, format: 'epoch_millis' } } });
  const r = await fetch(`${ES}/${LOG_INDEX}/_search`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ size, sort: [{ '@timestamp': 'asc' }], query: { bool: { filter } } }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`elasticsearch search answered ${r.status}: ${text.slice(0, 400)}`);
  const hits = (JSON.parse(text) as { hits: { hits: { _source: Record<string, unknown> }[] } }).hits.hits;
  return hits.map(({ _source: s }) => ({
    at: parseStamp(s['@timestamp']),
    attributes: (s.attributes ?? {}) as Record<string, string>,
    body: ((s.body as { text?: string } | undefined)?.text) ?? '',
    service: (((s.resource as { attributes?: Record<string, string> } | undefined)?.attributes ?? {})['service.name']) ?? '',
    level: String(s.severity_text ?? ''),
    raw: s,
  }));
}

/** How many records match the term filters in [from, to] (a read-only count). */
export async function countLogs(terms: Record<string, string>, from: number, to: number): Promise<number> {
  const filter: unknown[] = Object.entries(terms).map(([k, v]) => ({ term: { [k]: v } }));
  filter.push({ range: { '@timestamp': { gte: from, lte: to, format: 'epoch_millis' } } });
  const r = await fetch(`${ES}/${LOG_INDEX}/_search`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ size: 0, track_total_hits: true, query: { bool: { filter } } }),
  });
  if (!r.ok) throw new Error(`elasticsearch count answered ${r.status}`);
  return (await r.json() as { hits: { total: { value: number } } }).hits.total.value;
}

/**
 * The records matching the filters in [from - 5 s, to + 5 s], read until two polls 5 s apart agree (the ingest runs ~7–15 s
 * behind, so one immediate read undercounts the last records). An empty answer settles only when `settleOnEmpty` says none is
 * the expected answer. Ported from BaseApi.Tests' EntryCronLiveTests.SettledDispatchesAsync.
 */
export async function settledLogs(terms: Record<string, string>, from: number, to: number, opts: { settleOnEmpty?: boolean; floorMs?: number; budgetMs?: number } = {}): Promise<LogRecord[]> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const deadline = Date.now() + (opts.budgetMs ?? 90_000);
  await sleep(opts.floorMs ?? 10_000);
  let previous: LogRecord[] | null = null;
  for (;;) {
    const current = await searchLogs(terms, from - 5_000, to + 5_000);
    if ((previous && previous.length === current.length && (current.length > 0 || opts.settleOnEmpty)) || Date.now() > deadline) return current;
    previous = current;
    await sleep(5_000);
  }
}

/** POST /orchestration/{start|stop} for a workflow, straight to BaseAPI (the live specs' cleanup and BaseAPI-layer cases). */
export async function orchestrate(action: 'start' | 'stop', workflowId: string): Promise<Response> {
  return fetch(`${API}/orchestration/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(workflowId) });
}
