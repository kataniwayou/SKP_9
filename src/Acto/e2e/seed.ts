import { randomUUID } from 'node:crypto';
import { apply, baseline, getJson, type Change, type Row } from './stack';

/** A point in the e2e region of the board (flow units, from the region's corner). */
export interface Pt { x: number; y: number }

export interface StepSeed { key: string; name: string; at: Pt; processor?: string; next?: readonly string[]; condition?: number }
export interface CacheSeed { key: string; name: string; at: Pt }
/** A payload row: one step's payload, which any number of workflows may link. */
export interface PayloadSeed { key: string; step: string; payload: string }
export interface WorkflowSeed { key: string; name: string; at: Pt; entry?: readonly string[]; caches?: readonly string[]; payloads?: readonly string[]; cron?: string | null }
export interface SeedSpec { steps?: readonly StepSeed[]; caches?: readonly CacheSeed[]; payloads?: readonly PayloadSeed[]; workflows?: readonly WorkflowSeed[] }

/** The ids BaseAPI gave, by the seed's keys. */
export type Seeded = Record<string, string>;

/**
 * The corner of the board where the specs put their throwaway items: right of everything the stack holds (Acto's own
 * placement of unplaced rows stays well inside 1800), at the height of the top real row.
 */
export function regionCorner(): Pt {
  const { snapshot } = baseline();
  const rows = [...snapshot.workflows, ...snapshot.steps, ...snapshot.caches];
  const xs = rows.map((r) => r.boardX).filter((v): v is number => typeof v === 'number');
  const ys = rows.map((r) => r.boardY).filter((v): v is number => typeof v === 'number');
  return { x: Math.max(0, ...xs) + 1800, y: Math.min(0, ...ys) };
}

let processors: Row[] | null = null;
export async function processorId(name: string): Promise<string> {
  processors ??= await getJson<Row[]>('/processors');
  const p = processors.find((x) => x.name === name);
  if (!p) throw new Error(`no processor ${name} on the stack`);
  return p.id;
}

/** Throwaway rows through /model/apply (the same runner Acto saves through), named by the caller (always e2e-...). */
export async function seed(spec: SeedSpec): Promise<Seeded> {
  const c = regionCorner();
  const at = (p: Pt) => ({ boardX: c.x + p.x, boardY: c.y + p.y });
  const id = new Map<string, string>();
  const make = (key: string) => { const v = randomUUID(); id.set(key, v); return v; };
  const ref = (key: string) => { const v = id.get(key); if (!v) throw new Error(`seed: unknown key ${key}`); return v; };
  const changes: Change[] = [];

  for (const k of spec.caches ?? []) {
    changes.push({ op: 'create', table: 'caches', id: make(k.key), row: { name: k.name, version: '1.0.0', description: null, root: 'e2e', items: '{}', ...at(k.at) } });
  }
  for (const s of spec.steps ?? []) {
    changes.push({ op: 'create', table: 'steps', id: make(s.key), row: {
      name: s.name, version: '1.0.0', description: null, processorId: await processorId(s.processor ?? 'archive-expander'),
      nextStepIds: [], entryCondition: s.condition ?? 1, ...at(s.at),
    } });
  }
  for (const p of spec.payloads ?? []) {
    changes.push({ op: 'create', table: 'assignments', id: make(p.key), row: { name: `e2e-pay-${p.key}`, version: '1.0.0', description: null, stepId: ref(p.step), payload: p.payload } });
  }
  for (const w of spec.workflows ?? []) {
    changes.push({ op: 'create', table: 'workflows', id: make(w.key), row: {
      name: w.name, version: '1.0.0', description: null, cronExpression: w.cron ?? null, entryStepIds: (w.entry ?? []).map(ref),
      assignmentIds: (w.payloads ?? []).map(ref), cacheIds: (w.caches ?? []).map(ref), ...at(w.at),
    } });
  }
  for (const s of spec.steps ?? []) {
    if (!s.next?.length) continue;
    changes.push({ op: 'update', table: 'steps', id: ref(s.key), row: {
      name: s.name, version: '1.0.0', description: null, processorId: await processorId(s.processor ?? 'archive-expander'),
      nextStepIds: s.next.map(ref), entryCondition: s.condition ?? 1, ...at(s.at),
    } });
  }
  const done = await apply(changes);
  return Object.fromEntries([...id].map(([key, client]) => [key, done.made?.[client] ?? client]));
}
