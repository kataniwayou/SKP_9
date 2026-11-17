import type { LiveStatus } from '../api/liveStatus';
import type { Id } from '../model/graph';
import type { Pick } from './picks';

export type Bar =
  | { kind: 'parts'; count: number }
  | { kind: 'workflows'; count: number; start: Id[]; stop: Id[]; save: Id[] }
  | { kind: 'mixed'; count: number };

/** What the selection bar offers for several picks; null for fewer than two (a toolbar does that). */
export function barOf(picks: readonly Pick[], status: (wf: Id) => { run: LiveStatus; unsaved: boolean }): Bar | null {
  if (picks.length < 2) return null;
  const count = picks.length;
  if (picks.every((p) => p.kind !== 'workflow')) return { kind: 'parts', count };
  if (picks.some((p) => p.kind !== 'workflow')) return { kind: 'mixed', count };
  const start: Id[] = []; const stop: Id[] = []; const save: Id[] = [];
  for (const p of picks) {
    const s = status(p.workflowId);
    if (s.run === 'running') stop.push(p.workflowId);
    else if (s.run === 'stopped') start.push(p.workflowId);
    if (s.unsaved) save.push(p.workflowId);
  }
  return { kind: 'workflows', count, start, stop, save };
}
