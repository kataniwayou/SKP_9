import type { Id } from '../model/graph';
import type { Rect } from '../model/geometry';
import type { BoardState } from '../design/board';
import { reachOf } from '../design/board';
import { STEP_H, STEP_W, TRIANGLE_H, TRIANGLE_W } from './geometry';

/**
 * What the board pans to when the chat changed a workflow: the box around the named steps, or (none named, or none of them
 * there any more) around the triangle and the steps it reaches. null when the workflow is not on the board.
 */
export function focusBounds(b: BoardState, workflowId: Id, stepIds: readonly Id[] = []): Rect | null {
  const wf = b.workflows[workflowId];
  if (!wf) return null;
  const named = stepIds.flatMap((id) => { const s = b.steps[id]; return s?.at ? [{ ...s.at, w: STEP_W, h: STEP_H }] : []; });
  const boxes = named.length > 0 ? named : [
    ...(wf.at ? [{ ...wf.at, w: TRIANGLE_W, h: TRIANGLE_H }] : []),
    ...[...reachOf(b, workflowId)].flatMap((id) => { const s = b.steps[id]; return s?.at ? [{ ...s.at, w: STEP_W, h: STEP_H }] : []; }),
  ];
  if (boxes.length === 0) return null;
  const x0 = Math.min(...boxes.map((r) => r.x)), y0 = Math.min(...boxes.map((r) => r.y));
  const x1 = Math.max(...boxes.map((r) => r.x + r.w)), y1 = Math.max(...boxes.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
