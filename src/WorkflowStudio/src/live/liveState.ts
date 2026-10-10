import type { ApiResult } from '../api/client';
import { NO_VERDICT, type Health, type HealthOf } from '../api/liveness';
import type { LiveStatus } from '../api/liveStatus';

/**
 * The studio's one view of the running system (2026-10-10): which workflows run, how every processor is, and how the
 * studio hears about it. Fed by BaseApi's liveness hub (SignalR) and, while that is not connected, by one app-wide poll
 * of the two GET endpoints. Not kept across a refresh: it is read afresh.
 */

/** How live updates reach the studio: connected to the hub, reconnecting after losing it, not connected yet / given up for now. */
export type Connection = 'connecting' | 'connected' | 'reconnecting' | 'offline';

/** What the studio knows of one half of the state: nothing yet, an answer, or the last answer failed (unknown). */
export type Knowledge = 'checking' | 'known' | 'unknown';

/** One processor as the hub or `GET /processors/liveness` reports it (judged as the start gate judges). */
export interface ProcessorLive { live: boolean; healthy: number; replicas: number; reason: string | null }

export interface LiveState {
  connection: Connection;
  workflows: Knowledge;
  /** Running workflow ids, lower case. Null until the first answer; kept while unknown (the baseline for the next change). */
  running: ReadonlySet<string> | null;
  processorsKnown: Knowledge;
  /** By processor id, lower case. */
  processors: ReadonlyMap<string, ProcessorLive>;
  /** The sequence number of the last hub change applied; null while not following the hub. */
  seq: number | null;
}

export const INITIAL_LIVE: LiveState = {
  connection: 'connecting', workflows: 'checking', running: null, processorsKnown: 'checking', processors: new Map(), seq: null,
};

/** A workflow that started or stopped, as Output logs it. */
export interface WorkflowChange { workflowId: string; running: boolean }

/** The hub's snapshot (`Snapshot()`), as sent: ids as BaseApi spells them. */
export interface HubSnapshot {
  sequence: number;
  known: boolean;
  runningWorkflowIds: string[];
  processors: { processorId: string; live: boolean; healthy: number; replicas: number; reason: string | null }[];
}

export type LiveEvent =
  | { type: 'connection'; connection: Connection }
  | { type: 'snapshot'; snapshot: HubSnapshot }
  | { type: 'workflowLive'; workflowId: string; running: boolean; sequence: number }
  | { type: 'processorLiveness'; processorId: string; live: boolean; healthy: number; replicas: number; reason: string | null; removed: boolean; sequence: number }
  | { type: 'monitorStatus'; known: boolean; sequence: number }
  /** The fallback poll's two answers. */
  | { type: 'poll'; live: ApiResult<unknown>; liveness: ApiResult<unknown> };

const lower = (id: string) => id.toLowerCase();

/** The workflows that started and stopped between two known sets (none from nothing: the first answer is no change). */
function changesBetween(before: ReadonlySet<string> | null, after: ReadonlySet<string>): WorkflowChange[] {
  if (before === null) return [];
  const changes: WorkflowChange[] = [];
  for (const id of after) if (!before.has(id)) changes.push({ workflowId: id, running: true });
  for (const id of before) if (!after.has(id)) changes.push({ workflowId: id, running: false });
  return changes;
}

/** `GET /orchestration/live` read defensively: the ids, or null when the answer is not a list (status unknown). */
export function runningOf(result: ApiResult<unknown>): Set<string> | null {
  if (!result.ok || !Array.isArray(result.value)) return null;
  return new Set(result.value.filter((e): e is string => typeof e === 'string').map(lower));
}

const reasonOf = (e: Record<string, unknown>, live: boolean): string | null => {
  if (live) return null;
  const n = (k: string) => (typeof e[k] === 'number' ? e[k] as number : 0);
  return `no healthy replica (${n('replicas')} checked: ${n('absent')} absent, ${n('unhealthy')} unhealthy, ${n('stale')} stale, ${n('malformed')} malformed)`;
};

/**
 * `GET /processors/liveness` read defensively (spec §5.1): entries without a string `processorId` and a boolean `live`
 * are skipped; null when the answer is not a list. The reason is the start gate's wording, rebuilt from the counts.
 */
export function processorsOf(result: ApiResult<unknown>): Map<string, ProcessorLive> | null {
  if (!result.ok || !Array.isArray(result.value)) return null;
  const map = new Map<string, ProcessorLive>();
  for (const entry of result.value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.processorId !== 'string' || typeof e.live !== 'boolean') continue;
    map.set(lower(e.processorId), {
      live: e.live, healthy: typeof e.healthy === 'number' ? e.healthy : 0, replicas: typeof e.replicas === 'number' ? e.replicas : 0, reason: reasonOf(e, e.live),
    });
  }
  return map;
}

/**
 * Pure: the state after one event, and the workflows that started or stopped with it. Sequence numbers are the
 * client's business (liveClient.ts): an event that reaches here is applied.
 */
export function liveReduce(state: LiveState, event: LiveEvent): { state: LiveState; changes: WorkflowChange[] } {
  switch (event.type) {
    case 'connection':
      return { state: state.connection === event.connection ? state : { ...state, connection: event.connection, seq: event.connection === 'connected' ? state.seq : null }, changes: [] };
    case 'snapshot': {
      const s = event.snapshot;
      // an unknown snapshot's lists are only what the hub last read (or nothing): the baseline stays ours
      if (!s.known) return { state: { ...state, workflows: 'unknown', processorsKnown: 'unknown', seq: s.sequence }, changes: [] };
      const running = new Set(s.runningWorkflowIds.map(lower));
      const processors = new Map(s.processors.map((p) => [lower(p.processorId), { live: p.live, healthy: p.healthy, replicas: p.replicas, reason: p.reason }] as const));
      return { state: { ...state, workflows: 'known', running, processorsKnown: 'known', processors, seq: s.sequence }, changes: changesBetween(state.running, running) };
    }
    case 'workflowLive': {
      // a change needs a baseline: before the first snapshot only the snapshot can say what runs
      if (state.running === null) return { state: { ...state, seq: event.sequence }, changes: [] };
      const id = lower(event.workflowId);
      const running = new Set(state.running);
      if (event.running) running.add(id); else running.delete(id);
      return { state: { ...state, running, workflows: 'known', seq: event.sequence }, changes: changesBetween(state.running, running) };
    }
    case 'processorLiveness': {
      const processors = new Map(state.processors);
      if (event.removed) processors.delete(lower(event.processorId));
      else processors.set(lower(event.processorId), { live: event.live, healthy: event.healthy, replicas: event.replicas, reason: event.reason });
      return { state: { ...state, processors, seq: event.sequence }, changes: [] };
    }
    case 'monitorStatus':
      // known again: the client takes a snapshot, which brings the state; unknown: shown as the poll's failure is
      return { state: event.known ? { ...state, seq: event.sequence } : { ...state, workflows: 'unknown', processorsKnown: 'unknown', seq: event.sequence }, changes: [] };
    case 'poll': {
      const running = runningOf(event.live);
      const processors = processorsOf(event.liveness);
      const next: LiveState = {
        ...state,
        ...(running ? { running, workflows: 'known' as const } : { workflows: 'unknown' as const }),
        ...(processors ? { processors, processorsKnown: 'known' as const } : { processorsKnown: 'unknown' as const }),
      };
      return { state: next, changes: running ? changesBetween(state.running, running) : [] };
    }
  }
}

/** A workflow's run status as its toolbar and hub show it (spec §6.1). */
export function statusOf(state: LiveState, workflowId: string): LiveStatus {
  if (state.workflows === 'checking') return 'checking';
  if (state.workflows === 'unknown' || state.running === null) return 'unknown';
  return state.running.has(lower(workflowId)) ? 'running' : 'stopped';
}

/** A processor's health as its art shows it (spec §5.1): no answer, or not listed, is undetermined. */
export function healthIn(state: LiveState, processorId: string): Health {
  if (state.processorsKnown !== 'known') return 'undetermined';
  const p = state.processors.get(lower(processorId));
  return p === undefined ? 'undetermined' : p.live ? 'healthy' : 'unhealthy';
}

/** Every processor's health, for the canvas (one function per processors map). */
export function healthFn(state: LiveState): HealthOf {
  if (state.processorsKnown !== 'known') return NO_VERDICT;
  return (processorId) => healthIn(state, processorId);
}

/** Live updates are not reaching the studio from the hub: the status area says so, and the fallback poll runs. */
export const pushDown = (state: LiveState): boolean => state.connection !== 'connected';
