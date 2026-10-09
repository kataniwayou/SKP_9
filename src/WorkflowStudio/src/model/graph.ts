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
  cronExpression: string | null;
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
  processorId: Id;
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
}

export interface Cache {
  id: Id;
  name: string;
  version: string;
  description: string | null;
  root: string;
  /** JSON text of an object of string items. */
  items: string;
  audit: Audit;
}

/** One error BaseApi's design dry run reported (plan 8 §4.3). Only ever the answer to a Save; never stored. */
export interface DesignError {
  kind: string;
  id: Id;
  stage: string;
  field: string | null;
  message: string;
  /** A short circuit of two wires lying on each other (kind `wire`): the other wire (studio only). */
  other?: Id;
}

export interface Graph {
  workflow: Workflow;
  steps: Map<Id, Step>;
  processors: Map<Id, Processor>;
  schemas: Map<Id, Schema>;
  assignments: Assignment[];
  caches: Map<Id, Cache>;
  /** The stored canvas layout exactly as the server returned it (opaque JSON), or null. */
  layout: unknown;
  /** The studio's stored design exactly as the server returned it (opaque JSON), or null (plan 8). */
  design: unknown;
}
