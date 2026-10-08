import type { EntityReadDto } from '../api/entities';
import { entityName } from '../model/entityNames';
import type { InspectorTarget } from '../store/inspectorTarget';

/** One read-only line of the Inspector. `value` is always text: an absent value reads "—". */
export interface Row {
  label: string;
  value: string;
}

const NONE = '—';
const text = (value: string | null | undefined): string => (value === null || value === undefined || value === '' ? NONE : value);

/** `2026-10-05T12:00:00.123456Z` → `2026-10-05 12:00:00.123 UTC`; anything else is shown as it came. */
export function formatInstant(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?Z$/.exec(iso);
  if (!m) return text(iso);
  return `${m[1]} ${m[2]}${m[3] ? m[3].slice(0, 4) : ''} UTC`;
}

/** The base-entity fields behind "▸ show all" (spec §7), from the entity's last GET. */
export function detailRows(dto: EntityReadDto): Row[] {
  return [
    { label: 'Id', value: text(dto.id) },
    { label: 'Created at', value: formatInstant(dto.createdAt ?? '') },
    { label: 'Created by', value: text(dto.createdBy) },
    { label: 'Updated at', value: formatInstant(dto.updatedAt ?? '') },
    { label: 'Updated by', value: text(dto.updatedBy) },
  ];
}

/** The unique name (spec §7) by the saved name and version, never by what is being typed. */
export function uniqueNameOf(dto: EntityReadDto): string {
  return entityName(dto.name ?? '', dto.version ?? '', dto.id ?? '');
}

/** The kind pill. An unwired step is an ordinary step (plan 8). */
export function kindLabel(target: InspectorTarget): string {
  return target.kind.toUpperCase();
}
