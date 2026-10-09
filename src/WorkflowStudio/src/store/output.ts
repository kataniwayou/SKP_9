import type { Id } from '../model/graph';

/** An Output line's weight: an error line is drawn red. */
export type OutputLevel = 'info' | 'error';

/** One line of Output (2026-10-09: the only message pane): when, which workflow, what happened. */
export interface OutputLine {
  /** ISO time of the event. */
  at: string;
  workflowId: Id;
  /** The workflow's name when the line was written. */
  name: string;
  text: string;
  level: OutputLevel;
}

/** A line before it is given its workflow's name (the reducer knows the name). */
export interface LineDraft { at: string; text: string; level?: OutputLevel }

/** Output keeps the last 500 lines; older ones go first. */
export const OUTPUT_LIMIT = 500;

/** The lines with `more` after them, the oldest dropped beyond the limit. */
export function appendOutput(lines: readonly OutputLine[], more: readonly OutputLine[]): OutputLine[] {
  if (more.length === 0) return lines as OutputLine[];
  const all = [...lines, ...more];
  return all.length > OUTPUT_LIMIT ? all.slice(all.length - OUTPUT_LIMIT) : all;
}

/** Output lines read back from a session: anything that is not a line is skipped, the limit applies. */
export function parseOutput(value: unknown): OutputLine[] {
  if (!Array.isArray(value)) return [];
  const lines: OutputLine[] = [];
  for (const l of value) {
    if (typeof l !== 'object' || l === null) continue;
    const r = l as Record<string, unknown>;
    if (typeof r.at !== 'string' || typeof r.workflowId !== 'string' || typeof r.name !== 'string' || typeof r.text !== 'string') continue;
    lines.push({ at: r.at, workflowId: r.workflowId, name: r.name, text: r.text, level: r.level === 'error' ? 'error' : 'info' });
  }
  return lines.slice(-OUTPUT_LIMIT);
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
export { plural };
