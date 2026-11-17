import type { Point } from '../model/geometry';
import type { BoardWorkflow } from './loadBoard';
import { HEADER_H, STEP_H, STEP_W } from './geometry';

export type DropItem =
  | { kind: 'workflow' }
  | { kind: 'cache-new' }
  | { kind: 'step'; processorId: string }
  | { kind: 'cache'; cacheId: string };

export type DropVerdict =
  | { do: 'newWorkflow'; at: Point }
  | { do: 'addStep'; workflowId: string; at: Point }
  | { do: 'swap'; workflowId: string; stepId: string }
  | { do: 'newCache'; workflowId: string }
  | { do: 'linkCache'; workflowId: string; cacheId: string }
  | { refused: string };

const frameAt = (boards: BoardWorkflow[], at: Point) =>
  boards.find((b) => at.x >= b.frame.x && at.x <= b.frame.x + b.frame.w && at.y >= b.frame.y && at.y <= b.frame.y + b.frame.h);

function stepIn(frame: BoardWorkflow, at: Point): string | null {
  const rel = { x: at.x - frame.frame.x, y: at.y - frame.frame.y - HEADER_H };
  for (const stepId of frame.stepIds) {
    const p = frame.stepAt.get(stepId);
    if (p && rel.x >= p.x && rel.x <= p.x + STEP_W && rel.y >= p.y && rel.y <= p.y + STEP_H) return stepId;
  }
  return null;
}

/** The step card under the board point `at`, or null. */
export function stepAt(boards: BoardWorkflow[], at: Point): { workflowId: string; stepId: string } | null {
  const frame = frameAt(boards, at);
  const stepId = frame ? stepIn(frame, at) : null;
  return frame && stepId !== null ? { workflowId: frame.graph.workflow.id, stepId } : null;
}

/** What dropping `item` at `at` (board coordinates) does. A step's `at` is relative to its frame's content area. */
export function dropVerdict(item: DropItem, at: Point, boards: BoardWorkflow[]): DropVerdict {
  const frame = frameAt(boards, at);
  if (!frame) {
    return item.kind === 'workflow' ? { do: 'newWorkflow', at } : { refused: item.kind === 'step' ? 'Drop a step inside a workflow' : 'Drop a cache inside a workflow' };
  }
  const workflowId = frame.graph.workflow.id;
  switch (item.kind) {
    case 'workflow':
      return { refused: 'Drop a new workflow on empty board' };
    case 'step': {
      const stepId = stepIn(frame, at);
      if (stepId !== null) return { do: 'swap', workflowId, stepId };
      const rel = { x: at.x - frame.frame.x, y: at.y - frame.frame.y - HEADER_H };
      return { do: 'addStep', workflowId, at: { x: Math.max(0, rel.x), y: Math.max(0, rel.y) } };
    }
    case 'cache-new':
      return { do: 'newCache', workflowId };
    case 'cache': {
      if (frame.graph.workflow.cacheIds.includes(item.cacheId)) {
        const name = frame.graph.caches.get(item.cacheId)?.name ?? item.cacheId;
        return { refused: `${name} is already linked to ${frame.graph.workflow.name}` };
      }
      return { do: 'linkCache', workflowId, cacheId: item.cacheId };
    }
  }
}

/** Parses the `application/acto` payload of a drop; null when it is not one of ours. */
export function dropVerdictItem(raw: string): DropItem | null {
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (v.kind === 'workflow' || v.kind === 'cache-new') return { kind: v.kind };
    if (v.kind === 'step' && typeof v.processorId === 'string') return { kind: 'step', processorId: v.processorId };
    if (v.kind === 'cache' && typeof v.cacheId === 'string') return { kind: 'cache', cacheId: v.cacheId };
  } catch { /* not ours */ }
  return null;
}
