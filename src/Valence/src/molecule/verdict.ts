import type { ModelFields } from '../api/fields';
import type { DryRun, Problem } from '../api/validate';
import { labelOf } from './rules';
import type { PlannedChange } from './plan';

/** BaseApi's answer for one atom's changes: its problems by field, and those that belong to no one field. */
export interface AtomVerdict { ok: boolean; fields: Record<string, string[]>; other: string[] }

/** The state of BaseApi's dry run of the virtual changes. */
export type DryRunState =
  | { kind: 'idle' }
  | { kind: 'checking'; planned: number }
  | { kind: 'done'; ok: boolean; planned: number; refused: number; byAtom: Readonly<Record<string, AtomVerdict>> }
  | { kind: 'unavailable'; reason: string };

export const NO_DRY_RUN: DryRunState = { kind: 'idle' };

/** `InputSchemaId.Value` → `inputSchemaId`: a validator's property path as the field's JSON name. */
const fieldOfProperty = (p: string) => { const head = p.split('.')[0] ?? p; return head.charAt(0).toLowerCase() + head.slice(1); };

/** One problem as lines by field: the validator's errors, a key's column, or the whole problem. */
function linesOf(problem: Problem | null, table: string, fields: ModelFields): { fields: Record<string, string[]>; other: string[] } {
  const out: Record<string, string[]> = {};
  const other: string[] = [];
  if (!problem) return { fields: out, other: ['BaseApi refused it without saying why.'] };
  if (problem.errors && typeof problem.errors === 'object' && !Array.isArray(problem.errors)) {
    for (const [prop, messages] of Object.entries(problem.errors)) {
      const list = Array.isArray(messages) ? messages.map(String) : [String(messages)];
      (out[fieldOfProperty(prop)] ??= []).push(...list);
    }
    return { fields: out, other };
  }
  const text = [problem.title, problem.detail].filter(Boolean).join(' — ');
  const column = typeof problem.field === 'string' ? problem.field : null;
  const field = column && fields.entities.find((e) => e.table === table)?.fields.find((f) => f.column === column)?.field;
  if (field) (out[field] ??= []).push(text); else other.push(text);
  return { fields: out, other };
}

/** The dry run's answers on the atoms the planned changes belong to. */
export function verdictOf(planned: readonly PlannedChange[], run: DryRun, fields: ModelFields): DryRunState {
  if (run.kind === 'unavailable') return { kind: 'unavailable', reason: run.reason };
  const byAtom: Record<string, AtomVerdict> = {};
  for (const r of run.results) {
    const change = planned[r.index];
    if (!change) continue;
    const v = (byAtom[change.atom] ??= { ok: true, fields: {}, other: [] });
    if (r.ok) continue;
    v.ok = false;
    const lines = linesOf(r.problem, r.table, fields);
    for (const [f, list] of Object.entries(lines.fields)) (v.fields[f] ??= []).push(...list);
    v.other.push(...lines.other.map((t) => (change.op === 'delete' ? `Delete: ${t}` : t)));
  }
  return { kind: 'done', ok: run.ok, planned: planned.length, refused: run.results.filter((r) => !r.ok).length, byAtom };
}

/** One line for the Output pane. */
export function dryRunLine(state: DryRunState, planned: readonly PlannedChange[], names: (atom: string) => string): string | null {
  if (state.kind === 'unavailable') return `Dry run: not available (${state.reason}); edits are checked by the rules alone.`;
  if (state.kind !== 'done') return null;
  if (state.ok) return `Dry run by BaseApi: ${state.planned} change${state.planned === 1 ? '' : 's'}, all pass (nothing was written).`;
  const refused = Object.entries(state.byAtom).filter(([, v]) => !v.ok).map(([atom, v]) => {
    const first = Object.entries(v.fields)[0];
    const why = first ? `${labelOf(first[0])}: ${first[1][0]}` : v.other[0] ?? '';
    return `${names(atom)} — ${why}`;
  });
  return `Dry run by BaseApi: ${state.refused} of ${planned.length} refused — ${refused.join('; ')}`;
}
