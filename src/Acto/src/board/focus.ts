import type { Id } from '../model/graph';
import type { Point, Rect } from '../model/geometry';
import { HEADER_H, STEP_H, STEP_W } from './geometry';

/**
 * What the board pans to when the chat changed a workflow: the box around the named steps (in board coordinates: the
 * frame's corner plus the header), or the whole frame when no step is named or none of them is there any more.
 */
export function focusBounds(frame: Rect, stepAt: ReadonlyMap<Id, Point>, stepIds: readonly Id[] = []): Rect {
  const at = stepIds.flatMap((id) => { const p = stepAt.get(id); return p ? [p] : []; });
  if (at.length === 0) return { ...frame };
  const x0 = Math.min(...at.map((p) => p.x)), y0 = Math.min(...at.map((p) => p.y));
  const x1 = Math.max(...at.map((p) => p.x + STEP_W)), y1 = Math.max(...at.map((p) => p.y + STEP_H));
  return { x: frame.x + x0, y: frame.y + HEADER_H + y0, w: x1 - x0, h: y1 - y0 };
}
