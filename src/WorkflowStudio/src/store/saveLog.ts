import type { Draft } from '../design/draft';
import type { DesignError } from '../model/graph';
import { plural, type OutputLevel } from './output';

/** One line of BaseApi's own account of a design save (`DesignOutcomeDto.log`). */
export interface DesignLogLine { stage: string; level: OutputLevel; kind: string; id: string | null; message: string }

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
  reread: { ok: true; steps: number; links: number } | { ok: false; message: string };
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
}

/** "Save started": what goes to BaseApi in the request. */
export function saveStartText(sent: SentDesign): string {
  const parts: string[] = [];
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
  return parts.length === 0 ? 'Save started: sending the layout only' : `Save started: sending ${parts.join(', ')} and the layout`;
}

/** The answer's one-line verdict, as Output has always said it (plan 8 §4.1, plan 9 §7). */
export function saveVerdict(applied: boolean, errors: number, shorts: number, held: number): string {
  if (!applied) return `Saved; not applied: ${plural(errors, 'error')}`;
  if (shorts === 0) return 'Saved and applied';
  return `Saved and applied; ${plural(shorts, 'short circuit')} not written${held === 0 ? '' : `; ${plural(held, 'link')} held back until fixed`}`;
}

/**
 * Output's lines for an answered Save, in order: BaseApi's log, the verdict, the re-read, then how the drawing and the
 * database were aligned (short circuits held back, settling, what stays stored). Errors are red.
 */
export function saveAnswerLines(f: SaveFacts): { text: string; level: OutputLevel }[] {
  const out: { text: string; level: OutputLevel }[] = [];
  if (f.log !== null) {
    for (const l of f.log) out.push({ text: `BaseApi · ${l.message}`, level: l.level });
  } else {
    out.push({ text: 'BaseApi sent no step-by-step log (an older BaseApi)', level: 'info' });
    for (const e of f.errors) out.push({ text: `BaseApi · ${e.kind} ${e.id}: ${e.field ? `${e.field}: ` : ''}${e.message}`, level: 'error' });
  }
  out.push({ text: saveVerdict(f.applied, f.errors.length + f.shorts, f.shorts, f.held), level: f.applied ? 'info' : 'error' });
  if (!f.reread.ok) {
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
  return out;
}

/** How settling changed a draft's circuit: wires whose ends or shape changed, wires it added, wires it removed. */
export function settleReport(before: Draft, after: Draft): SettleReport | null {
  if (before.wires === null && after.wires === null) return null;
  const a = before.wires ?? {};
  const b = after.wires ?? {};
  let changed = 0, added = 0, removed = 0;
  for (const id of Object.keys(b)) {
    if (!Object.hasOwn(a, id)) added++;
    else if (JSON.stringify(a[id]) !== JSON.stringify(b[id])) changed++;
  }
  for (const id of Object.keys(a)) if (!Object.hasOwn(b, id)) removed++;
  return { changed, added, removed };
}
