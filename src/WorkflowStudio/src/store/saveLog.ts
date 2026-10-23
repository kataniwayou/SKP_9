import type { StudioDocument } from '../app/document';
import { circuitOf, type Draft } from '../design/draft';
import type { DesignError } from '../model/graph';
import { plural, type OutputLevel } from './output';

/** One line of BaseApi's own account of a design save (`DesignOutcomeDto.log`). */
export interface DesignLogLine {
  stage: string; level: OutputLevel; kind: string; id: string | null; message: string;
  /** A change the dry run made and its rollback undid (BaseApi's `rolledBack`). */
  rolledBack?: boolean;
}

/** One Save's lines kept at most: the first SAVE_HEAD and the last SAVE_TAIL, an "omitted" line between. */
export const SAVE_HEAD = 60;
export const SAVE_TAIL = 120;

/** A Save's lines within the per-save bound: its head (start, first stages) and its tail (outcome, alignment) stay. */
export function boundSave<T extends { text: string }>(lines: T[], omitted: (n: number) => T): T[] {
  if (lines.length <= SAVE_HEAD + SAVE_TAIL + 1) return lines;
  const n = lines.length - SAVE_HEAD - SAVE_TAIL;
  return [...lines.slice(0, SAVE_HEAD), omitted(n), ...lines.slice(lines.length - SAVE_TAIL)];
}

/** What settling the re-read design did to the drawing (plan 9 §8): wires changed, added and removed. */
export interface SettleReport { changed: number; added: number; removed: number }

/** What the studio knows once a Save is answered and the workflow read again; Output is written from it. */
export interface SaveFacts {
  applied: boolean;
  /** BaseApi's errors (the design's own short circuits are counted in `shorts`). */
  errors: readonly DesignError[];
  /** BaseApi's log; null from a BaseApi that sends none. */
  log: readonly DesignLogLine[] | null;
  /** The design's short circuits when it was sent, and the links of the sources they held back. */
  shorts: number;
  held: number;
  /** The read after the answer: what came back, or why it failed. */
  reread: { ok: true; steps: number; links: number } | { ok: false; message: string } | { ok: false; created: false };
  /** What settling did; null when the drawing has no circuit of its own (the workflow's own wires). */
  settle: SettleReport | null;
  /** The workflow read back still stores a design (not applied). */
  stored: boolean;
}

/** The parts of the request Save sends (app/saveDesign.ts `DesignRequest`), as far as the log names them. */
export interface SentDesign {
  workflow: { fields: Record<string, unknown>; entryStepIds: unknown[] | null; cacheIds: unknown[] | null };
  steps: { fields: Record<string, unknown>; nextStepIds: unknown[] | null }[];
  processors: unknown[];
  caches: unknown[];
  schemas: unknown[];
  assignments: unknown[];
  newSteps?: unknown[];
  newCaches?: unknown[];
  deletedSteps?: unknown[];
  deletedCaches?: unknown[];
  newWorkflow?: unknown;
}

/** "Save started": what goes to BaseApi in the request. */
export function saveStartText(sent: SentDesign): string {
  const parts: string[] = [];
  // a new workflow (2026-10-10): BaseApi creates it first
  if (sent.newWorkflow !== undefined) parts.push('the new workflow to create');
  const wf = sent.workflow;
  if (Object.keys(wf.fields).length > 0) parts.push('the workflow\'s fields');
  if (wf.entryStepIds !== null) parts.push('the entry steps');
  if (wf.cacheIds !== null) parts.push('the workflow\'s caches');
  if (sent.steps.length > 0) {
    const rewired = sent.steps.filter((s) => s.nextStepIds !== null).length;
    parts.push(`${plural(sent.steps.length, 'step')}${rewired > 0 ? ` (${rewired} with new next steps)` : ''}`);
  }
  if (sent.processors.length > 0) parts.push(plural(sent.processors.length, 'processor'));
  if (sent.caches.length > 0) parts.push(plural(sent.caches.length, 'cache'));
  if (sent.schemas.length > 0) parts.push(plural(sent.schemas.length, 'schema copy', 'schema copies'));
  if (sent.assignments.length > 0) parts.push(plural(sent.assignments.length, 'assignment change'));
  // pasted and deleted blocks (2026-10-10)
  if (sent.newSteps?.length) parts.push(plural(sent.newSteps.length, 'new step'));
  if (sent.newCaches?.length) parts.push(plural(sent.newCaches.length, 'new cache'));
  if (sent.deletedSteps?.length) parts.push(plural(sent.deletedSteps.length, 'step to delete', 'steps to delete'));
  if (sent.deletedCaches?.length) parts.push(plural(sent.deletedCaches.length, 'cache to delete', 'caches to delete'));
  return parts.length === 0 ? 'Save started: sending the layout only' : `Save started: sending ${parts.join(', ')} and the layout`;
}

/** How an applied Save's verdict begins; the chat tells an applied Save by it. */
export const SAVED_APPLIED = 'Saved and applied';

/** The answer's one-line verdict, as Output has always said it (plan 8 §4.1, plan 9 §7). */
export function saveVerdict(applied: boolean, errors: number, shorts: number, held: number): string {
  if (!applied) return `Saved; not applied: ${plural(errors, 'error')}`;
  if (shorts === 0) return SAVED_APPLIED;
  return `${SAVED_APPLIED}; ${plural(shorts, 'short circuit')} not written${held === 0 ? '' : `; ${plural(held, 'link')} held back until fixed`}`;
}

/**
 * Output's lines for an answered Save, in order: BaseApi's log, the verdict, the re-read, then how the drawing and the
 * database were aligned (short circuits held back, settling, what stays stored). Errors are red.
 */
export function saveAnswerLines(f: SaveFacts): { text: string; level: OutputLevel }[] {
  const out: { text: string; level: OutputLevel }[] = [];
  if (f.log !== null) {
    for (const l of f.log) out.push({ text: `BaseApi · ${l.rolledBack ? '(rolled back) ' : ''}${l.message}`, level: l.level });
  } else {
    out.push({ text: 'BaseApi sent no step-by-step log (an older BaseApi)', level: 'info' });
    for (const e of f.errors) out.push({ text: `BaseApi · ${e.kind} ${e.id}: ${e.field ? `${e.field}: ` : ''}${e.message}`, level: 'error' });
  }
  out.push({ text: saveVerdict(f.applied, f.errors.length + f.shorts, f.shorts, f.held), level: f.applied ? 'info' : 'error' });
  if (!f.reread.ok && 'created' in f.reread) {
    // a new workflow BaseApi did not create (2026-10-10): nothing to read back, nothing stored
    out.push({ text: 'the new workflow was not created: nothing is stored in BaseApi; its design stays in the studio, unsaved', level: 'error' });
  } else if (!f.reread.ok) {
    out.push({ text: `graph could not be read again: ${f.reread.message}; the drawing keeps the design as it was sent`, level: 'error' });
  } else {
    out.push({ text: `graph re-read: ${plural(f.reread.steps, 'step')}, ${plural(f.reread.links, 'link')}`, level: 'info' });
  }
  if (f.shorts > 0) {
    const held = f.held === 0 ? 'no link held back (BaseApi keeps the ones it has)' : `${plural(f.held, 'link')} not written`;
    out.push({ text: `${plural(f.shorts, 'short circuit')} held back: ${held}`, level: 'error' });
  }
  if (f.reread.ok) {
    const s = f.settle;
    if (s === null) out.push({ text: 'drawing: the workflow\'s own wires, nothing to settle', level: 'info' });
    else if (s.changed + s.added + s.removed === 0) out.push({ text: 'drawing agrees with BaseApi\'s links', level: 'info' });
    else {
      const parts = ([[s.changed, 'changed'], [s.added, 'added'], [s.removed, 'removed']] as const)
        .filter(([n]) => n > 0).map(([n, w]) => `${plural(n, 'wire')} ${w}`);
      out.push({ text: `drawing settled to BaseApi's links: ${parts.join(', ')}`, level: 'info' });
    }
    out.push(f.stored
      ? { text: 'design stored on the workflow, not applied: the drawing shows the stored design', level: 'error' }
      : { text: 'nothing left stored: the entities hold the design, the layout is kept', level: 'info' });
  }
  return boundSave(out, (n) => ({ text: `… ${n} lines of this Save omitted`, level: 'info' as OutputLevel }));
}

/**
 * How settling changed the drawing: wires whose ends or shape changed, wires it added, wires it removed, comparing the
 * circuits as drawn (a draft with no circuit of its own draws the workflow's own wires, so settling one back to them
 * changes nothing). Null when neither draft has a circuit of its own.
 */
export function settleReport(doc: StudioDocument, before: Draft, after: Draft): SettleReport | null {
  if (before.wires === null && after.wires === null) return null;
  const a = circuitOf(doc, before);
  const b = circuitOf(doc, after);
  let changed = 0, added = 0, removed = 0;
  for (const id of Object.keys(b)) {
    if (!Object.hasOwn(a, id)) added++;
    else if (JSON.stringify(a[id]) !== JSON.stringify(b[id])) changed++;
  }
  for (const id of Object.keys(a)) if (!Object.hasOwn(b, id)) removed++;
  return { changed, added, removed };
}
