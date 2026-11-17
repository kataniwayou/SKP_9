import type { Id, Step } from '../model/graph';
import type { Point, Rect } from '../model/geometry';
import {
  BOARD_ROW_W, FRAME_GAP, FRAME_MIN_BODY_H, FRAME_MIN_W, FRAME_PAD, HEADER_H, STEP_H, STEP_W,
} from './geometry';

/** Content box of all steps plus padding, never smaller than the minimum frame. */
export function frameSizeOf(stepAt: ReadonlyMap<Id, Point>): { w: number; h: number } {
  let right = 0;
  let bottom = 0;
  for (const p of stepAt.values()) {
    right = Math.max(right, p.x + STEP_W);
    bottom = Math.max(bottom, p.y + STEP_H);
  }
  const hasSteps = stepAt.size > 0;
  return {
    w: Math.max(FRAME_MIN_W, hasSteps ? right + FRAME_PAD : 0),
    h: Math.max(HEADER_H + FRAME_MIN_BODY_H, hasSteps ? HEADER_H + bottom + FRAME_PAD : 0),
  };
}

/** Positions for the steps not in `placed`: columns by BFS depth from the entry steps. */
export function defaultStepPositions(
  entryStepIds: Id[],
  steps: ReadonlyMap<Id, Pick<Step, 'nextStepIds'>>,
  placed: ReadonlyMap<Id, Point>,
): Map<Id, Point> {
  const depth = new Map<Id, number>();
  let queue: Id[] = [];
  for (const id of entryStepIds) {
    if (steps.has(id) && !depth.has(id)) { depth.set(id, 0); queue.push(id); }
  }
  for (let d = 0; queue.length; d++) {
    const next: Id[] = [];
    for (const id of queue) {
      for (const n of steps.get(id)?.nextStepIds ?? []) {
        if (steps.has(n) && !depth.has(n)) { depth.set(n, d + 1); next.push(n); }
      }
    }
    queue = next;
  }
  const deepest = depth.size ? Math.max(...depth.values()) : -1;
  const rows = new Map<number, number>();
  const out = new Map<Id, Point>();
  for (const id of steps.keys()) {
    if (placed.has(id)) continue;
    const col = depth.get(id) ?? deepest + 1;
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    out.set(id, { x: FRAME_PAD + col * (STEP_W + 70), y: FRAME_PAD + row * (STEP_H + 40) });
  }
  return out;
}

const clashes = (a: Rect, b: Rect) =>
  a.x < b.x + b.w + FRAME_GAP && b.x < a.x + a.w + FRAME_GAP &&
  a.y < b.y + b.h + FRAME_GAP && b.y < a.y + a.h + FRAME_GAP;

/** Stored rects stay; the rest go, oldest first, into the first free slot of rows BOARD_ROW_W wide. */
export function placeFrames(
  items: { id: Id; createdAt: string; stored: Rect | null; size: { w: number; h: number } }[],
): Map<Id, Rect> {
  const out = new Map<Id, Rect>();
  for (const it of items) if (it.stored) out.set(it.id, { ...it.stored });
  const rest = items
    .filter((it) => !it.stored)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  for (const it of rest) {
    const taken = [...out.values()];
    const ys = [0, ...taken.map((r) => r.y + r.h + FRAME_GAP)].sort((a, b) => a - b);
    let found: Rect | null = null;
    for (const y of ys) {
      const xs = [0, ...taken.map((r) => r.x + r.w + FRAME_GAP)].sort((a, b) => a - b);
      for (const x of xs) {
        if (x > 0 && x + it.size.w > BOARD_ROW_W) continue;
        const cand = { x, y, w: it.size.w, h: it.size.h };
        if (!taken.some((t) => clashes(cand, t))) { found = cand; break; }
      }
      if (found) break;
    }
    out.set(it.id, found ?? { x: 0, y: Math.max(0, ...taken.map((r) => r.y + r.h + FRAME_GAP)), ...it.size });
  }
  return out;
}
