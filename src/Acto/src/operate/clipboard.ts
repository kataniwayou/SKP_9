import type { Id } from '../model/graph';
import type { Point, Rect } from '../model/geometry';
import { CACHE_H, CACHE_W, STEP_H, STEP_W, TRIANGLE_H, TRIANGLE_W } from '../board/geometry';
import type { BoardState, StepRow } from '../design/board';
import { freeOffset, PASTE_CELL, PASTE_MARGIN } from './freeOffset';

/** A copied step: its shared fields and where it stood. No payload: payloads belong to workflows (spec §7). */
export interface ClipStep {
  id: Id; name: string; version: string; description: string | null; entryCondition: number;
  processorId: Id | null; at: Point;
}
export interface Clip { steps: ClipStep[]; wires: [Id, Id][]; pasted: number }

export { freeOffset, PASTE_CELL, PASTE_MARGIN };
const CLIP_KEY = 'acto.clip';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function copyMessage(clip: Clip): string {
  const base = `Copied ${plural(clip.steps.length, 'step')}`;
  return clip.wires.length > 0 ? `${base} and ${plural(clip.wires.length, 'wire')}` : base;
}

/** The steps (in the order given, each once) and the wires among them; null when none of them is on the board. */
export function copyClip(b: BoardState, stepIds: readonly Id[]): Clip | null {
  const chosen = new Set<Id>();
  const steps: ClipStep[] = [];
  for (const id of stepIds) {
    const st = b.steps[id];
    if (!st || chosen.has(id)) continue;
    chosen.add(id);
    steps.push({
      id, name: st.name, version: st.version, description: st.description, entryCondition: st.entryCondition,
      processorId: st.processorId, at: { ...(st.at ?? { x: 0, y: 0 }) },
    });
  }
  if (steps.length === 0) return null;
  const wires: [Id, Id][] = [];
  for (const s of steps) {
    for (const to of new Set(b.steps[s.id]!.nextStepIds)) if (chosen.has(to)) wires.push([s.id, to]);
  }
  return { steps, wires, pasted: 0 };
}

/** Everything that stands on the board, as boxes. */
function boxes(b: BoardState): Rect[] {
  const at = (p: Point | null) => p ?? { x: 0, y: 0 };
  return [
    ...Object.values(b.steps).map((s) => ({ ...at(s.at), w: STEP_W, h: STEP_H })),
    ...Object.values(b.caches).map((c) => ({ ...at(c.at), w: CACHE_W, h: CACHE_H })),
    ...Object.values(b.workflows).map((w) => ({ ...at(w.at), w: TRIANGLE_W, h: TRIANGLE_H })),
  ];
}

/**
 * Pastes the clip as new steps (new ids, unique names, unsaved, wires among them remapped, no payloads), (pasted + 1)
 * grid cells down-right of where they were copied from, moved on to the nearest free offset when that is taken.
 */
export function pasteClip(b: BoardState, clip: Clip, newId: () => Id): { state: BoardState; pasted: Id[] } {
  if (clip.steps.length === 0) return { state: b, pasted: [] };
  const cell = (clip.pasted + 1) * PASTE_CELL;
  const group: Rect[] = clip.steps.map((c) => ({ ...c.at, w: STEP_W, h: STEP_H }));
  const d = freeOffset(group, boxes(b), { x: cell, y: cell }, PASTE_MARGIN);
  const taken = new Set(Object.values(b.steps).map((s) => s.name));
  const unique = (name: string) => {
    let n = name;
    for (let i = 2; taken.has(n); i++) n = `${name}-${i}`;
    taken.add(n);
    return n;
  };
  const made = new Map<Id, Id>();
  const steps = { ...b.steps };
  const pasted: Id[] = [];
  for (const c of clip.steps) {
    const id = newId();
    made.set(c.id, id);
    pasted.push(id);
    const row: StepRow = {
      id, name: unique(c.name), version: c.version, description: c.description, processorId: c.processorId,
      nextStepIds: [], entryCondition: c.entryCondition, at: { x: c.at.x + d.x, y: c.at.y + d.y }, updatedAt: null,
    };
    steps[id] = row;
  }
  for (const [from, to] of clip.wires) {
    const f = made.get(from), t = made.get(to);
    if (f && t) steps[f] = { ...steps[f]!, nextStepIds: [...steps[f]!.nextStepIds, t] };
  }
  return { state: { ...b, steps }, pasted };
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
