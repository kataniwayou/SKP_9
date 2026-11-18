import type { Id } from '../model/graph';
import type { Point, Rect } from '../model/geometry';
import { FRAME_PAD, HEADER_H, STEP_H, STEP_W } from '../board/geometry';
import { freeOffset, PASTE_CELL, PASTE_MARGIN } from './freeOffset';
import { uniqueName, type AssignmentState, type StepState, type WorkflowState } from '../design/state';

export interface ClipStep {
  id: Id; name: string; version: string; description: string | null; entryCondition: number;
  processorId: Id | null; at: Point /* board coordinates */; payload: string | null;
}
export interface Clip { steps: ClipStep[]; wires: [Id, Id][]; pasted: number }

export { freeOffset, PASTE_CELL, PASTE_MARGIN };
const NEAR_GAP = 40;
const CLIP_KEY = 'acto.clip';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function copyMessage(clip: Clip): string {
  const base = `Copied ${plural(clip.steps.length, 'step')}`;
  return clip.wires.length > 0 ? `${base} and ${plural(clip.wires.length, 'wire')}` : base;
}

export function copyClip(parts: { state: WorkflowState; stepIds: Id[] }[]): Clip | null {
  const steps: ClipStep[] = [];
  const chosen = new Set<Id>();
  for (const { state, stepIds } of parts) {
    for (const id of stepIds) {
      const st = state.steps[id];
      if (!st || chosen.has(id)) continue;
      chosen.add(id);
      steps.push({
        id, name: st.name, version: st.version, description: st.description, entryCondition: st.entryCondition,
        processorId: st.processorId, at: { x: state.frame.x + st.at.x, y: state.frame.y + HEADER_H + st.at.y },
        payload: state.assignments[id]?.payload ?? null,
      });
    }
  }
  if (steps.length === 0) return null;
  const wires: [Id, Id][] = [];
  for (const { state } of parts) {
    for (const st of steps.map((s) => state.steps[s.id]).filter((x): x is StepState => !!x)) {
      for (const to of st.nextStepIds) if (chosen.has(to) && !wires.some(([a, b]) => a === st.id && b === to)) wires.push([st.id, to]);
    }
  }
  return { steps, wires, pasted: 0 };
}

/** Pastes the clip into `s` (the frame grows to hold it): new ids, unique names, free space, one new state. */
export function pasteClip(
  s: WorkflowState, clip: Clip, near: Id | null, newId: () => Id,
): { state: WorkflowState; pasted: Id[] } {
  if (clip.steps.length === 0) return { state: s, pasted: [] };
  // the clip in this frame's body coordinates
  const local = clip.steps.map((c) => ({ x: c.at.x - s.frame.x, y: c.at.y - s.frame.y - HEADER_H }));
  const minX = Math.min(...local.map((p) => p.x));
  const minY = Math.min(...local.map((p) => p.y));
  const nearStep = near ? s.steps[near] : undefined;
  const target: Point = nearStep
    ? { x: nearStep.at.x + STEP_W + NEAR_GAP, y: nearStep.at.y }
    : { x: minX + (clip.pasted + 1) * PASTE_CELL, y: minY + (clip.pasted + 1) * PASTE_CELL };
  const start: Point = { x: Math.max(target.x, FRAME_PAD) - minX, y: Math.max(target.y, FRAME_PAD) - minY };
  const group: Rect[] = local.map((p) => ({ x: p.x, y: p.y, w: STEP_W, h: STEP_H }));
  const obstacles: Rect[] = Object.values(s.steps).map((st) => ({ x: st.at.x, y: st.at.y, w: STEP_W, h: STEP_H }));
  const d = freeOffset(group, obstacles, start, PASTE_MARGIN, { x: FRAME_PAD, y: FRAME_PAD });

  let state = s;
  const made = new Map<Id, Id>();
  const pasted: Id[] = [];
  clip.steps.forEach((c, i) => {
    const id = newId();
    made.set(c.id, id);
    pasted.push(id);
    const step: StepState = {
      id, name: uniqueName(state, c.name), version: c.version, description: c.description, entryCondition: c.entryCondition,
      processorId: c.processorId, nextStepIds: [], at: { x: local[i]!.x + d.x, y: local[i]!.y + d.y }, updatedAt: null, isNew: true,
    };
    const assignments = { ...state.assignments };
    if (c.payload !== null) {
      const a: AssignmentState = {
        id: newId(), stepId: id, name: `${step.name}-assignment`, version: '1.0.0', description: null, payload: c.payload,
        updatedAt: null, isNew: true,
      };
      assignments[id] = a;
    }
    state = { ...state, steps: { ...state.steps, [id]: step }, assignments };
  });
  const steps = { ...state.steps };
  for (const [from, to] of clip.wires) {
    const f = made.get(from), t = made.get(to);
    if (!f || !t) continue;
    steps[f] = { ...steps[f]!, nextStepIds: [...steps[f]!.nextStepIds, t] };
  }
  return { state: { ...state, steps }, pasted };
}

const isPoint = (p: unknown): p is Point => !!p && typeof (p as Point).x === 'number' && typeof (p as Point).y === 'number';

export function readClip(session: Storage | null): Clip | null {
  try {
    const raw = session?.getItem(CLIP_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Partial<Clip>;
    if (!c || !Array.isArray(c.steps) || !Array.isArray(c.wires) || typeof c.pasted !== 'number') return null;
    if (!c.steps.every((x) => x && typeof x.id === 'string' && typeof x.name === 'string' && isPoint(x.at))) return null;
    return c as Clip;
  } catch { return null; }
}

export function writeClip(session: Storage | null, clip: Clip): void {
  try { session?.setItem(CLIP_KEY, JSON.stringify(clip)); } catch { /* the clipboard is only a convenience */ }
}
