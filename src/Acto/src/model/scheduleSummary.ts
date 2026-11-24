import type { WorkflowRow } from '../design/board';

/** The server's EntrySchedule normalisation: trim, then collapse whitespace runs. */
export const normaliseCron = (cron: string): string => cron.trim().replace(/\s+/g, ' ');

/** The distinct normalised crons of a workflow's entry arrows (entries without one are ignored). */
export function distinctCrons(w: WorkflowRow): string[] {
  const out = new Set<string>();
  for (const c of Object.values(w.entryCrons)) {
    const n = normaliseCron(c);
    if (n) out.add(n);
  }
  return [...out];
}

/** One line for a workflow's whole schedule: its shared cron, "<n> schedules" when they differ, or "not scheduled". */
export function scheduleSummary(w: WorkflowRow): string {
  const d = distinctCrons(w);
  return d.length === 0 ? '⏱ not scheduled' : d.length === 1 ? `⏱ ${d[0]}` : `⏱ ${d.length} schedules`;
}
