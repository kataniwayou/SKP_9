/**
 * The graph as the studio reasons about it. Plain data: no React, no I/O.
 *
 * Steps belong to no workflow (spec §2): a workflow names its entry steps, and its step set is
 * whatever is reachable over `nextStepIds`. A wire is a `nextStepIds` entry on its source step.
 */
export type Id = string;

/**
 * The base-entity fields every BaseApi read DTO carries. The Inspector shows them under
 * "▸ show all" (spec §7). `updatedAt` here is for display; `Workflow.updatedAt` and
 * `Step.updatedAt` stay the concurrency tokens a later save sends back.
 */
export interface Audit {
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export interface Workflow {
  id: Id;
  name: string;
  version: string;
  description: string | null;
  entryStepIds: Id[];
  assignmentIds: Id[];
  cacheIds: Id[];
  updatedAt: string;
  audit: Audit;
}

export interface Step {
  id: Id;
  name: string;
  version: string;
  description: string | null;
  /** null: the design removed its processor (2026-10-10; the step keeps its place, Save is refused on it until it has one). */
  processorId: Id | null;
  nextStepIds: Id[];
  /** 0..5 on the wire; see model/entryConditions.ts. 0 is invalid but can still arrive. */
  entryCondition: number;
  updatedAt: string;
  audit: Audit;
}

export interface Processor {
  id: Id;
  name: string;
  version: string;
  description: string | null;
  /** 64 lowercase hex characters (BaseApi's rule); shown whole in a tooltip, cut on screen. */
  sourceHash: string;
  instanceId: string | null;
  inputSchemaId: Id | null;
  outputSchemaId: Id | null;
  configSchemaId: Id | null;
  audit: Audit;
}

export interface Schema {
  id: Id;
  /** The JSON Schema text; absent where a caller did not load it. */
  definition?: string | null;
  name: string;
  version: string;
  description: string | null;
  audit: Audit;
}

export interface Assignment {
  id: Id;
  stepId: Id;
  /** JSON text. */
  payload: string;
  /** The concurrency stamp a remove or an edit sends back (plan 8). */
  updatedAt: string;
  /** Its own fields as the graph read carries them (copy and paste keeps them, 2026-10-10 review); absent in older fixtures. */
  name?: string;
  version?: string;
  description?: string | null;
}

export interface Cache {
  id: Id;
  name: string;
  version: string;
  description: string | null;
  root: string;
  /** How many items the cache holds; the items themselves are paged (GET /caches/{id}/items). */
  itemCount: number;
  audit: Audit;
}
