import type { EntityKind, EntityReadDto } from '../api/entities';
import type { FieldValue } from '../design/design';

export type FieldKind = 'text' | 'multiline' | 'json' | 'condition';

/** One writable field of the Inspector (spec §7.1's table). */
export interface FieldSpec {
  key: string;
  label: string;
  kind: FieldKind;
  /** Name and Version (spec §7.1): blank, the field shows the saved value as its placeholder. */
  required?: boolean;
  /** Blank text is kept as null. */
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

/** Typed text as the design keeps it (plan 8): the entry condition's number; a blank nullable field is null. */
export function fieldValue(spec: FieldSpec, text: string): FieldValue {
  if (spec.kind === 'condition') return Number(text);
  if (spec.nullable && text.trim() === '') return null;
  return text;
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
