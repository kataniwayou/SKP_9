import { relationsOf, remainingProblemsOf } from '../ai/drawing';
import { applyDraft, applyEdits } from '../design/apply';
import { circuitOf } from '../design/draft';
import { shortCircuitErrors, writtenLists } from '../design/shortCircuits';
import { conditionInfo } from '../model/entryConditions';
import type { OpenDocument } from '../store/studioState';
import type { StudioStore } from '../store/studioStore';

// The browser suite's judge of a design (2026-10-23, the chat's proficiency check): what a drawing means, by step
// names, with the wand's own judges (relationsOf, remainingProblemsOf) and the short circuits, so a spec can tell
// whether the model built what it was asked and built it tidy. Test-only: installed in development, or on ?e2e.

export interface Judgement {
  workflow: string;
  steps: { id: string; name: string; entryCondition: string; processor: string | null; x: number; y: number; payload: string | null }[];
  /** "a -> b" by step names, sorted; "workflow -> a" for an entry. */
  links: string[];
  /** Wire ends lying on another wire (fan-in / fan-out junctions). */
  junctions: number;
  shorts: string[];
  problems: string[];
  /** relationsOf, by ids: what Save writes and the nets. */
  relations: string;
}

export function judgeOf(doc: OpenDocument): Judgement | null {
  if (doc.status.kind !== 'ready') return null;
  const draft = doc.design.draft;
  const edited = applyEdits(doc.status.doc, doc.edits, draft.blocks);
  const shown = applyDraft(edited, draft);
  const name = (id: string) => shown.graph.steps.get(id)?.name ?? id;
  const lists = writtenLists(edited, shown, draft);
  const links = [
    ...[...lists.entries].map((id) => `workflow -> ${name(id)}`),
    ...[...shown.graph.steps.keys()].flatMap((id) => [...lists.nextOf(id)].map((n) => `${name(id)} -> ${name(n)}`)),
  ].sort();
  const junctions = Object.values(circuitOf(edited, draft)).reduce((n, w) => n + (w.tail.on === 'wire' ? 1 : 0) + (w.head.on === 'wire' ? 1 : 0), 0);
  return {
    workflow: `${doc.name} ${doc.version}`,
    steps: [...shown.graph.steps.values()].map((s) => {
      const p = shown.placement.steps.get(s.id);
      return {
        id: s.id, name: s.name, entryCondition: conditionInfo(s.entryCondition).name,
        processor: s.processorId === null ? null : shown.graph.processors.get(s.processorId)?.name ?? s.processorId,
        x: p?.x ?? NaN, y: p?.y ?? NaN, payload: shown.graph.assignments.find((a) => a.stepId === s.id)?.payload ?? null,
      };
    }),
    links, junctions,
    shorts: shortCircuitErrors(shown, draft).map((e) => e.message),
    problems: remainingProblemsOf(edited, draft),
    relations: relationsOf(edited, draft),
  };
}

/** `window.__studioJudge()`: the active document's judgement; in development always, in a build only on a page opened with ?e2e. */
export function installE2eJudge(store: StudioStore, win: Window = window): void {
  const e2e = (() => { try { return new URLSearchParams(win.location.search).has('e2e'); } catch { return false; } })();
  if (!import.meta.env.DEV && !e2e) return;
  Object.assign(win, {
    __studioJudge: (): Judgement | null => {
      const s = store.getState();
      const doc = s.docs.find((d) => d.workflowId === s.activeId);
      return doc ? judgeOf(doc) : null;
    },
  });
}
