import type { Id } from '../model/graph';

/**
 * What the operator clicked on a document's canvas (spec §6.1). A processor is selected through
 * the die of one particular step, so the highlight lands on that die only. Nothing else is
 * selectable in slice 3a: wires, junctions and multi-select come with canvas editing.
 */
export type Selection =
  | { kind: 'workflow' }
  | { kind: 'step'; stepId: Id }
  | { kind: 'processor'; processorId: Id; stepId: Id }
  | { kind: 'cache'; cacheId: Id };

/** A stable string for a selection, for equality and for "did the Inspector's content change". */
export function selectionKey(selection: Selection | null): string {
  if (selection === null) return 'none';
  switch (selection.kind) {
    case 'workflow': return 'workflow';
    case 'step': return `step:${selection.stepId}`;
    case 'processor': return `processor:${selection.processorId}@${selection.stepId}`;
    case 'cache': return `cache:${selection.cacheId}`;
  }
}
