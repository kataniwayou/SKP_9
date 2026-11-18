import { CACHE_H, CACHE_W, STEP_H, STEP_W, TRIANGLE_H, TRIANGLE_W } from '../board/geometry';
import type { Pick } from '../board/selection';
import type { BoardState } from '../design/board';
import { addCache, addStep, addWorkflow } from '../design/edits';
import type { Point } from '../model/geometry';
import type { Id } from '../model/graph';

/** The data type a toolbox item carries in its drag. */
export const DRAG_TYPE = 'application/acto';

/** What a toolbox item carries: Create › Workflow, Create › Cache, or a step of one processor. */
export type ToolboxDrag = { kind: 'workflow' } | { kind: 'cache' } | { kind: 'step'; processorId: Id };

/** The drag's text back as a ToolboxDrag; null for anything else. */
export function parseToolboxDrag(raw: string): ToolboxDrag | null {
  try {
    const v = JSON.parse(raw) as { kind?: unknown; processorId?: unknown };
    if (v?.kind === 'workflow') return { kind: 'workflow' };
    if (v?.kind === 'cache') return { kind: 'cache' };
    if (v?.kind === 'step' && typeof v.processorId === 'string' && v.processorId) return { kind: 'step', processorId: v.processorId };
    return null;
  } catch {
    return null;
  }
}

const centred = (p: Point, w: number, h: number): Point => ({ x: Math.round(p.x - w / 2), y: Math.round(p.y - h / 2) });

/**
 * A drop anywhere on the board (spec §7): a triangle, a cache block or a step, centred on the drop point. The new item's
 * pick comes back with it; a processor no longer listed is refused.
 */
export function dropOnBoard(b: BoardState, d: ToolboxDrag, at: Point, newId: () => Id): { state: BoardState; pick: Pick } | { refused: string } {
  const id = newId();
  switch (d.kind) {
    case 'workflow': return { state: addWorkflow(b, centred(at, TRIANGLE_W, TRIANGLE_H), id), pick: { kind: 'workflow', id } };
    case 'cache': return { state: addCache(b, centred(at, CACHE_W, CACHE_H), id), pick: { kind: 'cache', id } };
    case 'step': {
      const p = b.processors[d.processorId];
      if (!p) return { refused: 'That processor is no longer listed' };
      return { state: addStep(b, p, centred(at, STEP_W, STEP_H), id), pick: { kind: 'step', id } };
    }
  }
}
