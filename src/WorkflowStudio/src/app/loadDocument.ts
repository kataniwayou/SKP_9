import type { ApiResult, StudioApi } from '../api/client';
import { graphFromDto, processorFromDto, schemaFromDto, stepFromDto } from '../api/toModel';
import { parseLayout } from '../layout/layoutDoc';
import { place, type Placement } from '../layout/placement';
import { routeWires } from '../layout/wires';
import type { Graph, Id } from '../model/graph';
import { reachableStepIds } from '../model/reachability';
import type { StudioDocument } from './document';

/**
 * Opens one workflow: the graph, then the parked steps its layout lists (they are not reachable, so
 * GET /graph does not return them; spec §4.3) and any processor they need, then placement and wires.
 * A parked id the server no longer has is dropped silently (spec §8); any other failure is returned.
 * Last, the schemas a parked step's processor names but the graph does not carry are read one by
 * one, so the Inspector and the die can name every slot; a schema that cannot be read is left out
 * (the slot then shows its raw id).
 * Any malformed part of the layout is ignored by `parseLayout`; missing blocks get an elkjs position.
 *
 * Opening is GETs only (plan 8 §3.1): no validate, nothing marked broken.
 *
 * This never rejects: elkjs failures, a malformed body (a missing required field) or anything else
 * thrown becomes an error result (`http`, status 0).
 */
export async function loadDocument(api: StudioApi, workflowId: Id): Promise<ApiResult<StudioDocument>> {
  try {
    return await load(api, workflowId);
  } catch (e) {
    return { ok: false, error: { kind: 'http', status: 0, detail: `Could not open the workflow: ${e instanceof Error ? e.message : String(e)}` } };
  }
}

async function load(api: StudioApi, workflowId: Id): Promise<ApiResult<StudioDocument>> {
  const loaded = await api.getGraph(workflowId);
  if (!loaded.ok) return loaded;

  const graph: Graph = graphFromDto(loaded.value);
  const layout = parseLayout(graph.layout);
  const reachable = reachableStepIds(graph.workflow.entryStepIds, graph.steps);
  const reachableSet = new Set(reachable);

  const parkedIds: Id[] = [];
  for (const id of layout.parked) {
    if (reachableSet.has(id)) continue;
    const step = await api.getStep(id);
    if (!step.ok) {
      if (step.error.kind === 'notFound') continue;
      return step;
    }
    const model = stepFromDto(step.value);
    graph.steps.set(id, model);
    parkedIds.push(id);
    if (!graph.processors.has(model.processorId)) {
      const processor = await api.getProcessor(model.processorId);
      if (processor.ok) graph.processors.set(model.processorId, processorFromDto(processor.value));
      else if (processor.error.kind !== 'notFound') return processor;
    }
  }

  await loadMissingSchemas(api, graph);

  let placement: Placement;
  try {
    placement = await place({
      entryStepIds: graph.workflow.entryStepIds,
      reachable: reachable.map((id) => ({ id, nextStepIds: graph.steps.get(id)!.nextStepIds })),
      parkedIds,
      cacheIds: [...graph.caches.keys()],
      layout,
    });
  } catch (e) {
    return { ok: false, error: { kind: 'http', status: 0, detail: `Layout failed: ${e instanceof Error ? e.message : String(e)}` } };
  }
  // routeWires only wires ends that are both placed and known, so every wire end has a position.
  const wires = routeWires({ entryStepIds: graph.workflow.entryStepIds, steps: graph.steps, brokenEdges: new Set<string>() }, placement);

  return { ok: true, value: { graph, parkedIds, placement, wires, loose: [] } };
}

/** GET /schemas/{id} for every processor slot the graph names but does not carry (parked steps only). */
async function loadMissingSchemas(api: StudioApi, graph: Graph): Promise<void> {
  const missing = new Set<Id>();
  for (const p of graph.processors.values()) {
    for (const id of [p.inputSchemaId, p.outputSchemaId, p.configSchemaId]) {
      if (id && !graph.schemas.has(id)) missing.add(id);
    }
  }
  for (const id of missing) {
    const schema = await api.getSchema(id);
    if (schema.ok) {
      try { graph.schemas.set(id, schemaFromDto(schema.value)); } catch { /* a body without an id is left out: the slot shows its raw id */ }
    }
  }
}
