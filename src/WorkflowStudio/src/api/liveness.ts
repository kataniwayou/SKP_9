import type { ApiResult } from './client';

/** What a processor's image shows (spec §5.1): green and spinning, red and still, grey and blinking. */
export type Health = 'healthy' | 'unhealthy' | 'undetermined';

/** A processor's health by id; ids compare without case. */
export type HealthOf = (processorId: string) => Health;

/** No data: every processor is undetermined. */
export const NO_VERDICT: HealthOf = () => 'undetermined';

/**
 * Reads `GET /processors/liveness` defensively (spec §5.1): `live: true` is healthy, `live: false`
 * unhealthy. No poll yet, a failed poll, a body that is not an array, an entry without a string
 * `processorId` and a boolean `live`, and a processor the list does not name are all undetermined:
 * no answer is never a verdict.
 */
export function healthOf(result: ApiResult<unknown> | null): HealthOf {
  if (result === null || !result.ok || !Array.isArray(result.value)) return NO_VERDICT;
  const verdicts = new Map<string, Health>();
  for (const entry of result.value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { processorId, live } = entry as { processorId?: unknown; live?: unknown };
    if (typeof processorId !== 'string' || typeof live !== 'boolean') continue;
    verdicts.set(processorId.toLowerCase(), live ? 'healthy' : 'unhealthy');
  }
  return (processorId) => verdicts.get(processorId.toLowerCase()) ?? 'undetermined';
}
