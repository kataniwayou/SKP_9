import type { StudioDocument } from '../app/document';
import { WORKFLOW_SOURCE, type SourceId } from '../layout/ports';
import type { Id } from '../model/graph';

export type DropVerdict = 'ok' | 'self' | 'duplicate' | 'cycle' | 'notStep';

/**
 * May a wire from `source` to `target` exist in the shown document (spec §4.6)? `moving` is the id of the
 * wire whose end is being dragged: it is judged as if that wire were gone. A target is a step; a source
 * is a step or the hub. Refused: a self-loop, a duplicate, and a cycle (the target already reaches the
 * source). Entry wires never close a cycle.
 */
export function canWire(shown: StudioDocument, source: SourceId, target: string, moving?: string): DropVerdict {
  const { graph } = shown;
  if (target === WORKFLOW_SOURCE || !graph.steps.has(target)) return 'notStep';
  if (source !== WORKFLOW_SOURCE && !graph.steps.has(source)) return 'notStep';
  if (source === target) return 'self';
  const targetsOf = (id: SourceId): Id[] => {
    const list = id === WORKFLOW_SOURCE ? graph.workflow.entryStepIds : graph.steps.get(id)?.nextStepIds ?? [];
    return list.filter((t) => `${id}->${t}` !== moving);
  };
  if (targetsOf(source).includes(target)) return 'duplicate';
  if (source === WORKFLOW_SOURCE) return 'ok';
  const seen = new Set<Id>();
  const stack: Id[] = [target];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === source) return 'cycle';
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...targetsOf(id));
  }
  return 'ok';
}

/** What the pointer's label says over a block while a wire end or a new wire is dragged (plan 4 trial). */
export function dropLabel(verdict: DropVerdict, newWire: boolean): string {
  switch (verdict) {
    case 'ok': return newWire ? 'connect here' : 're-attach here';
    case 'cycle': return 'would make a loop';
    case 'duplicate': return 'already wired';
    case 'self': return 'same step';
    case 'notStep': return 'not a step';
  }
}
