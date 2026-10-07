import type { StudioDocument } from '../app/document';
import { WORKFLOW_SOURCE, type SourceId } from '../layout/ports';
import type { Id } from '../model/graph';

export type DropVerdict = 'ok' | 'self' | 'duplicate' | 'cycle' | 'notStep';
export type JoinVerdict = 'ok' | 'colour' | 'sameWire' | 'loop';
/** Drops a line never takes: a wire's start, and a new wire (it must reach a step first). */
export type Refusal = 'start' | 'needStep';

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

/** May wire `wire`'s arrow end on `host`'s line (plan 7 §1)? The same colour, not itself, no loop through hosts. */
export function canJoin(shown: StudioDocument, wire: string, host: string): JoinVerdict {
  if (wire === host) return 'sameWire';
  const byId = new Map(shown.wires.map((w) => [w.id, w]));
  const w = byId.get(wire), h = byId.get(host);
  if (!w || !h || w.condition !== h.condition) return 'colour';
  const seen = new Set<string>();
  let x: typeof h | undefined = h;
  while (x?.joint) {
    if (x.joint.host === wire) return 'loop';
    if (seen.has(x.id)) break;
    seen.add(x.id);
    x = byId.get(x.joint.host);
  }
  return 'ok';
}

/** What the pointer's label says over a block while a wire end or a new wire is dragged (plan 4 trial). */
export function dropLabel(verdict: DropVerdict | 'move' | JoinVerdict | Refusal, newWire: boolean, line = false): string {
  switch (verdict) {
    case 'ok': return line ? 'join here' : newWire ? 'connect here' : 're-attach here';
    case 'move': return 'move contact here';
    case 'cycle': return 'would make a loop';
    case 'loop': return 'would make a loop';
    case 'duplicate': return 'already wired';
    case 'self': return 'same step';
    case 'notStep': return 'not a step';
    case 'colour': return 'other colour';
    case 'sameWire': return 'same wire';
    case 'start': return 'start stays on a block';
    case 'needStep': return 'drop on a step';
  }
}
