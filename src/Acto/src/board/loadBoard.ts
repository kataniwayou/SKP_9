import type { ApiResult, StudioApi } from '../api/client';
import { graphFromDto, processorFromDto, stepFromDto } from '../api/toModel';
import type { Graph, Id } from '../model/graph';
import type { Point, Rect } from '../model/geometry';
import { reachableStepIds } from '../model/reachability';
import { parseActoLayout } from './layoutDoc';
import { defaultStepPositions, frameSizeOf, placeFrames } from './placement';
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
}
export interface BoardLoad {
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
    if (pid !== null && !graph.processors.has(pid)) {
      const processor = await api.getProcessor(pid);
      if (processor.ok) graph.processors.set(pid, processorFromDto(processor.value));
      else if (processor.error.kind !== 'notFound') return processor;
    }
  }

  const placed = new Map<Id, Point>();
  for (const id of stepIds) if (layout.steps[id]) placed.set(id, layout.steps[id]);
  const stepAt = new Map<Id, Point>(placed);
  const inFrameSteps = new Map(stepIds.map((id) => [id, graph.steps.get(id)!]));
  for (const [id, p] of defaultStepPositions(graph.workflow.entryStepIds, inFrameSteps, placed)) stepAt.set(id, p);

  const wires = wiresOf(stepIds, graph.steps);
  const roles = stepRoles(stepIds, wires);
  const diff = entryDiff(graph.workflow.entryStepIds, derivedEntrySteps(roles));
  return { ok: true, value: { graph, stepIds, stepAt, roles, wires, entryDiff: diff, storedFrame: layout.board } };
}

/** Every workflow, `concurrency` at a time; one that fails is listed in `failures`, the rest still load. */
export async function loadBoard(api: StudioApi, concurrency = 4): Promise<BoardLoad> {
  const list = await api.listWorkflows();
  if (!list.ok) {
    const e = list.error;
    const detail = 'detail' in e ? e.detail : 'message' in e ? e.message : e.kind;
    return { workflows: [], failures: [{ workflowId: '', name: 'workflow list', detail }] };
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
    else if (r) {
      const e = r.error;
      failures.push({ workflowId: items[i].id, name: items[i].name, detail: 'detail' in e ? e.detail : 'message' in e ? e.message : e.kind });
    }
  });

  const sizes = ok.map(({ w }) => {
    const own = frameSizeOf(w.stepAt);
    return { w: Math.max(own.w, w.storedFrame?.w ?? 0), h: Math.max(own.h, w.storedFrame?.h ?? 0) };
  });
  const frames = placeFrames(ok.map(({ w, i }, k) => ({
    id: items[i].id, createdAt: w.graph.workflow.audit.createdAt, stored: w.storedFrame && { ...w.storedFrame, ...sizes[k] }, size: sizes[k],
  })));
  return { workflows: ok.map(({ w, i }) => ({ ...omitStored(w), frame: frames.get(items[i].id)! })), failures };
}

function omitStored({ storedFrame: _s, ...rest }: Loaded): Omit<BoardWorkflow, 'frame'> {
  return rest;
}
