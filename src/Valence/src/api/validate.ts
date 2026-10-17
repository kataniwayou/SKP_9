import type { PlannedChange } from '../molecule/plan';

/** The problem BaseApi's real call would answer for a change (ProblemDetails, as its exception handlers write it). */
export interface Problem { status?: number; title?: string; detail?: string; errors?: Record<string, string[]>; field?: string; [k: string]: unknown }
export interface ChangeResult { index: number; op: string; table: string; id: string; ok: boolean; status: number; problem: Problem | null }

export type DryRun =
  | { kind: 'done'; ok: boolean; results: ChangeResult[] }
  /**
   * Nothing judged by BaseApi: it has no dry run (`missing`: an older BaseApi — asking again is pointless until it is
   * redeployed), or it could not be reached or failed (asking again may work).
   */
  | { kind: 'unavailable'; reason: string; missing?: boolean };

/** The changes as BaseApi takes them: a delete has no row; an update or delete of a row it holds says when it was read. */
const wire = (changes: readonly PlannedChange[]) => changes.map(({ op, table, id, row, updatedAt }) => ({
  op, table, id, ...(op === 'delete' ? {} : { row }), ...(updatedAt ? { updatedAt } : {}),
}));

export type Applied =
  /** Every change passed and BaseApi kept them all; `made`: each created row's client id → the id BaseApi gave it. */
  | { kind: 'applied'; results: ChangeResult[]; made: Record<string, string> }
  /** A change was refused: BaseApi kept none of them. */
  | { kind: 'refused'; results: ChangeResult[] }
  | { kind: 'unavailable'; reason: string };

/**
 * Applies the changes (`POST /model/apply`, approved 2026-10-17): BaseApi runs them as the dry run does, in one
 * transaction, and keeps them only if every one passes — all of them, or none.
 */
export async function apply(changes: readonly PlannedChange[], fetchFn: typeof fetch = fetch): Promise<Applied> {
  try {
    const res = await fetchFn('/api/v1/model/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ changes: wire(changes) }),
    });
    if (res.status === 404 || res.status === 405) return { kind: 'unavailable', reason: 'this BaseApi has no POST /model/apply yet' };
    if (!res.ok) return { kind: 'unavailable', reason: `POST /api/v1/model/apply: ${res.status}` };
    const body = (await res.json()) as { ok: boolean; applied: boolean; results: ChangeResult[]; made?: Record<string, string> };
    return body.applied ? { kind: 'applied', results: body.results, made: body.made ?? {} } : { kind: 'refused', results: body.results };
  } catch (e) {
    return { kind: 'unavailable', reason: `BaseApi could not be reached: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** A refusal because the row changed in BaseApi since it was read (the stale-row check's 409). */
export const isStale = (r: ChangeResult) => r.status === 409 && r.problem?.code === 'stale';

/**
 * Asks BaseApi to run the changes as it would apply them and keep none (`POST /model/validate`): each change's answer
 * is what the real PUT or DELETE would say, on the state the changes before it leave.
 */
export async function dryRun(changes: readonly PlannedChange[], fetchFn: typeof fetch = fetch, signal?: AbortSignal): Promise<DryRun> {
  try {
    const res = await fetchFn('/api/v1/model/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ changes: wire(changes) }),
      signal,
    });
    if (res.status === 404 || res.status === 405) return { kind: 'unavailable', reason: 'this BaseApi has no POST /model/validate yet', missing: true };
    if (!res.ok) return { kind: 'unavailable', reason: `POST /api/v1/model/validate: ${res.status}` };
    const body = (await res.json()) as { ok: boolean; results: ChangeResult[] };
    return { kind: 'done', ok: body.ok, results: body.results };
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    return { kind: 'unavailable', reason: `BaseApi could not be reached: ${e instanceof Error ? e.message : String(e)}` };
  }
}
