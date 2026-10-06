/**
 * The graph as the studio reasons about it. Plain data: no React, no I/O.
 *
 * Steps belong to no workflow (spec §2): a workflow names its entry steps, and its step set is
 * whatever is reachable over `nextStepIds`. A wire is a `nextStepIds` entry on its source step.
 */
export type Id = string;

export interface Workflow {
  id: Id;
  name: string;
  version: string;
  cronExpression: string | null;
  entryStepIds: Id[];
  assignmentIds: Id[];
  cacheIds: Id[];
  updatedAt: string;
}

export interface Step {
  id: Id;
  name: string;
  version: string;
  processorId: Id;
  nextStepIds: Id[];
  /** 0..5 on the wire; see model/entryConditions.ts. 0 is invalid but can still arrive. */
  entryCondition: number;
  updatedAt: string;
}

export interface Processor {
  id: Id;
  name: string;
  version: string;
  inputSchemaId: Id | null;
  outputSchemaId: Id | null;
  configSchemaId: Id | null;
}

export interface Schema {
  id: Id;
  name: string;
  version: string;
}

export interface Assignment {
  id: Id;
  stepId: Id;
  /** JSON text. */
  payload: string;
}

export interface Cache {
  id: Id;
  name: string;
  root: string;
  /** JSON text of an object of string items. */
  items: string;
}

/**
 * One problem BaseApi's validate reported (plan 1b). The studio never derives these: it only draws
 * them. `offending` is the gate's own object (for gate "schemaEdge": `{ parentStepId, childStepId }`).
 */
export interface WorkflowProblem {
  gate: string;
  title: string;
  detail: string;
  offending: unknown;
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
}
