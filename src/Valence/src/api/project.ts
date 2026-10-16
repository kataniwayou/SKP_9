/** Who created and last changed a row, and when: set by BaseApi, never sent. */
export interface Audit { createdAt?: string; updatedAt?: string; createdBy?: string | null; updatedBy?: string | null }

/** The six read DTOs, as BaseApi's list endpoints return them. */
export interface WorkflowDto extends Audit { id: string; name: string; version: string; description: string | null; entryStepIds: string[] | null; assignmentIds: string[] | null; cacheIds: string[] | null; cronExpression: string | null }
export interface StepDto extends Audit { id: string; name: string; version: string; description: string | null; processorId: string; nextStepIds: string[] | null; entryCondition: number }
export interface ProcessorDto extends Audit { id: string; name: string; version: string; description: string | null; sourceHash?: string; instanceId?: string | null; inputSchemaId: string | null; outputSchemaId: string | null; configSchemaId: string | null }
export interface SchemaDto extends Audit { id: string; name: string; version: string; description: string | null; definition?: string }
export interface AssignmentDto extends Audit { id: string; name: string; version: string; description: string | null; stepId: string; payload?: string }
export interface CacheDto extends Audit { id: string; name: string; version: string; description: string | null; root: string; items?: string }

/** Every row of the six entity tables: the whole project (spec §5: every row, not only what workflows reach). */
export interface ProjectData {
  workflows: WorkflowDto[];
  steps: StepDto[];
  processors: ProcessorDto[];
  schemas: SchemaDto[];
  assignments: AssignmentDto[];
  caches: CacheDto[];
}

export type ProjectResult = { ok: true; data: ProjectData } | { ok: false; message: string };

const BASE = '/api/v1';
const TABLES = ['workflows', 'steps', 'processors', 'schemas', 'assignments', 'caches'] as const;

/**
 * Reads the whole project from BaseApi's six list endpoints (spec §8.1: built in the client, no new endpoint). Their link
 * fields carry every arrow (spec §5). Any failure is one line for the page; nothing throws.
 */
export async function readProject(fetchFn: typeof fetch = fetch): Promise<ProjectResult> {
  try {
    const answers = await Promise.all(TABLES.map(async (table) => {
      const res = await fetchFn(`${BASE}/${table}`, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`GET ${BASE}/${table}: ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
      const body: unknown = await res.json();
      if (!Array.isArray(body)) throw new Error(`GET ${BASE}/${table}: not a list`);
      return body;
    }));
    const [workflows, steps, processors, schemas, assignments, caches] = answers;
    return { ok: true, data: { workflows, steps, processors, schemas, assignments, caches } as ProjectData };
  } catch (e) {
    return { ok: false, message: `BaseApi could not be read: ${e instanceof Error ? e.message : String(e)}` };
  }
}
