import type { Audit, Cache, Processor, Schema, Step, Workflow } from '../model/graph';
import type { Point } from '../model/geometry';
import type { AssignmentRow, CacheRow, RowAudit, ProcessorRow, SchemaRow, StepRow, WorkflowRow } from '../design/board';
import type { AssignmentReadDto, CacheReadDto, ProcessorReadDto, SchemaReadDto, StepReadDto, WorkflowReadDto } from './types';
import { itemsToText } from './cacheItems';

// The generated DTO types mark almost every field optional (see api/types.ts). These helpers state
// once what the server actually guarantees, so the model never carries undefined.

function required(value: string | null | undefined, field: string): string {
  if (value === null || value === undefined || value === '') throw new Error(`The server sent no ${field}.`);
  return value;
}
const text = (value: string | null | undefined): string => value ?? '';
const optional = (value: string | null | undefined): string | null => value ?? null;
const list = (value: (string | null | undefined)[] | null | undefined): string[] =>
  (value ?? []).filter((v): v is string => typeof v === 'string' && v !== '');

type Audited = { createdAt?: string; createdBy?: string | null; updatedAt?: string; updatedBy?: string | null };
const audit = (dto: Audited): Audit => ({
  createdAt: text(dto.createdAt), createdBy: optional(dto.createdBy),
  updatedAt: text(dto.updatedAt), updatedBy: optional(dto.updatedBy),
});

export function workflowFromDto(dto: WorkflowReadDto): Workflow {
  return {
    id: required(dto.id, 'workflow id'),
    name: text(dto.name),
    version: text(dto.version),
    description: optional(dto.description),
    entryStepIds: list(dto.entryStepIds),
    assignmentIds: list(dto.assignmentIds),
    cacheIds: list(dto.cacheIds),
    updatedAt: text(dto.updatedAt),
    audit: audit(dto),
  };
}

export function stepFromDto(dto: StepReadDto): Step {
  return {
    id: required(dto.id, 'step id'),
    name: text(dto.name),
    version: text(dto.version),
    description: optional(dto.description),
    processorId: text(dto.processorId),
    nextStepIds: list(dto.nextStepIds),
    entryCondition: typeof dto.entryCondition === 'number' ? dto.entryCondition : 0,
    updatedAt: text(dto.updatedAt),
    audit: audit(dto),
  };
}

export function processorFromDto(dto: ProcessorReadDto): Processor {
  return {
    id: required(dto.id, 'processor id'),
    name: text(dto.name),
    version: text(dto.version),
    description: optional(dto.description),
    sourceHash: text(dto.sourceHash),
    instanceId: optional(dto.instanceId),
    inputSchemaId: optional(dto.inputSchemaId),
    outputSchemaId: optional(dto.outputSchemaId),
    configSchemaId: optional(dto.configSchemaId),
    audit: audit(dto),
  };
}

export function schemaFromDto(dto: SchemaReadDto): Schema {
  return {
    id: required(dto.id, 'schema id'), name: text(dto.name), version: text(dto.version),
    description: optional(dto.description), definition: optional(dto.definition), audit: audit(dto),
  };
}

export function cacheFromDto(dto: CacheReadDto): Cache {
  return {
    id: required(dto.id, 'cache id'), name: text(dto.name), version: text(dto.version),
    description: optional(dto.description), root: text(dto.root), items: itemsToText(dto.items), audit: audit(dto),
  };
}

// ---- The board's rows (design/board.ts): a plain mirror of BaseAPI's CRUD lists ----

/** A card's location: both coordinates or none. */
function atOf(dto: { boardX?: number | null; boardY?: number | null }): Point | null {
  return typeof dto.boardX === 'number' && typeof dto.boardY === 'number' ? { x: dto.boardX, y: dto.boardY } : null;
}
/** updatedAt exactly as received: it is the concurrency stamp sent back on Save. */
const stamp = (dto: { updatedAt?: string }): string => text(dto.updatedAt);
/** The read-only audit fields a row keeps for "show all" (never sent back). */
const rowAudit = (dto: Audited): RowAudit => ({
  createdAt: optional(dto.createdAt), createdBy: optional(dto.createdBy), updatedBy: optional(dto.updatedBy),
});

export function workflowRowFromDto(dto: WorkflowReadDto): WorkflowRow {
  return {
    id: required(dto.id, 'workflow id'), name: text(dto.name), version: text(dto.version), description: optional(dto.description),
    entryStepIds: list(dto.entryStepIds), assignmentIds: list(dto.assignmentIds),
    cacheIds: list(dto.cacheIds), entryCrons: { ...(dto.entryCrons ?? {}) }, at: atOf(dto), updatedAt: stamp(dto), ...rowAudit(dto),
  };
}

export function stepRowFromDto(dto: StepReadDto): StepRow {
  return {
    id: required(dto.id, 'step id'), name: text(dto.name), version: text(dto.version), description: optional(dto.description),
    processorId: dto.processorId ? dto.processorId : null, nextStepIds: list(dto.nextStepIds),
    entryCondition: typeof dto.entryCondition === 'number' ? dto.entryCondition : 0, at: atOf(dto), updatedAt: stamp(dto), ...rowAudit(dto),
  };
}

export function cacheRowFromDto(dto: CacheReadDto): CacheRow {
  return {
    id: required(dto.id, 'cache id'), name: text(dto.name), version: text(dto.version), description: optional(dto.description),
    root: text(dto.root), items: itemsToText(dto.items), at: atOf(dto), updatedAt: stamp(dto), ...rowAudit(dto),
  };
}

export function assignmentRowFromDto(dto: AssignmentReadDto): AssignmentRow {
  return {
    id: required(dto.id, 'assignment id'), stepId: text(dto.stepId), name: text(dto.name), version: text(dto.version),
    description: optional(dto.description), payload: text(dto.payload), updatedAt: stamp(dto), ...rowAudit(dto),
  };
}

export function processorRowFromDto(dto: ProcessorReadDto): ProcessorRow {
  return { ...processorFromDto(dto), updatedAt: stamp(dto) };
}

export function schemaRowFromDto(dto: SchemaReadDto): SchemaRow {
  return { ...schemaFromDto(dto), updatedAt: stamp(dto) };
}
