import type { StudioDocument } from '../app/document';
import { applyDesign } from '../design/apply';
import { isShortCircuitError, shortCircuitErrors } from '../design/shortCircuits';
import { wireName } from '../design/wireName';
import { entityName } from '../model/entityNames';
import type { DesignError, Graph } from '../model/graph';
import type { OpenDocument } from './studioState';

/** The drawing as it is now: the loaded workflow with the design (blocks, entity edits, canvas draft) laid over it; null until it is ready. */
export const shownDesignOf = (doc: OpenDocument | null): StudioDocument | null =>
  (doc?.status.kind === 'ready' ? applyDesign(doc.status.doc, doc.design.draft, doc.edits) : null);

/**
 * A document's current problems (plan 8 §4.1; plan 9 §2.2-7): the design's short circuits while they last, then the
 * errors of its last Save. Opening a workflow runs no dry run and errors are never stored, so only a short circuit
 * shows then. Output pins exactly this list and the chat reads it too (2026-10-23), so they cannot disagree.
 * `shown` is `shownDesignOf(doc)`, passed in by a caller that keeps it.
 */
export function problemsFrom(doc: OpenDocument | null, shown: StudioDocument | null): DesignError[] {
  if (doc === null || doc.status.kind !== 'ready') return [];
  const live = shown ? shortCircuitErrors(shown, doc.design.draft) : [];
  return [...live, ...(doc.errors ?? []).filter((e) => !isShortCircuitError(e))];
}

export const problemsOf = (doc: OpenDocument | null): DesignError[] => problemsFrom(doc, shownDesignOf(doc));

/**
 * The entity a problem names, by its unique name when this canvas holds it (or the workflow as loaded does: a step or cache
 * deleted in the design, 2026-10-10), else by its id; a wire as the Inspector names it.
 */
export function entityLabel(e: DesignError, graph: Graph, shown: StudioDocument | null, loaded: Graph): string {
  const named = (x: { name: string; version: string; id: string } | undefined) => (x ? entityName(x.name, x.version, x.id) : e.id);
  switch (e.kind) {
    case 'wire': return wireName(shown, e.id) ?? e.id;
    case 'workflow': return named(graph.workflow);
    case 'step': return named(graph.steps.get(e.id) ?? loaded.steps.get(e.id));
    case 'processor': return named(graph.processors.get(e.id));
    case 'cache': return named(graph.caches.get(e.id) ?? loaded.caches.get(e.id));
    default: return e.id;
  }
}
