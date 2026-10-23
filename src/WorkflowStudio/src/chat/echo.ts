import type { Id } from '../model/graph';
import type { OutputLine } from '../store/output';
import { entityLabel, problemsOf, shownDesignOf } from '../store/problems';
import { RUN_TIMEOUT_MS } from '../store/run';
import type { StudioStore } from '../store/studioStore';
import type { ChatEntry } from './chatStore';

// The chat user never watches Output (2026-10-23), so every Output line an action causes is repeated in the chat and
// handed to the model, with the pinned problems when the action changed them.

/** The pinned problems of the workflows, one readable line each ("entity field: message"), as Output pins them. */
function problemLines(store: StudioStore, ids: readonly Id[]): string[] {
  const lines: string[] = [];
  for (const id of ids) {
    const doc = store.getState().docs.find((d) => d.workflowId === id) ?? null;
    if (doc === null || doc.status.kind !== 'ready') continue;
    const shown = shownDesignOf(doc);
    const loaded = doc.status.doc.graph;
    for (const e of problemsOf(doc)) {
      lines.push(`${entityLabel(e, (shown ?? doc.status.doc).graph, shown, loaded)}${e.field ? ` ${e.field}` : ''}: ${e.message}`);
    }
  }
  return lines;
}

/** The Output lines appended after `last` (all of them when `last` has already been trimmed away). */
function linesAfter(output: readonly OutputLine[], last: OutputLine | undefined): OutputLine[] {
  const at = last === undefined ? -1 : output.lastIndexOf(last);
  return output.slice(at + 1);
}

/**
 * Runs `act`, then collects the Output lines written for the touched workflows while it ran, and, when `until` is given,
 * until it holds (or `timeoutMs`). The pinned problems of those workflows before and after are compared: a `problems`
 * entry follows the lines when they differ. `workflowIds` is read before and after, a new workflow having no id before.
 */
export async function withEcho<T>(
  store: StudioStore, workflowIds: () => Id[], act: () => Promise<T>, until?: () => boolean, timeoutMs: number = RUN_TIMEOUT_MS,
): Promise<{ value: T; entries: ChatEntry[] }> {
  const last = store.getState().output.at(-1);
  const idsBefore = workflowIds();
  const problemsBefore = problemLines(store, idsBefore);
  const value = await act();
  if (until && !until()) {
    await new Promise<void>((resolve) => {
      let stop = (): void => {};
      const timer = setTimeout(() => { stop(); resolve(); }, timeoutMs);
      stop = store.subscribe(() => { if (until()) { clearTimeout(timer); stop(); resolve(); } });
    });
  }
  const ids = new Set([...idsBefore, ...workflowIds()].map((i) => i.toLowerCase()));
  const entries: ChatEntry[] = linesAfter(store.getState().output, last)
    .filter((l) => ids.has(l.workflowId.toLowerCase()))
    .map((l) => ({ kind: 'output', text: l.text, level: l.level, name: l.name }));
  const problemsAfter = problemLines(store, [...ids]);
  if (JSON.stringify(problemsBefore) !== JSON.stringify(problemsAfter)) entries.push({ kind: 'problems', lines: problemsAfter });
  return { value, entries };
}

/** What the model hears of the echo: the Output lines (errors marked) and the problems that changed. */
export function echoText(entries: readonly ChatEntry[]): string {
  const parts: string[] = [];
  for (const e of entries) {
    if (e.kind === 'output') parts.push(e.level === 'error' ? `[error] ${e.text}` : e.text);
    else if (e.kind === 'problems') parts.push(e.lines.length === 0 ? 'Problems now: none' : `Problems now:\n${e.lines.map((l) => `- ${l}`).join('\n')}`);
  }
  return parts.join('\n');
}

/** True when an echoed Output line is an error. */
export const hasErrorLine = (entries: readonly ChatEntry[]): boolean => entries.some((e) => e.kind === 'output' && e.level === 'error');
