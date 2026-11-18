import type { Assignment, Audit, Cache, DesignError, Graph, Processor, Schema, Step, Workflow } from '../model/graph';
import type { Point } from '../model/geometry';
import type { AssignmentRow, CacheRow, ProcessorRow, SchemaRow, StepRow, WorkflowRow } from '../design/board';
import type { AssignmentReadDto, CacheReadDto, DesignOutcomeDto, ProcessorReadDto, SchemaReadDto, StepReadDto, WorkflowDeleteOutcomeDto, WorkflowGraphDto, WorkflowReadDto } from './types';
import type { DesignLogLine } from './designLog';

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
    cronExpression: optional(dto.cronExpression),
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
    description: optional(dto.description), root: text(dto.root), items: text(dto.items), audit: audit(dto),
  };
}

export function graphFromDto(dto: WorkflowGraphDto): Graph {
  const byId = <T extends { id: string }>(items: T[]) => new Map(items.map((item) => [item.id, item]));

  const assignments: Assignment[] = (dto.assignments ?? []).map((a) => ({
    id: required(a.id, 'assignment id'), stepId: text(a.stepId), payload: text(a.payload), updatedAt: text(a.updatedAt),
    ...(typeof a.name === 'string' ? { name: a.name } : {}), ...(typeof a.version === 'string' ? { version: a.version } : {}),
    ...(a.description === null || typeof a.description === 'string' ? { description: a.description } : {}),
  }));

  if (!dto.workflow) throw new Error('The server sent no workflow.');

  return {
    workflow: workflowFromDto(dto.workflow),
    steps: byId((dto.steps ?? []).map(stepFromDto)),
    processors: byId((dto.processors ?? []).map(processorFromDto)),
    schemas: byId((dto.schemas ?? []).map(schemaFromDto)),
    assignments,
    caches: byId((dto.caches ?? []).map(cacheFromDto)),
    layout: dto.layout ?? null,
    design: dto.design ?? null,
  };
}

/** A Save's errors as the model carries them; every field read defensively. */
export function designErrorsFromDto(dto: DesignOutcomeDto): DesignError[] {
  return (dto.errors ?? []).map((e) => ({
    kind: text(e.kind), id: text(e.id), stage: text(e.stage), field: optional(e.field), message: text(e.message),
  }));
}

/** BaseApi's log of a design save (2026-10-09), in its order; null when it sent none (an older BaseApi). */
/** BaseApi's log of a design save, or of a workflow's deletion (the same lines). */
export function designLogFromDto(dto: DesignOutcomeDto | WorkflowDeleteOutcomeDto): DesignLogLine[] | null {
  if (!Array.isArray(dto.log)) return null;
  return dto.log.map((l) => ({
    stage: text(l.stage), level: l.level === 'error' ? 'error' : 'info', kind: text(l.kind), id: optional(l.id), message: text(l.message),
    ...(l.rolledBack === true ? { rolledBack: true } : {}),
  }));
}

// ---- The board's rows (design/board.ts): a plain mirror of BaseAPI's CRUD lists ----

/** A card's location: both coordinates or none. */
function atOf(dto: { boardX?: number | null; boardY?: number | null }): Point | null {
  return typeof dto.boardX === 'number' && typeof dto.boardY === 'number' ? { x: dto.boardX, y: dto.boardY } : null;
}
/** updatedAt exactly as received: it is the concurrency stamp sent back on Save. */
const stamp = (dto: { updatedAt?: string }): string => text(dto.updatedAt);

export function workflowRowFromDto(dto: WorkflowReadDto): WorkflowRow {
  return {
    id: required(dto.id, 'workflow id'), name: text(dto.name), version: text(dto.version), description: optional(dto.description),
    cronExpression: optional(dto.cronExpression), entryStepIds: list(dto.entryStepIds), assignmentIds: list(dto.assignmentIds),
    cacheIds: list(dto.cacheIds), at: atOf(dto), updatedAt: stamp(dto),
  };
}

export function stepRowFromDto(dto: StepReadDto): StepRow {
  return {
    id: required(dto.id, 'step id'), name: text(dto.name), version: text(dto.version), description: optional(dto.description),
    processorId: dto.processorId ? dto.processorId : null, nextStepIds: list(dto.nextStepIds),
    entryCondition: typeof dto.entryCondition === 'number' ? dto.entryCondition : 0, at: atOf(dto), updatedAt: stamp(dto),
  };
}

export function cacheRowFromDto(dto: CacheReadDto): CacheRow {
  return {
    id: required(dto.id, 'cache id'), name: text(dto.name), version: text(dto.version), description: optional(dto.description),
    root: text(dto.root), items: text(dto.items), at: atOf(dto), updatedAt: stamp(dto),
  };
}

export function assignmentRowFromDto(dto: AssignmentReadDto): AssignmentRow {
  return {
    id: required(dto.id, 'assignment id'), stepId: text(dto.stepId), name: text(dto.name), version: text(dto.version),
    description: optional(dto.description), payload: text(dto.payload), updatedAt: stamp(dto),
  };
}

export function processorRowFromDto(dto: ProcessorReadDto): ProcessorRow {
  return { ...processorFromDto(dto), updatedAt: stamp(dto) };
}

export function schemaRowFromDto(dto: SchemaReadDto): SchemaRow {
  return { ...schemaFromDto(dto), updatedAt: stamp(dto) };
}
