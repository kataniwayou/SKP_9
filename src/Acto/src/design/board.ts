import type { Id, Processor, Schema } from '../model/graph';
import type { Point } from '../model/geometry';
import { reachableStepIds } from '../model/reachability';

/** The board is a plain mirror of BaseAPI's rows. updatedAt null = created on the board, not saved yet. */
/** Read-only audit fields as BaseAPI sent them (null on a row made on the board); shown under "show all", never sent. */
export interface RowAudit { createdAt: string | null; createdBy: string | null; updatedBy: string | null }
export interface StepRow extends RowAudit {
  id: Id; name: string; version: string; description: string | null; processorId: Id | null;
  nextStepIds: Id[]; entryCondition: number; at: Point | null; updatedAt: string | null;
}
export interface CacheRow extends RowAudit {
  id: Id; name: string; version: string; description: string | null; root: string; items: string;
  at: Point | null; updatedAt: string | null;
}
export interface WorkflowRow extends RowAudit {
  id: Id; name: string; version: string; description: string | null; cronExpression: string | null;
  entryStepIds: Id[]; assignmentIds: Id[]; cacheIds: Id[]; at: Point | null; updatedAt: string | null;
}
export interface AssignmentRow extends RowAudit {
  id: Id; stepId: Id; name: string; version: string; description: string | null; payload: string;
  updatedAt: string | null;
}
export interface ProcessorRow extends Processor { updatedAt: string }
export interface SchemaRow extends Schema { updatedAt: string | null }

export interface BoardState {
  workflows: Record<Id, WorkflowRow>;
  steps: Record<Id, StepRow>;
  caches: Record<Id, CacheRow>;
  assignments: Record<Id, AssignmentRow>;
  processors: Record<Id, ProcessorRow>;
  schemas: Record<Id, SchemaRow>;
}

export type Edit = { state: BoardState } | { refused: string };
export type ItemRef = { kind: 'step' | 'cache' | 'workflow'; id: Id };

/** Steps reachable from the workflow's entry steps over the wires. */
export function reachOf(b: BoardState, workflowId: Id): Set<Id> {
  const wf = b.workflows[workflowId];
  if (!wf) return new Set();
  return new Set(reachableStepIds(wf.entryStepIds, new Map(Object.entries(b.steps))));
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => k in b && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** The audit fields of a row made on the board. */
export const NO_AUDIT: RowAudit = { createdAt: null, createdBy: null, updatedBy: null };

export type Slot = 'input' | 'output' | 'config';
export interface SchemaCopy { id: Id; name: string; version: string; description: string | null; definition: string }
/** The processor field that holds a slot's schema id (the same keys WorkflowStudio sends). */
export const SLOT_FIELD: Readonly<Record<Slot, 'inputSchemaId' | 'outputSchemaId' | 'configSchemaId'>> = {
  input: 'inputSchemaId', output: 'outputSchemaId', config: 'configSchemaId',
};
