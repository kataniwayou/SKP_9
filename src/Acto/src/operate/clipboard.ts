import type { Id } from '../model/graph';
import type { Point, Rect } from '../model/geometry';
import { CACHE_H, CACHE_W, STEP_H, STEP_W, TRIANGLE_H, TRIANGLE_W } from '../board/geometry';
import type { BoardState, CacheRow, ItemRef, StepRow, WorkflowRow } from '../design/board';
import { NO_AUDIT } from '../design/board';
import { freeOffset, PASTE_CELL, PASTE_MARGIN } from './freeOffset';

/** A copied step: its shared fields and where it stood. No payload: payloads belong to workflows (spec §7). */
export interface ClipStep {
  id: Id; name: string; version: string; description: string | null; entryCondition: number;
  processorId: Id | null; at: Point;
}
/**
 * A copied cache: every field and where it stood [user, 2026-11-19: a copy is a new id, every field but the name]. The
 * paste's root is named on like the name (BaseAPI keeps roots unique: a shared root would mix two caches' items).
 */
export interface ClipCache {
  id: Id; name: string; version: string; description: string | null; root: string; items: string; at: Point;
}
/**
 * A copied workflow: every field and where it stood [user, 2026-11-19]. Its entry steps, caches and assignments are
 * the same ids: the paste shares the assignment rows (an edit there copies the payload for that workflow only).
 */
export interface ClipWorkflow {
  id: Id; name: string; version: string; description: string | null; cronExpression: string | null;
  entryStepIds: Id[]; assignmentIds: Id[]; cacheIds: Id[]; at: Point;
  /** The cron of each entry arrow by entry step; absent on a clip stored before entry crons. */
  entryCrons?: Record<Id, string>;
}
export interface Clip { steps: ClipStep[]; wires: [Id, Id][]; caches: ClipCache[]; workflows: ClipWorkflow[]; pasted: number }

export { freeOffset, PASTE_CELL, PASTE_MARGIN };
const CLIP_KEY = 'acto.clip';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const andList = (parts: string[]) => parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;

/** "1 workflow, 2 steps and 1 cache": the counts that are not 0. */
export function countWords(c: { workflows: number; steps: number; caches: number; wires?: number }): string {
  return andList([
    ...(c.workflows > 0 ? [plural(c.workflows, 'workflow')] : []),
    ...(c.steps > 0 ? [plural(c.steps, 'step')] : []),
    ...(c.caches > 0 ? [plural(c.caches, 'cache')] : []),
    ...((c.wires ?? 0) > 0 ? [plural(c.wires!, 'wire')] : []),
  ]);
}

export function copyMessage(clip: Clip): string {
  return `Copied ${countWords({ workflows: clip.workflows.length, steps: clip.steps.length, caches: clip.caches.length, wires: clip.wires.length })}`;
}

const at0 = (p: Point | null): Point => ({ ...(p ?? { x: 0, y: 0 }) });

/**
 * The triangles, steps and caches given (in the order given, each once) and the wires among the steps; null when none
 * of them is on the board.
 */
export function copyClip(b: BoardState, items: readonly ItemRef[]): Clip | null {
  const seen = new Set<string>();
  const clip: Clip = { steps: [], wires: [], caches: [], workflows: [], pasted: 0 };
  for (const ref of items) {
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) continue;
    if (ref.kind === 'step') {
      const st = b.steps[ref.id];
      if (!st) continue;
      clip.steps.push({
        id: st.id, name: st.name, version: st.version, description: st.description, entryCondition: st.entryCondition,
        processorId: st.processorId, at: at0(st.at),
      });
    } else if (ref.kind === 'cache') {
      const c = b.caches[ref.id];
      if (!c) continue;
      clip.caches.push({ id: c.id, name: c.name, version: c.version, description: c.description, root: c.root, items: c.items, at: at0(c.at) });
    } else {
      const w = b.workflows[ref.id];
      if (!w) continue;
      clip.workflows.push({
        id: w.id, name: w.name, version: w.version, description: w.description, cronExpression: w.cronExpression,
        entryStepIds: [...w.entryStepIds], entryCrons: { ...w.entryCrons }, assignmentIds: [...w.assignmentIds], cacheIds: [...w.cacheIds], at: at0(w.at),
      });
    }
    seen.add(key);
  }
  if (clip.steps.length + clip.caches.length + clip.workflows.length === 0) return null;
  // a workflow copied alone pastes like a step alone: its fields only — no entry arrows, cache lines or assignments
  // [user, 2026-11-23]; copied with steps or caches it keeps its links (they join the copies, or stay on the originals)
  if (clip.workflows.length === 1 && clip.steps.length === 0 && clip.caches.length === 0) {
    clip.workflows[0] = { ...clip.workflows[0]!, entryStepIds: [], entryCrons: {}, assignmentIds: [], cacheIds: [] };
  }
  const chosen = new Set(clip.steps.map((s) => s.id));
  for (const s of clip.steps) {
    for (const to of new Set(b.steps[s.id]!.nextStepIds)) if (chosen.has(to)) clip.wires.push([s.id, to]);
  }
  return clip;
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

/** Studio's names: `name`, then `name-2`, `name-3`, … — the first not taken. */
function namer(names: Iterable<string>) {
  const taken = new Set(names);
  return (name: string) => {
    let n = name;
    for (let i = 2; taken.has(n); i++) n = `${name}-${i}`;
    taken.add(n);
    return n;
  };
}

/**
 * Pastes the clip as new rows (new ids, unique names, unsaved), (pasted + 1) grid cells down-right of where they were
 * copied from, moved on to the nearest free offset when that is taken. Every other field is the copied one
 * [user, 2026-11-19], but a cache's root, which is named on like the name (unique in BaseAPI). A link between two
 * copied items joins the copies (wires, a workflow's entry arrows and cache lines); a workflow's link to anything not copied stays on the original (dropped if that is gone from the board); its
 * assignments are the same rows. Steps get no payloads.
 */
export function pasteClip(b: BoardState, clip: Clip, newId: () => Id): { state: BoardState; pasted: ItemRef[] } {
  if (clip.steps.length + clip.caches.length + clip.workflows.length === 0) return { state: b, pasted: [] };
  const cell = (clip.pasted + 1) * PASTE_CELL;
  const group: Rect[] = [
    ...clip.steps.map((c) => ({ ...c.at, w: STEP_W, h: STEP_H })),
    ...clip.caches.map((c) => ({ ...c.at, w: CACHE_W, h: CACHE_H })),
    ...clip.workflows.map((c) => ({ ...c.at, w: TRIANGLE_W, h: TRIANGLE_H })),
  ];
  const d = freeOffset(group, boxes(b), { x: cell, y: cell }, PASTE_MARGIN);
  const moved = (p: Point) => ({ x: p.x + d.x, y: p.y + d.y });
  const pasted: ItemRef[] = [];

  const stepName = namer(Object.values(b.steps).map((s) => s.name));
  const madeStep = new Map<Id, Id>();
  const steps = { ...b.steps };
  for (const c of clip.steps) {
    const id = newId();
    madeStep.set(c.id, id);
    pasted.push({ kind: 'step', id });
    const row: StepRow = {
      id, name: stepName(c.name), version: c.version, description: c.description, processorId: c.processorId,
      nextStepIds: [], entryCondition: c.entryCondition, at: moved(c.at), updatedAt: null, ...NO_AUDIT,
    };
    steps[id] = row;
  }
  for (const [from, to] of clip.wires) {
    const f = madeStep.get(from), t = madeStep.get(to);
    if (f && t) steps[f] = { ...steps[f]!, nextStepIds: [...steps[f]!.nextStepIds, t] };
  }

  const cacheName = namer(Object.values(b.caches).map((c) => c.name));
  const cacheRoot = namer(Object.values(b.caches).map((c) => c.root));
  const madeCache = new Map<Id, Id>();
  const caches = { ...b.caches };
  for (const c of clip.caches) {
    const id = newId();
    madeCache.set(c.id, id);
    pasted.push({ kind: 'cache', id });
    const row: CacheRow = {
      id, name: cacheName(c.name), version: c.version, description: c.description, root: cacheRoot(c.root), items: c.items,
      at: moved(c.at), updatedAt: null, ...NO_AUDIT,
    };
    caches[id] = row;
  }

  const workflowName = namer(Object.values(b.workflows).map((w) => w.name));
  const workflows = { ...b.workflows };
  // a link to a copied item joins the copy; to anything else, the original while it is still on the board
  const relink = (ids: Id[], made: Map<Id, Id>, onBoard: Record<Id, unknown>) =>
    [...new Set(ids.flatMap((x) => { const m = made.get(x); return m ? [m] : onBoard[x] ? [x] : []; }))];
  for (const c of clip.workflows) {
    const id = newId();
    pasted.push({ kind: 'workflow', id });
    const row: WorkflowRow = {
      id, name: workflowName(c.name), version: c.version, description: c.description, cronExpression: c.cronExpression,
      entryStepIds: relink(c.entryStepIds, madeStep, b.steps),
      entryCrons: Object.fromEntries(c.entryStepIds.flatMap((x) => {
        const cron = c.entryCrons?.[x], to = madeStep.get(x) ?? (b.steps[x] ? x : undefined);
        return cron && to ? [[to, cron] as [Id, string]] : [];
      })),
      assignmentIds: [...new Set(c.assignmentIds.filter((a) => b.assignments[a]))],
      cacheIds: relink(c.cacheIds, madeCache, b.caches),
      at: moved(c.at), updatedAt: null, ...NO_AUDIT,
    };
    workflows[id] = row;
  }
  return { state: { ...b, steps, caches, workflows }, pasted };
}

/** "Pasted 1 workflow and 2 steps". */
export function pasteMessage(pasted: readonly ItemRef[]): string {
  const n = (k: ItemRef['kind']) => pasted.filter((p) => p.kind === k).length;
  return `Pasted ${countWords({ workflows: n('workflow'), steps: n('step'), caches: n('cache') })}`;
}

const isPoint = (p: unknown): p is Point => !!p && typeof (p as Point).x === 'number' && typeof (p as Point).y === 'number';
const placed = (xs: unknown) => Array.isArray(xs)
  && xs.every((x) => x && typeof x.id === 'string' && typeof x.name === 'string' && isPoint(x.at));

/** The clip in this tab's session; one from before caches and workflows could be copied reads as steps only. */
export function readClip(session: Storage | null): Clip | null {
  try {
    const raw = session?.getItem(CLIP_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Partial<Clip>;
    if (!c || !Array.isArray(c.wires) || typeof c.pasted !== 'number' || !placed(c.steps)) return null;
    const caches = c.caches ?? [], workflows = c.workflows ?? [];
    if (!placed(caches) || !placed(workflows)) return null;
    if (!workflows.every((w) => [w.entryStepIds, w.assignmentIds, w.cacheIds].every(Array.isArray))) return null;
    return { steps: c.steps!, wires: c.wires, caches, workflows, pasted: c.pasted };
  } catch { return null; }
}

export function writeClip(session: Storage | null, clip: Clip): void {
  try { session?.setItem(CLIP_KEY, JSON.stringify(clip)); } catch { /* the clipboard is only a convenience */ }
}
