import type { StudioApi } from '../api/client';
import { graphDto } from '../api/fixtures';
import type { StepReadDto, WorkflowGraphDto, WorkflowProblemDto } from '../api/types';
import type { StudioDocument } from './document';
import { loadDocument } from './loadDocument';

const notFound = { ok: false, error: { kind: 'notFound', status: 404 } } as const;

/**
 * Tests only: a document loaded through the real loader from a graph DTO. `problems` null means
 * validate failed; `parked` are the steps GET /steps/{id} returns (list their ids in the layout).
 */
export async function loadedDocument(
  graph: WorkflowGraphDto = graphDto(), problems: WorkflowProblemDto[] | null = [], parked: StepReadDto[] = [],
): Promise<StudioDocument> {
  const api = {
    getGraph: async () => ({ ok: true, value: graph }),
    validate: async () => (problems === null
      ? { ok: false, error: { kind: 'network', message: 'down' } }
      : { ok: true, value: { valid: problems.length === 0, problems } }),
    getStep: async (id: string) => {
      const step = parked.find((s) => s.id === id);
      return step ? { ok: true, value: step } : notFound;
    },
    getProcessor: async () => notFound,
    getSchema: async () => notFound,
  } as unknown as StudioApi;
  const result = await loadDocument(api, graph.workflow?.id ?? 'wf1');
  if (!result.ok) throw new Error(`fixture failed to load: ${JSON.stringify(result.error)}`);
  return result.value;
}
