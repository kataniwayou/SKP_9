import type { ApiError, StudioApi } from '../api/client';
import { describeError } from '../api/describeError';
import type { ModelApplyResultDto } from '../api/types';
import { loadBoard } from '../board/loadBoard';
import type { Id } from '../model/graph';
import type { OutputStore } from '../output/outputStore';
import type { BoardState } from './board';
import { SAVING_REFUSAL, type BoardStore } from './boardStore';
import { affectedWorkflows, boardChanges, type Table } from './changes';
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
    const row = (b[table as Table] as Record<Id, { name?: string }> | undefined)?.[id];
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

/** The Output line for one failed change result. */
export function failureText(r: Result, boards: BoardState[]): string {
  const name = nameOf(boards, r.table ?? '', r.id ?? '');
  if (r.status === 409) return `${name} changed elsewhere — Take stored drops your change to it`;
  if (r.status === 404) return `${kindOf(r.table ?? '')} ${name} is gone — Take stored drops your change to it`;
  return `${kindOf(r.table ?? '')} ${name}: ${problemMessage(r.problem)}`;
}

/** Logs every failed result; returns changedKeys-style key to message. */
export function reportFailures(results: ModelApplyResultDto['results'], boards: BoardState[], output: OutputStore): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of (results ?? []).filter((x) => x.ok === false)) {
    const text = failureText(r, boards);
    output.log(text, 'error');
    map.set(`${kindOf(r.table ?? '')}:${r.id}`, text);
  }
  return map;
}

/** Created rows take BaseAPI's ids: keys, own ids and every reference. */
export function remapIds(b: BoardState, made: Record<string, string>): BoardState {
  const m = (id: Id) => made[id] ?? id;
  const mo = (id: Id | null) => (id === null ? null : m(id));
  const rekey = <T extends { id: Id }>(rows: Record<Id, T>, f: (r: T) => T): Record<Id, T> =>
    Object.fromEntries(Object.values(rows).map((r) => { const n = f({ ...r, id: m(r.id) }); return [n.id, n]; }));
  return {
    workflows: rekey(b.workflows, (w) => ({ ...w, entryStepIds: w.entryStepIds.map(m), assignmentIds: w.assignmentIds.map(m), cacheIds: w.cacheIds.map(m) })),
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
 * Board-wide Save through /model/apply: all or nothing; the dry run and Kibana follow per affected workflow. `ghosts`
 * learns the created rows' BaseAPI ids before the board adopts the re-read, so a saved create does not become a ghost.
 * `onApplied`, when given, hears BaseAPI's created-id map (client id -> new id) and the affected workflows' new ids once
 * the apply went through (the chat's save reports them).
 */
export async function saveBoard(
  api: StudioApi, store: BoardStore, output: OutputStore, ghosts?: GhostStore,
  onApplied?: (made: Readonly<Record<string, string>>, affected: readonly string[]) => void,
): Promise<'nothing' | 'refused' | 'saved'> {
  if (store.saving()) { output.log(SAVING_REFUSAL, 'warn'); return 'refused'; }
  if (store.saveBlocked()) { output.log(OUTCOME_UNKNOWN, 'error'); return 'refused'; }
  const base = store.base();
  const present = store.state();
  const changes = boardChanges(base, present);
  if (changes.length === 0) return 'nothing';
  store.setSaving(true);
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
    if (res.value.applied !== true) {
      const map = reportFailures(res.value.results, [present, base], output);
      if (map.size === 0) output.log('Save refused: BaseAPI gave no reason', 'error');
      store.setFailures(map);
      store.setStale((res.value.results ?? [])
        .filter((r) => r.ok === false && (r.status === 409 || r.status === 404) && r.table && r.id && r.table in KIND)
        .map((r) => ({ table: r.table as Table, id: r.id! })));
      return 'refused';
    }
    const made = res.value.made ?? {};
    const affected = affectedWorkflows(base, present).map((id) => made[id] ?? id);
    onApplied?.(made, affected);
    output.log(`Saved ${changes.length} change${changes.length === 1 ? '' : 's'}`, 'ok');

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
      const v = await api.validateWorkflow(id);
      if (v.ok) {
        const problems = v.value.problems ?? [];
        for (const p of problems) output.log(`${wf.name}: ${p.title ?? p.gate ?? 'problem'} — ${p.detail ?? ''}`, 'warn');
        store.setProblems(id, problems.length);
      } else output.log(`${wf.name}: could not validate — ${transport(v.error)}`, 'warn');
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
  store.takeStored(fresh.value);
  output.log(`Took the stored ${names.join(', ')} — your changes to ${rows.length === 1 ? 'it' : 'them'} are dropped (Undo brings them back)`, 'ok');
}
