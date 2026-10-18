/**
 * Processor health (the user, 2026-10-18: "the processors atoms must be illuminated based on their health"), as SKP
 * Studio reads it (WorkflowStudio src/live/liveState.ts): BaseApi's `GET /api/v1/processors/liveness`, judged as the
 * start gate judges. Read every LIVENESS_POLL_MS; nothing is written.
 */

/** What a processor's glow shows: healthy (green), unhealthy (red), undetermined (grey: no answer, or not listed). */
export type Health = 'healthy' | 'unhealthy' | 'undetermined';

/** One processor as BaseApi reports it. */
export interface ProcessorLive { live: boolean; healthy: number; replicas: number; reason: string | null }

/** What Valence knows of the processors' health: nothing yet, BaseApi's answer (by processor id, lower case), or the last read failed. */
export type Liveness =
  | { kind: 'checking' }
  | { kind: 'known'; processors: ReadonlyMap<string, ProcessorLive> }
  | { kind: 'unknown'; reason: string };

export const NO_LIVENESS: Liveness = { kind: 'checking' };
export const LIVENESS_POLL_MS = 5000;

const count = (e: Record<string, unknown>, k: string) => (typeof e[k] === 'number' ? e[k] as number : 0);

/**
 * BaseApi's answer read defensively: entries without a string `processorId` and a boolean `live` are skipped; null when
 * the answer is not a list. A processor that is not live says why, as SKP Studio says it.
 */
export function livenessOf(value: unknown): Map<string, ProcessorLive> | null {
  if (!Array.isArray(value)) return null;
  const out = new Map<string, ProcessorLive>();
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.processorId !== 'string' || typeof e.live !== 'boolean') continue;
    const reason = e.live ? null
      : `no healthy replica (${count(e, 'replicas')} checked: ${count(e, 'absent')} absent, ${count(e, 'unhealthy')} unhealthy, ${count(e, 'stale')} stale, ${count(e, 'malformed')} malformed)`;
    out.set(e.processorId.toLowerCase(), { live: e.live, healthy: count(e, 'healthy'), replicas: count(e, 'replicas'), reason });
  }
  return out;
}

/** Reads the processors' health from BaseApi. */
export async function readLiveness(fetchFn: typeof fetch = fetch, signal?: AbortSignal): Promise<Liveness> {
  try {
    const res = await fetchFn('/api/v1/processors/liveness', { headers: { Accept: 'application/json' }, signal });
    if (!res.ok) return { kind: 'unknown', reason: `BaseApi answered HTTP ${res.status}` };
    const processors = livenessOf(await res.json());
    return processors ? { kind: 'known', processors } : { kind: 'unknown', reason: 'BaseApi\'s answer is not a list' };
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    return { kind: 'unknown', reason: 'BaseApi could not be read' };
  }
}

/** A processor's health: undetermined while not known, or when BaseApi does not list it. */
export function healthOf(liveness: Liveness, processorId: string): Health {
  if (liveness.kind !== 'known') return 'undetermined';
  const p = liveness.processors.get(processorId.toLowerCase());
  return p === undefined ? 'undetermined' : p.live ? 'healthy' : 'unhealthy';
}

/** The Inspector's line for a processor. */
export function healthLine(liveness: Liveness, processorId: string, made: boolean): string {
  if (made) return 'Not known: made in Valence, not applied, so nothing runs it yet';
  if (liveness.kind === 'checking') return 'Checking…';
  if (liveness.kind === 'unknown') return `Not known: ${liveness.reason}`;
  const p = liveness.processors.get(processorId.toLowerCase());
  if (!p) return 'Not known: BaseApi does not list this processor';
  const replicas = `${p.healthy} of ${p.replicas} replica${p.replicas === 1 ? '' : 's'} healthy`;
  return p.live ? `Healthy · ${replicas}` : `Unhealthy · ${p.reason}`;
}
