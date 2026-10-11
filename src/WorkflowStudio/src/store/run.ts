/** Start or Stop: both act on the workflow BaseApi holds, never on the drawing (2026-10-09). */
export type RunOp = 'start' | 'stop';

/**
 * A Start or Stop in progress: being sent, or accepted (202) and waiting for the live set to agree. `token` tells an
 * answer or a timeout of this press from one of an earlier press.
 */
export interface RunState { op: RunOp; phase: 'sending' | 'waiting'; token: string }

/**
 * How long an accepted Start waits to appear in the live set (or a Stop to leave it) before Output says
 * it did not. A start whose message the control queue parks is accepted and never shows there (BaseApi's known gap).
 */
export const RUN_TIMEOUT_MS = 30_000;

/** Why a new workflow (2026-10-10) cannot be started, stopped or deleted before its first Save creates it. */
export const NOT_SAVED_YET = 'Not saved yet: BaseApi has no such workflow';

export const RUN_WORD: Readonly<Record<RunOp, string>> = { start: 'Start', stop: 'Stop' };

/**
 * Why Start or Stop cannot be pressed now, or null when it can. Never the live status (the user's rule, 2026-10-10):
 * both are idempotent in BaseApi, and a Start of a running workflow re-projects what BaseApi holds now (a Save takes
 * effect without a Stop). Only a loaded workflow BaseApi has (a new one waits for its first Save, 2026-10-10), no Save
 * under way, one press at a time.
 */
/** Why the drawn document waits (2026-10-11): its design is locked while the AI draws it. */
export const AI_DRAWING = 'The AI is drawing this workflow; Cancel it first';

export function runBlocked(doc: { status: { kind: string }; run: RunState | null; saving: boolean; drawing?: boolean; virtual?: boolean }): string | null {
  if (doc.virtual) return NOT_SAVED_YET;
  if (doc.status.kind !== 'ready') return 'The workflow is not loaded';
  if (doc.saving) return 'Saving…';
  if (doc.drawing) return AI_DRAWING;
  if (doc.run !== null) return doc.run.op === 'start' ? 'Starting…' : 'Stopping…';
  return null;
}
