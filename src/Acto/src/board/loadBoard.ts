import type { ApiResult, StudioApi } from '../api/client';
import { cacheFromDto, graphFromDto, processorFromDto, stepFromDto } from '../api/toModel';
import type { Cache, Graph, Id } from '../model/graph';
import type { Point, Rect } from '../model/geometry';
import { reachableStepIds } from '../model/reachability';
import { parseActoLayout } from './layoutDoc';
import { describeError } from '../api/describeError';
import { FRAME_PAD, STEP_H } from './geometry';
import { defaultStepPositions, minFrameSize, placeFrames } from './placement';
import { derivedEntrySteps, entryDiff, stepRoles, type StepRole } from './roles';
import { wiresOf, type Wire } from './wires';

export interface BoardWorkflow {
  graph: Graph;
  stepIds: Id[];
  stepAt: Map<Id, Point>;
  frame: Rect;
  roles: Map<Id, StepRole>;
  wires: Wire[];
  entryDiff: { stops: Id[]; starts: Id[] };
  /** Existing caches a stored design (a save that failed) links that the workflow does not hold yet, by id. */
  designCaches?: ReadonlyMap<Id, Cache>;
}
export interface BoardLoad {
  /** False when the workflow list itself failed: nothing was loaded, and `failures` says why. */
  listed: boolean;
  workflows: BoardWorkflow[];
  failures: { workflowId: Id; name: string; detail: string }[];
}
type Loaded = Omit<BoardWorkflow, 'frame'> & { storedFrame: Rect | null };

/**
 * One workflow for the board: the graph, then the parked steps its layout lists (not reachable, so
 * GET /graph omits them). A listed id the server no longer has is dropped; any other failure is
 * returned. Never rejects.
 */
export async function loadWorkflow(api: StudioApi, workflowId: Id): Promise<ApiResult<Loaded>> {
  try {
    return await load(api, workflowId);
  } catch (e) {
    return { ok: false, error: { kind: 'http', status: 0, detail: `Could not open the workflow: ${e instanceof Error ? e.message : String(e)}` } };
  }
}

const DEFAULT_GAP = 40;

/**
 * Acto stores frame-local positions with a `board` rectangle; those load as they are. A layout without
 * `board`, or with a negative position, is WorkflowStudio's canvas coordinates: shift it so the top-left-most
 * step sits at FRAME_PAD, keeping the steps' layout relative to each other.
 */
function shiftedIntoFrame(stored: [Id, Point][], actoLayout: boolean): Map<Id, Point> {
  if (stored.length === 0) return new Map();
  if (actoLayout && stored.every(([, p]) => p.x >= 0 && p.y >= 0)) return new Map(stored.map(([id, p]) => [id, { ...p }]));
  const dx = FRAME_PAD - Math.min(...stored.map(([, p]) => p.x));
  const dy = FRAME_PAD - Math.min(...stored.map(([, p]) => p.y));
  return new Map(stored.map(([id, p]) => [id, { x: p.x + dx, y: p.y + dy }]));
}

async function load(api: StudioApi, workflowId: Id): Promise<ApiResult<Loaded>> {
  const loaded = await api.getGraph(workflowId);
  if (!loaded.ok) return loaded;

  const graph = graphFromDto(loaded.value);
  const layout = parseActoLayout(graph.layout);
  const stepIds = reachableStepIds(graph.workflow.entryStepIds, graph.steps);
  const inFrame = new Set(stepIds);

  for (const id of [...layout.parked, ...Object.keys(layout.steps)]) {
    if (inFrame.has(id)) continue;
    const step = await api.getStep(id);
    if (!step.ok) {
      if (step.error.kind === 'notFound') continue;
      return step;
    }
    const model = stepFromDto(step.value);
    graph.steps.set(id, model);
    stepIds.push(id);
    inFrame.add(id);
    const pid = model.processorId;
    if (pid && !graph.processors.has(pid)) {
      const processor = await api.getProcessor(pid);
      if (processor.ok) graph.processors.set(pid, processorFromDto(processor.value));
      else if (processor.error.kind !== 'notFound') return processor;
    }
  }

  const placed = shiftedIntoFrame(stepIds.filter((id) => layout.steps[id]).map((id) => [id, layout.steps[id]!]), layout.board !== null);
  const stepAt = new Map<Id, Point>(placed);
  const inFrameSteps = new Map(stepIds.map((id) => [id, graph.steps.get(id)!]));
  // Defaults start at FRAME_PAD; push them below the stored steps so they never sit on top of them.
  let below = 0;
  for (const p of placed.values()) below = Math.max(below, p.y + STEP_H + DEFAULT_GAP - FRAME_PAD);
  for (const [id, p] of defaultStepPositions(graph.workflow.entryStepIds, inFrameSteps, placed)) stepAt.set(id, { x: p.x, y: p.y + below });

  const wires = wiresOf(stepIds, graph.steps);
  const roles = stepRoles(stepIds, wires);
  const diff = entryDiff(graph.workflow.entryStepIds, derivedEntrySteps(roles));
  const designCaches = await designCachesOf(api, graph);
  return { ok: true, value: { graph, stepIds, stepAt, roles, wires, entryDiff: diff, storedFrame: layout.board, ...(designCaches.size ? { designCaches } : {}) } };
}

/** Best effort: a cache that cannot be read is restored from the stored design alone. */
async function designCachesOf(api: StudioApi, graph: Graph): Promise<Map<Id, Cache>> {
  const out = new Map<Id, Cache>();
  const design = graph.design as { workflow?: { cacheIds?: unknown } } | null;
  const ids = Array.isArray(design?.workflow?.cacheIds) ? design.workflow.cacheIds : [];
  for (const id of ids) {
    if (typeof id !== 'string' || graph.caches.has(id) || out.has(id)) continue;
    try {
      const r = await api.getEntity('cache', id);
      if (r.ok) out.set(id, cacheFromDto(r.value));
    } catch { /* restored without it */ }
  }
  return out;
}

/** Every workflow, `concurrency` at a time; one that fails is listed in `failures`, the rest still load. */
export async function loadBoard(api: StudioApi, concurrency = 4): Promise<BoardLoad> {
  const list = await api.listWorkflows();
  if (!list.ok) {
    return { listed: false, workflows: [], failures: [{ workflowId: '', name: 'the workflow list', detail: describeError(list.error) }] };
  }
  const items = list.value.filter((w): w is typeof w & { id: string } => !!w.id).map((w) => ({ id: w.id, name: w.name ?? w.id }));
  const results: (ApiResult<Loaded> | undefined)[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await loadWorkflow(api, items[i].id);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));

  const ok: { w: Loaded; i: number }[] = [];
  const failures: BoardLoad['failures'] = [];
  results.forEach((r, i) => {
    if (r?.ok) ok.push({ w: r.value, i });
    else if (r) failures.push({ workflowId: items[i].id, name: items[i].name, detail: describeError(r.error) });
  });

  const sizes = ok.map(({ w }) => {
    const own = minFrameSize(w.stepAt, w.graph.caches.size);
    return { w: Math.max(own.w, w.storedFrame?.w ?? 0), h: Math.max(own.h, w.storedFrame?.h ?? 0) };
  });
  const frames = placeFrames(ok.map(({ w, i }, k) => ({
    id: items[i].id, createdAt: w.graph.workflow.audit.createdAt, stored: w.storedFrame && { ...w.storedFrame, ...sizes[k] }, size: sizes[k],
  })));
  return { listed: true, workflows: ok.map(({ w, i }) => ({ ...omitStored(w), frame: frames.get(items[i].id)! })), failures };
}

function omitStored({ storedFrame: _s, ...rest }: Loaded): Omit<BoardWorkflow, 'frame'> {
  return rest;
}
