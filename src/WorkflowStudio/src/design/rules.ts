import type { StudioDocument } from '../app/document';
import { WORKFLOW_SOURCE, type SourceId } from '../layout/ports';

/** `loose`: the drop attaches to nothing and the wire becomes loose there (plan 8 §5); `cannotStart`: a tail over such a place (it snaps back). */
export type DropVerdict = 'ok' | 'self' | 'loose' | 'cannotStart';
export type JoinVerdict = 'ok' | 'sameWire' | 'loose';
/** A wire's start never joins a line. */
export type Refusal = 'start';

/**
 * May a wire from `source` to `target` exist in the shown document (plan 8 §5)? `moving` is the wire whose
 * end is dragged: it is judged as if gone. A block wired to itself is refused (`self`, it snaps back; the hub
 * too, decision 11); a target that is not a step (a cache, the hub) or a wire that already exists makes the wire loose. Cycles
 * are allowed: a design may be anything, and starting is when cycles are judged.
 */
export function canWire(shown: StudioDocument, source: SourceId, target: string, moving?: string): DropVerdict {
  const { graph } = shown;
  // first: back on its own source (a step or the hub) a wire snaps back, never loose (decision 11)
  if (source === target) return 'self';
  if (target === WORKFLOW_SOURCE || !graph.steps.has(target)) return 'loose';
  if (source !== WORKFLOW_SOURCE && !graph.steps.has(source)) return 'loose';
  const list = source === WORKFLOW_SOURCE ? graph.workflow.entryStepIds : graph.steps.get(source)?.nextStepIds ?? [];
  if (list.some((t) => t === target && `${source}->${t}` !== moving)) return 'loose';
  return 'ok';
}

/** May wire `wire`'s arrow end on `host`'s line (plan 7 §1)? Not itself; another colour or a loop through hosts makes the wire loose (plan 8 §5). */
export function canJoin(shown: StudioDocument, wire: string, host: string): JoinVerdict {
  if (wire === host) return 'sameWire';
  const byId = new Map(shown.wires.map((w) => [w.id, w]));
  const w = byId.get(wire), h = byId.get(host);
  if (!w || !h || w.condition !== h.condition) return 'loose';
  const seen = new Set<string>();
  let x: typeof h | undefined = h;
  while (x?.joint) {
    if (x.joint.host === wire) return 'loose';
    if (seen.has(x.id)) break;
    seen.add(x.id);
    x = byId.get(x.joint.host);
  }
  return 'ok';
}

/** What the pointer's label says over a block or a wire's line while a wire end or a new wire is dragged (plan 4 trial, plan 7). */
export function dropLabel(verdict: DropVerdict | 'move' | 'here' | JoinVerdict | Refusal, newWire: boolean, line = false): string {
  switch (verdict) {
    case 'ok': return line ? 'join here' : newWire ? 'connect here' : 're-attach here';
    case 'move': return 'move contact here';
    case 'here': return 'starts here';
    case 'self': return 'same step';
    case 'sameWire': return 'same wire';
    case 'loose': return 'loose wire';
    case 'cannotStart': return 'cannot start here';
    case 'start': return 'start stays on a block';
  }
}
