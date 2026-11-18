import type { Connection } from '@xyflow/react';
import type { BoardState } from '../design/board';

export type ConnectionKind = 'wire' | 'entry' | 'cacheLink';

/** Node ids: `wf:<id>`, `st:<id>`, `ca:<id>`. */
export const nodeId = (kind: 'workflow' | 'step' | 'cache', id: string) => `${kind === 'workflow' ? 'wf' : kind === 'step' ? 'st' : 'ca'}:${id}`;
export function itemOfNode(node: string): { kind: 'workflow' | 'step' | 'cache'; id: string } | null {
  const i = node.indexOf(':');
  const tag = node.slice(0, i);
  const kind = tag === 'wf' ? 'workflow' : tag === 'st' ? 'step' : tag === 'ca' ? 'cache' : null;
  return kind ? { kind, id: node.slice(i + 1) } : null;
}

/**
 * What a connection React Flow offers would make: out → in on two steps a wire, tip → in on a step an entry arrow,
 * back → in on a cache a cache link; anything else (or an item the board does not have) null. The React Flow
 * `isValidConnection`, and what `onConnect` branches on.
 */
export function connectionKind(c: Pick<Connection, 'source' | 'target' | 'sourceHandle' | 'targetHandle'>, b: BoardState): ConnectionKind | null {
  const a = itemOfNode(c.source);
  const t = itemOfNode(c.target);
  if (!a || !t) return null;
  if (a.kind === 'step' && c.sourceHandle === 'out' && t.kind === 'step' && c.targetHandle === 'in') return b.steps[a.id] && b.steps[t.id] ? 'wire' : null;
  if (a.kind === 'workflow' && c.sourceHandle === 'tip' && t.kind === 'step' && c.targetHandle === 'in') return b.workflows[a.id] && b.steps[t.id] ? 'entry' : null;
  if (a.kind === 'workflow' && c.sourceHandle === 'back' && t.kind === 'cache' && c.targetHandle === 'in') return b.workflows[a.id] && b.caches[t.id] ? 'cacheLink' : null;
  return null;
}
