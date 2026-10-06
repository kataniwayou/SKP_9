import type { EntityKind, EntityReadDto, ReadDtoOf, UpdateDtoOf } from '../api/entities';
import type { AssignmentCreateDto, AssignmentReadDto } from '../api/types';
import type { Id } from '../model/graph';

export type FieldKind = 'text' | 'multiline' | 'json' | 'condition';

/** One writable field of the Inspector (spec §7.1's table). */
export interface FieldSpec {
  key: string;
  label: string;
  kind: FieldKind;
  /** Save is disabled while it is blank (Name and Version only, spec §7.1). */
  required?: boolean;
  /** Blank text is sent as null. */
  nullable?: boolean;
}

const NAME: FieldSpec = { key: 'name', label: 'Name', kind: 'text', required: true };
const VERSION: FieldSpec = { key: 'version', label: 'Version', kind: 'text', required: true };
const DESCRIPTION: FieldSpec = { key: 'description', label: 'Description', kind: 'multiline', nullable: true };

/** The writable fields, in the order the Inspector shows them; the first two are the head. */
export const FIELDS: Record<EntityKind, readonly FieldSpec[]> = {
  workflow: [NAME, VERSION, DESCRIPTION, { key: 'cronExpression', label: 'Cron', kind: 'text', nullable: true }],
  step: [NAME, VERSION, DESCRIPTION, { key: 'entryCondition', label: 'Entry condition', kind: 'condition' }],
  assignment: [NAME, VERSION, DESCRIPTION, { key: 'payload', label: 'Payload', kind: 'json' }],
  processor: [NAME, VERSION, DESCRIPTION, { key: 'sourceHash', label: 'Source hash', kind: 'text' }, { key: 'instanceId', label: 'Instance id', kind: 'text', nullable: true }],
  schema: [NAME, VERSION, DESCRIPTION, { key: 'definition', label: 'Definition', kind: 'json' }],
  cache: [NAME, VERSION, DESCRIPTION, { key: 'root', label: 'Root', kind: 'text' }, { key: 'items', label: 'Items', kind: 'json' }],
};

/** Every field of each update DTO, in the generated type's order: exactly what a PUT sends. */
export const UPDATE_KEYS: Record<EntityKind, readonly string[]> = {
  workflow: ['name', 'version', 'description', 'entryStepIds', 'assignmentIds', 'cacheIds', 'cronExpression'],
  step: ['name', 'version', 'description', 'processorId', 'nextStepIds', 'entryCondition'],
  assignment: ['name', 'version', 'description', 'stepId', 'payload'],
  processor: ['name', 'version', 'description', 'sourceHash', 'instanceId', 'inputSchemaId', 'outputSchemaId', 'configSchemaId'],
  schema: ['name', 'version', 'description', 'definition'],
  cache: ['name', 'version', 'description', 'root', 'items'],
};

const field = (dto: EntityReadDto, key: string): unknown => (dto as Record<string, unknown>)[key];

/** A saved value as form text: null and absent read as '', the entry condition as its number. */
export function savedText(dto: EntityReadDto, key: string): string {
  const value = field(dto, key);
  return value === null || value === undefined ? '' : String(value);
}

/** What the form shows: the typed text when there is some, else the saved value. */
export function shownText(dto: EntityReadDto, edits: Readonly<Record<string, string>>, key: string): string {
  return Object.hasOwn(edits, key) ? edits[key]! : savedText(dto, key);
}

function toDtoValue(spec: FieldSpec, text: string): unknown {
  if (spec.kind === 'condition') return Number(text);
  if (spec.nullable && text.trim() === '') return null;
  return text;
}

/**
 * The PUT body (spec §7.1, §9): every field of the update DTO exactly as `saved` has it (structural
 * lists and ids included; null stays null), then only the edited writable fields replaced.
 */
export function updateDto<K extends EntityKind>(kind: K, saved: ReadDtoOf[K], edits: Readonly<Record<string, string>>): UpdateDtoOf[K] {
  const body: Record<string, unknown> = {};
  for (const key of UPDATE_KEYS[kind]) body[key] = field(saved, key) ?? null;
  for (const spec of FIELDS[kind]) if (Object.hasOwn(edits, spec.key)) body[spec.key] = toDtoValue(spec, edits[spec.key]!);
  return body as UpdateDtoOf[K];
}

/** True while Name or Version would be sent blank: Save stays disabled. */
export function missingRequired(kind: EntityKind, dto: EntityReadDto, edits: Readonly<Record<string, string>>): boolean {
  return FIELDS[kind].some((spec) => spec.required === true && shownText(dto, edits, spec.key).trim() === '');
}

/** "Not valid JSON" while a JSON field does not parse; the server still judges it on save. */
export function jsonProblem(text: string): string | null {
  try {
    JSON.parse(text);
    return null;
  } catch {
    return 'Not valid JSON';
  }
}

/**
 * A 400's messages (keys are C# property names: `CronExpression`) under the form's fields
 * (`cronExpression`); messages about anything the form does not edit go to `other`, for the banner.
 */
export function splitErrors(kind: EntityKind, errors: Readonly<Record<string, string[]>>): { fields: Record<string, string[]>; other: string[] } {
  const writable = new Set(FIELDS[kind].map((spec) => spec.key));
  const fields: Record<string, string[]> = {};
  const other: string[] = [];
  for (const [name, messages] of Object.entries(errors)) {
    const key = name.charAt(0).toLowerCase() + name.slice(1);
    if (writable.has(key)) fields[key] = [...(fields[key] ?? []), ...messages];
    else other.push(...messages);
  }
  return { fields, other };
}

/** The new-assignment form's starting values (spec §7.1); `id` stays '' until it is created. */
export function newAssignmentDto(step: { id: Id; name: string }): AssignmentReadDto {
  return { id: '', name: `${step.name}-assignment`, version: '1.0.0', description: null, stepId: step.id, payload: '{}' } as AssignmentReadDto;
}

/** The POST body for the new-assignment form: its starting values with what was typed. */
export function createAssignmentDto(saved: AssignmentReadDto, edits: Readonly<Record<string, string>>): AssignmentCreateDto {
  return updateDto('assignment', saved, edits);
}
