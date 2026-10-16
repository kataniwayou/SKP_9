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

/**
 * Asks BaseApi to run the changes as it would apply them and keep none (`POST /model/validate`): each change's answer
 * is what the real PUT or DELETE would say, on the state the changes before it leave.
 */
export async function dryRun(changes: readonly PlannedChange[], fetchFn: typeof fetch = fetch, signal?: AbortSignal): Promise<DryRun> {
  try {
    const res = await fetchFn('/api/v1/model/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ changes: changes.map(({ op, table, id, row }) => (op === 'update' ? { op, table, id, row } : { op, table, id })) }),
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
