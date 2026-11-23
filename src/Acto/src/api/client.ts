import { ENTITY_PATH, type EntityKind, type ReadDtoOf, type UpdateDtoOf } from './entities';
import type { ModelChange } from '../design/changes';
import type { AssignmentCreateDto, AssignmentReadDto, CacheReadDto, DraftCheckDto, ModelApplyResultDto, ModelValidateResultDto, ProcessorReadDto, SchemaReadDto, StepReadDto, WorkflowReadDto, WorkflowValidationDto } from './types';

/**
 * Every way a request can fail, as data. The UI shows these in its status line (Output in plan 5);
 * nothing in the app catches an exception from a request.
 */
export type ApiError =
  | { kind: 'notFound'; status: 404 }
  | { kind: 'badRequest'; status: 400; detail: string; errors: Record<string, string[]> }
  | { kind: 'conflict'; status: 409; detail: string; entity: { kind: string; id: string } | null }
  | { kind: 'unprocessable'; status: 422; detail: string }
  | { kind: 'http'; status: number; detail: string }
  | { kind: 'network'; message: string };

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export interface StudioApi {
  listWorkflows(): Promise<ApiResult<WorkflowReadDto[]>>;
  getStep(stepId: string): Promise<ApiResult<StepReadDto>>;
  getProcessor(processorId: string): Promise<ApiResult<ProcessorReadDto>>;
  getSchema(schemaId: string): Promise<ApiResult<SchemaReadDto>>;
  /** The Toolbox's lists (2026-10-11): every processor, cache and schema BaseApi holds. Optional: a test's fake may lack them. */
  listSteps(): Promise<ApiResult<StepReadDto[]>>;
  listAssignments(): Promise<ApiResult<AssignmentReadDto[]>>;
  /** `POST /model/apply` with `{ changes }`: the whole board's Save, all or nothing. */
  applyModel(changes: ModelChange[]): Promise<ApiResult<ModelApplyResultDto>>;
  /** `POST /model/validate`: the same dry run, never applied. */
  validateModel(changes: ModelChange[]): Promise<ApiResult<ModelValidateResultDto>>;
  /** `POST /workflows/validate`: Save's check — the changes run and rolled back, each listed workflow through the start's gates, liveness aside. */
  validateDraft(changes: ModelChange[], workflowIds: string[]): Promise<ApiResult<DraftCheckDto>>;
  listProcessors?(): Promise<ApiResult<ProcessorReadDto[]>>;
  listCaches?(): Promise<ApiResult<CacheReadDto[]>>;
  listSchemas?(): Promise<ApiResult<SchemaReadDto[]>>;
  /** `GET /{entity}/{id}`: the entity's read DTO, the Inspector's baseline (spec §7.1). */
  getEntity<K extends EntityKind>(kind: K, id: string): Promise<ApiResult<ReadDtoOf[K]>>;
  /** `PUT /{entity}/{id}` with the full update DTO; BaseApi answers 200 with the entity read back. */
  putEntity<K extends EntityKind>(kind: K, id: string, dto: UpdateDtoOf[K]): Promise<ApiResult<ReadDtoOf[K]>>;
  /** `POST /assignments`: the only create in slice 3b; BaseApi answers 201 with the new assignment. */
  createAssignment(dto: AssignmentCreateDto): Promise<ApiResult<AssignmentReadDto>>;
  /** `DELETE /assignments/{id}`: 204. BaseApi refuses (422) while any workflow still lists it. */
  deleteAssignment(id: string): Promise<ApiResult<null>>;
  /**
   * The running workflow ids (`GET /orchestration/live`, the `skp:live` set). Typed `unknown`
   * on purpose: callers read it defensively (api/liveStatus.ts), never trusting its shape.
   */
  listLive(): Promise<ApiResult<unknown>>;
  /**
   * Every processor's liveness (`GET /processors/liveness`), judged as the start gate judges.
   * Typed `unknown` like listLive: api/liveness.ts reads it defensively.
   */
  listLiveness(): Promise<ApiResult<unknown>>;
  /**
   * Start (2026-10-09): `POST /orchestration/start` with the workflow id as the body. BaseApi checks the workflow it
   * holds (cycles, schema edges, payloads, processor liveness; a refusal is a 422 naming the gate) and queues the
   * start: 202 with no body. The workflow appears in `GET /orchestration/live` a moment later.
   */
  startWorkflow(workflowId: string): Promise<ApiResult<null>>;
  /** Stop: `POST /orchestration/stop`, the same way; 202, and the workflow leaves the live set a moment later. */
  stopWorkflow(workflowId: string): Promise<ApiResult<null>>;
  /**
   * Publishes the workflow's drawing (2026-10-11): `PUT /workflows/{id}/diagram` with raw SVG, which the Kibana
   * dashboard's diagram panel shows (`GET /workflows/{id}.svg`). Leaves the workflow's `updatedAt` where it was. 204.
   */
  publishDiagram(workflowId: string, svg: string): Promise<ApiResult<null>>;
  /** `POST /workflows/{id}/validate` with no body: the start gates' problems for the workflow as stored. */
  validateWorkflow(workflowId: string): Promise<ApiResult<WorkflowValidationDto>>;
}

interface Problem {
  title?: string;
  detail?: string;
  kind?: string;
  id?: string;
  errors?: unknown;
}

async function readProblem(response: Response): Promise<Problem> {
  try {
    return (await response.json()) as Problem;
  } catch {
    return {};
  }
}

/** ValidationProblemDetails' `errors` (C# property name → messages), read defensively. */
function fieldErrorsOf(value: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return out;
  for (const [key, messages] of Object.entries(value)) {
    const list = Array.isArray(messages) ? messages.filter((m): m is string => typeof m === 'string') : [];
    if (list.length > 0) out[key] = list;
  }
  return out;
}

async function toError(response: Response): Promise<ApiError> {
  if (response.status === 404) return { kind: 'notFound', status: 404 };
  const problem = await readProblem(response);
  const detail = problem.detail ?? problem.title ?? response.statusText;
  switch (response.status) {
    case 400:
      return { kind: 'badRequest', status: 400, detail, errors: fieldErrorsOf(problem.errors) };
    case 409:
      return {
        kind: 'conflict', status: 409, detail,
        entity: problem.kind && problem.id ? { kind: problem.kind, id: problem.id } : null,
      };
    case 422:
      return { kind: 'unprocessable', status: 422, detail };
    default:
      return { kind: 'http', status: response.status, detail };
  }
}

/** Relative URLs only: the studio is served from the same origin as BaseApi. */
export function createApi(base = '/api/v1', fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): StudioApi {
  async function request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<ApiResult<T>> {
    const init: RequestInit = body === undefined
      ? { method, headers: { Accept: 'application/json' } }
      : { method, headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, init);
    } catch (e) {
      return { ok: false, error: { kind: 'network', message: e instanceof Error ? e.message : String(e) } };
    }
    if (!response.ok) return { ok: false, error: await toError(response) };
    // 204, and the orchestration's 202 Accepted: no body
    if (response.status === 204 || response.status === 202) return { ok: true, value: null as T };
    try {
      return { ok: true, value: (await response.json()) as T };
    } catch (e) {
      return { ok: false, error: { kind: 'http', status: 0, detail: `Unreadable response: ${e instanceof Error ? e.message : String(e)}` } };
    }
  }

  const get = <T>(path: string) => request<T>('GET', path);
  const id = (value: string) => encodeURIComponent(value);

  return {
    listWorkflows: () => get<WorkflowReadDto[]>('/workflows'),
    getStep: (stepId) => get<StepReadDto>(`/steps/${id(stepId)}`),
    getProcessor: (processorId) => get<ProcessorReadDto>(`/processors/${id(processorId)}`),
    getSchema: (schemaId) => get<SchemaReadDto>(`/schemas/${id(schemaId)}`),
    listProcessors: () => get<ProcessorReadDto[]>('/processors'),
    listCaches: () => get<CacheReadDto[]>('/caches'),
    listSchemas: () => get<SchemaReadDto[]>('/schemas'),
    listSteps: () => get<StepReadDto[]>('/steps'),
    listAssignments: () => get<AssignmentReadDto[]>('/assignments'),
    applyModel: (changes) => request<ModelApplyResultDto>('POST', '/model/apply', { changes }),
    validateModel: (changes) => request<ModelValidateResultDto>('POST', '/model/validate', { changes }),
    validateDraft: (changes, workflowIds) => request<DraftCheckDto>('POST', '/workflows/validate', { changes, workflowIds }),
    getEntity<K extends EntityKind>(kind: K, entityId: string) {
      return get<ReadDtoOf[K]>(`/${ENTITY_PATH[kind]}/${id(entityId)}`);
    },
    putEntity<K extends EntityKind>(kind: K, entityId: string, dto: UpdateDtoOf[K]) {
      return request<ReadDtoOf[K]>('PUT', `/${ENTITY_PATH[kind]}/${id(entityId)}`, dto);
    },
    createAssignment: (dto) => request<AssignmentReadDto>('POST', '/assignments', dto),
    deleteAssignment: (assignmentId) => request<null>('DELETE', `/assignments/${id(assignmentId)}`),
    listLive: () => get<unknown>('/orchestration/live'),
    listLiveness: () => get<unknown>('/processors/liveness'),
    startWorkflow: (workflowId) => request<null>('POST', '/orchestration/start', workflowId),
    stopWorkflow: (workflowId) => request<null>('POST', '/orchestration/stop', workflowId),
    publishDiagram: async (workflowId, svg) => {
      let response: Response;
      try {
        response = await fetchImpl(`${base}/workflows/${id(workflowId)}/diagram`, { method: 'PUT', headers: { 'Content-Type': 'image/svg+xml' }, body: svg });
      } catch (e) {
        return { ok: false, error: { kind: 'network', message: e instanceof Error ? e.message : String(e) } };
      }
      return response.ok ? { ok: true, value: null } : { ok: false, error: await toError(response) };
    },
    validateWorkflow: (workflowId) => request<WorkflowValidationDto>('POST', `/workflows/${id(workflowId)}/validate`),
  };
}
