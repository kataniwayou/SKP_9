import type { Id } from '../model/graph';
import { SLOT_FIELD, type BoardState, type Slot } from './board';

export type SchemaState = 'wired' | 'held' | 'orphan';
export interface SchemaRef { owner: { kind: 'step' | 'processor'; id: Id }; slot: Slot; schemaId: Id }

const SLOTS: Slot[] = ['input', 'output', 'config'];
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function usedProcessors(b: BoardState): Set<Id> {
  const used = new Set<Id>();
  for (const s of Object.values(b.steps)) if (s.processorId !== null) used.add(s.processorId);
  return used;
}

/** The schema ids a processor fills, in slot order, skipping ids not on the board. */
function slotRefs(b: BoardState, processorId: Id): { slot: Slot; schemaId: Id }[] {
  const p = b.processors[processorId];
  if (!p) return [];
  const out: { slot: Slot; schemaId: Id }[] = [];
  for (const slot of SLOTS) {
    const schemaId = p[SLOT_FIELD[slot]];
    if (schemaId !== null && schemaId !== undefined && b.schemas[schemaId]) out.push({ slot, schemaId });
  }
  return out;
}

export function schemaStates(b: BoardState): Record<Id, SchemaState> {
  const used = usedProcessors(b);
  const out: Record<Id, SchemaState> = {};
  for (const id of Object.keys(b.schemas)) out[id] = 'orphan';
  for (const pid of Object.keys(b.processors)) {
    for (const { schemaId } of slotRefs(b, pid)) {
      if (used.has(pid)) out[schemaId] = 'wired';
      else if (out[schemaId] === 'orphan') out[schemaId] = 'held';
    }
  }
  return out;
}

export function steplessProcessors(b: BoardState): Id[] {
  const used = usedProcessors(b);
  return Object.keys(b.processors)
    .filter((id) => !used.has(id) && slotRefs(b, id).length > 0)
    .sort(byId);
}

export function schemaRefs(b: BoardState): SchemaRef[] {
  const refs: SchemaRef[] = [];
  for (const sid of Object.keys(b.steps).sort(byId)) {
    const pid = b.steps[sid].processorId;
    if (pid === null) continue;
    for (const r of slotRefs(b, pid)) refs.push({ owner: { kind: 'step', id: sid }, ...r });
  }
  for (const pid of steplessProcessors(b)) {
    for (const r of slotRefs(b, pid)) refs.push({ owner: { kind: 'processor', id: pid }, ...r });
  }
  return refs;
}

export function orphanCount(b: BoardState): number {
  return Object.values(schemaStates(b)).filter((s) => s === 'orphan').length;
}

export function heldBy(b: BoardState, schemaId: Id): Id[] {
  return steplessProcessors(b).filter((pid) => slotRefs(b, pid).some((r) => r.schemaId === schemaId));
}
