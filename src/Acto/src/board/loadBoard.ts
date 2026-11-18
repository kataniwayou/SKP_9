import type { ApiResult, StudioApi } from '../api/client';
import {
  assignmentRowFromDto, cacheRowFromDto, processorRowFromDto, schemaRowFromDto, stepRowFromDto, workflowRowFromDto,
} from '../api/toModel';
import type { BoardState } from '../design/board';
import type { Id } from '../model/graph';

const byId = <T extends { id: Id }>(rows: T[]): Record<Id, T> => Object.fromEntries(rows.map((r) => [r.id, r]));

/**
 * The whole board from BaseAPI's six CRUD lists, fetched in parallel. Orphan steps and unlinked assignments are kept; any
 * failed list returns its error (the first, in list order). Never rejects.
 */
export async function loadBoard(api: StudioApi): Promise<ApiResult<BoardState>> {
  try {
    const [workflows, steps, caches, assignments, processors, schemas] = await Promise.all([
      api.listWorkflows(), api.listSteps(), api.listCaches!(), api.listAssignments(), api.listProcessors!(), api.listSchemas!(),
    ]);
    if (!workflows.ok) return workflows;
    if (!steps.ok) return steps;
    if (!caches.ok) return caches;
    if (!assignments.ok) return assignments;
    if (!processors.ok) return processors;
    if (!schemas.ok) return schemas;
    return {
      ok: true,
      value: {
        workflows: byId(workflows.value.map(workflowRowFromDto)),
        steps: byId(steps.value.map(stepRowFromDto)),
        caches: byId(caches.value.map(cacheRowFromDto)),
        assignments: byId(assignments.value.map(assignmentRowFromDto)),
        processors: byId(processors.value.map(processorRowFromDto)),
        schemas: byId(schemas.value.map(schemaRowFromDto)),
      },
    };
  } catch (e) {
    return { ok: false, error: { kind: 'http', status: 0, detail: `Could not load the board: ${e instanceof Error ? e.message : String(e)}` } };
  }
}
