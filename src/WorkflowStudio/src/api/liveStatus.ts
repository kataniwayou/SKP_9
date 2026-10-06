import type { ApiResult } from './client';

/** A document's run status as its toolbar shows it (spec §6.1). */
export type LiveStatus = 'checking' | 'running' | 'stopped' | 'unknown';

/**
 * Reads `GET /orchestration/live` defensively. A failed call or a body that is not an array is
 * "status unknown", never "stopped" (a Redis fault is a 500, spec §4.4). Entries that are not
 * strings, or strings that are not this workflow's id, are skipped; ids compare without case.
 */
export function liveStatusOf(result: ApiResult<unknown>, workflowId: string): LiveStatus {
  if (!result.ok || !Array.isArray(result.value)) return 'unknown';
  const id = workflowId.toLowerCase();
  return result.value.some((entry) => typeof entry === 'string' && entry.toLowerCase() === id) ? 'running' : 'stopped';
}
