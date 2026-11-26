import type { ApiError, StudioApi } from '../api/client';
import { describeError } from '../api/describeError';
import type { ModelApplyResultDto, ModelChangeResultDto } from '../api/types';
import { loadBoard } from '../board/loadBoard';
import type { Id } from '../model/graph';
import type { OutputStore } from '../output/outputStore';
import type { BoardState } from './board';
import { SAVING_REFUSAL, type BoardStore } from './boardStore';
import { affectedWorkflows, boardChanges, type ModelChange, type BoardTable } from './changes';
import { diagramSvg } from './diagramSvg';
import type { GhostStore } from './ghosts';

type Result = NonNullable<ModelApplyResultDto['results']>[number];

const KIND: Record<string, string> = {
  workflows: 'workflow', steps: 'step', caches: 'cache', assignments: 'assignment', processors: 'processor', schemas: 'schema',
};
export const kindOf = (table: string): string => KIND[table] ?? table;

/** The row's name on the first board that holds it; its id otherwise. */
export function nameOf(boards: BoardState[], table: string, id: Id): string {
  for (const b of boards) {
    const row = (b[table as BoardTable] as Record<Id, { name?: string }> | undefined)?.[id];
    if (row?.name) return row.name;
  }
  return id;
}

/** BaseAPI's problem JSON as one line: detail, else the joined field errors, else title. */
export function problemMessage(problem: unknown): string {
  if (!problem || typeof problem !== 'object') return typeof problem === 'string' && problem ? problem : 'refused';
  const p = problem as { title?: unknown; detail?: unknown; errors?: unknown };
  if (typeof p.detail === 'string' && p.detail) return p.detail;
  if (p.errors && typeof p.errors === 'object') {
    const all = Object.values(p.errors as Record<string, unknown>).flatMap((v) => (Array.isArray(v) ? v : [v]))
      .filter((m): m is string => typeof m === 'string' && m !== '');
    if (all.length) return all.join('; ');
  }
  return typeof p.title === 'string' && p.title ? p.title : 'refused';
}

/**
 * A 409 for a row changed since it was read: BaseAPI's own stale check (problem code `stale`). Any other 409 (a
 * duplicate of a unique value, say a cache's root, or a frozen schema definition) is a refusal with its own reason,
 * with no stored version to take [user, 2026-11-19: "fix the wording"].
 */
export const isStale = (r: Result): boolean =>
  r.status === 409 && !!r.problem && typeof r.problem === 'object' && (r.problem as { code?: unknown }).code === 'stale';

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null);

/** A cache's item ops are failures of the cache: keyed and named by it. */
const rowOf = (r: Result): { table: string; id: string } =>
  r.table === 'cache_items' ? { table: 'caches', id: r.id ?? '' } : { table: r.table ?? '', id: r.id ?? '' };

/** The Output line for one failed change result. */
export function failureText(r: Result, boards: BoardState[]): string {
  const row = rowOf(r);
  const name = nameOf(boards, row.table, row.id);
  if (r.table === 'cache_items') {
    // no stored version to take: the cache's item edits stay in the draft
    if (r.status === 404) return `${name} is gone — reload the board; its item edits were not saved`;
    return `${name}: items not saved — ${problemMessage(r.problem)}`;
  }
  if (isStale(r)) return `${name} changed elsewhere — Take stored drops your change to it`;
  if (r.status === 404) return `${kindOf(r.table ?? '')} ${name} is gone — Take stored drops your change to it`;
  return `${kindOf(row.table)} ${name}: ${problemMessage(r.problem)}`;
}

/** Logs every failed result; returns changedKeys-style key to message. */
export function reportFailures(results: ModelApplyResultDto['results'], boards: BoardState[], output: OutputStore): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of (results ?? []).filter((x) => x.ok === false)) {
    const text = failureText(r, boards);
    output.log(text, 'error');
    map.set(`${kindOf(rowOf(r).table)}:${r.id}`, text);
  }
  return map;
}

/**
 * One line per cache with item ops, from the reports BaseAPI returned (append and remove combined). The report is
 * `unknown` in the schema: each count reads as 0 when absent.
 */
export function logItemReports(results: ModelApplyResultDto['results'], made: Record<string, string>, boards: BoardState[], output: OutputStore): void {
  const per = new Map<string, { added: number; overwritten: number; removed: number; repeated: number }>();
  for (const r of results ?? []) {
    const rep = obj(r.report);
    if (r.table !== 'cache_items' || r.ok === false || !rep || !r.id) continue;
    const e = per.get(r.id) ?? { added: 0, overwritten: 0, removed: 0, repeated: 0 };
    if (r.op === 'append') { e.added += num(rep.added); e.overwritten += num(rep.overwritten); }
    else if (r.op === 'remove') e.removed += num(rep.removed);
    else continue;
    e.repeated += num(rep.repeatedInBatch);
    per.set(r.id, e);
  }
  for (const [id, e] of per) {
    const client = Object.keys(made).find((k) => made[k] === id);
    const name = [id, made[id], client].map((i) => (i ? nameOf(boards, 'caches', i) : id)).find((n) => n !== id) ?? id;
    output.log(`${name}: ${e.added} added, ${e.overwritten} overwritten, ${e.removed} removed${e.repeated > 0 ? `, ${e.repeated} repeated` : ''}`, 'ok');
  }
}

/** Created rows take BaseAPI's ids: keys, own ids and every reference. */
export function remapIds(b: BoardState, made: Record<string, string>): BoardState {
  const m = (id: Id) => made[id] ?? id;
  const mo = (id: Id | null) => (id === null ? null : m(id));
  const rekey = <T extends { id: Id }>(rows: Record<Id, T>, f: (r: T) => T): Record<Id, T> =>
    Object.fromEntries(Object.values(rows).map((r) => { const n = f({ ...r, id: m(r.id) }); return [n.id, n]; }));
  return {
    workflows: rekey(b.workflows, (w) => ({ ...w, entryStepIds: w.entryStepIds.map(m), entryCrons: Object.fromEntries(Object.entries(w.entryCrons).map(([k, v]) => [m(k), v])), assignmentIds: w.assignmentIds.map(m), cacheIds: w.cacheIds.map(m) })),
    steps: rekey(b.steps, (s) => ({ ...s, nextStepIds: s.nextStepIds.map(m), processorId: mo(s.processorId) })),
    caches: rekey(b.caches, (c) => c),
    assignments: rekey(b.assignments, (a) => ({ ...a, stepId: m(a.stepId) })),
    processors: rekey(b.processors, (p) => ({ ...p, inputSchemaId: mo(p.inputSchemaId), outputSchemaId: mo(p.outputSchemaId), configSchemaId: mo(p.configSchemaId) })),
    schemas: rekey(b.schemas, (s) => s),
  };
}

const transport = (e: ApiError) => describeError(e);

export const OUTCOME_UNKNOWN = 'Save outcome unknown — reload before saving again';
/** No answer we can read (network, unreadable body, a gateway's 5xx): BaseAPI may have committed. A 4xx is a refusal. */
const outcomeUnknown = (e: ApiError) => e.kind === 'network' || e.status === 0 || e.status >= 500;

/**
 * Board-wide Save [user, 2026-11-23, rev 2]: the draft is already kept (every edit writes it); Save checks the design
 * rules only — what BaseAPI needs to store the rows — and pushes through /model/apply, all or nothing. The design goes as
 * drawn (free style): cycles, schema edges and payloads are the orchestration rules, checked at Start. Kibana follows
 * per affected workflow. `ghosts` learns the created rows' BaseAPI ids before the board adopts the re-read, so a saved
 * create does not become a ghost. `onApplied`, when given, hears BaseAPI's created-id map (client id -> new id) and the
 * affected workflows' new ids once the apply went through (the chat's save reports them).
 */
export async function saveBoard(
  api: StudioApi, store: BoardStore, output: OutputStore, ghosts?: GhostStore,
  onApplied?: (made: Readonly<Record<string, string>>, affected: readonly string[]) => void,
): Promise<'nothing' | 'refused' | 'saved'> {
  if (store.saving()) { output.log(SAVING_REFUSAL, 'warn'); return 'refused'; }
  if (store.saveBlocked()) { output.log(OUTCOME_UNKNOWN, 'error'); return 'refused'; }
  const base = store.base();
  const present = store.state();
  let changes: ModelChange[];
  try {
    changes = boardChanges(base, present);
  } catch (e) {
    // a row the board cannot put in BaseAPI's shape (a cache's items text): nothing is sent
    output.log(`Save refused: ${(e as Error).message}`, 'error');
    return 'refused';
  }
  if (changes.length === 0) { output.log('Nothing to save'); return 'nothing'; }
  store.setSaving(true);
  /** A refused row: failures on the board, stale rows offered to Take stored. */
  const refuse = (results: ModelChangeResultDto[] | null | undefined) => {
    const map = reportFailures(results, [present, base], output);
    if (map.size === 0) output.log('Save refused: BaseAPI gave no reason', 'error');
    store.setFailures(map);
    store.setStale((results ?? [])
      .filter((r) => r.ok === false && r.table !== 'cache_items' && (isStale(r) || r.status === 404) && r.table && r.id && r.table in KIND)
      .map((r) => ({ table: r.table as BoardTable, id: r.id! })));
  };
  try {
    const res = await api.applyModel(changes);
    if (!res.ok) {
      if (outcomeUnknown(res.error)) {
        // a second Save would re-send every create: blocked until a reload shows what BaseAPI kept
        output.log(`Save failed: ${transport(res.error)}`, 'error');
        output.log(OUTCOME_UNKNOWN, 'error');
        store.blockSave();
      } else output.log(`Save failed: ${transport(res.error)}`, 'error');
      return 'refused';
    }
    if (res.value.applied !== true) { refuse(res.value.results); return 'refused'; }
    const made = res.value.made ?? {};
    const affected = affectedWorkflows(base, present).map((id) => made[id] ?? id);
    onApplied?.(made, affected);
    output.log(`Pushed ${changes.length} change${changes.length === 1 ? '' : 's'}`, 'ok');

    logItemReports(res.value.results, made, [present, base], output);
    for (const w of res.value.warnings ?? []) output.log(w, 'warn');

    const fresh = await loadBoard(api);
    let after: BoardState;
    if (fresh.ok) after = fresh.value;
    else {
      after = remapIds(present, made);
      output.log(`Saved, but the board could not be read back (${transport(fresh.error)}). Reload before editing further`, 'warn');
    }
    ghosts?.remap(made);
    store.saved(after);

    for (const id of affected) {
      const wf = after.workflows[id];
      if (!wf) continue;
      const pub = await api.publishDiagram(id, diagramSvg(after, id));
      if (pub.ok) output.log(`${wf.name}: Kibana diagram published`, 'ok');
      else output.log(`${wf.name}: Kibana diagram not published — ${transport(pub.error)}`, 'warn');
    }
    return 'saved';
  } finally {
    store.setSaving(false);
  }
}

/** Drops the designer's change to every row Save found stale: reads the board and takes BaseAPI's version of those rows. */
export async function takeStored(api: StudioApi, store: BoardStore, output: OutputStore): Promise<void> {
  const rows = store.stale();
  if (rows.length === 0 || store.saving()) return;
  store.setSaving(true);
  let fresh;
  try { fresh = await loadBoard(api); } finally { store.setSaving(false); }
  if (!fresh.ok) { output.log(`Could not read the stored rows: ${transport(fresh.error)}`, 'error'); return; }
  const names = rows.map((r) => nameOf([fresh.value, store.state()], r.table, r.id));
  const kept = rows.some((r) => {
    const e = r.table === 'caches' && fresh.value.caches[r.id] ? store.state().caches[r.id]?.itemEdits : undefined;
    return !!e && (Object.keys(e.set).length > 0 || e.removed.length > 0);
  });
  store.takeStored(fresh.value);
  output.log(kept
    ? `Took the stored ${names.join(', ')} — your field changes are dropped, your item edits are kept (Undo brings them back)`
    : `Took the stored ${names.join(', ')} — your changes to ${rows.length === 1 ? 'it' : 'them'} are dropped (Undo brings them back)`, 'ok');
}
