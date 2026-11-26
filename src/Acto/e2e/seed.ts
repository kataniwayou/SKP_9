import { randomUUID } from 'node:crypto';
import { appendItems, apply, baseline, getJson, type Change, type Row } from './stack';

/** A point in the e2e region of the board (flow units, from the region's corner). */
export interface Pt { x: number; y: number }

export interface StepSeed { key: string; name: string; at: Pt; /** A real processor's name, or the key of a seeded ProcessorSeed. */ processor?: string; next?: readonly string[]; condition?: number }
/** A throwaway schema: `definition` is its JSON text (default `{}`), `at` its place on the board. */
export interface SchemaSeed { key: string; name: string; definition?: string; at?: Pt }
/** A throwaway processor, made through the API only (Acto never creates one). The slots are SchemaSeed keys. */
export interface ProcessorSeed { key: string; name: string; sourceHash: string; input?: string; output?: string; config?: string; at?: Pt }
export interface CacheSeed { key: string; name: string; at: Pt; root?: string; /** Stored items, appended over HTTP after the cache is created empty. */ items?: Readonly<Record<string, string>> }
/** A payload row: one step's payload, which any number of workflows may link. */
export interface PayloadSeed { key: string; step: string; payload: string }
export interface WorkflowSeed { key: string; name: string; at: Pt; entry?: readonly string[]; caches?: readonly string[]; payloads?: readonly string[]; /** An entry arrow's own cron, by the entry step's key (a workflow has no cron of its own). */ entryCrons?: Readonly<Record<string, string>> }
export interface SeedSpec { schemas?: readonly SchemaSeed[]; processors?: readonly ProcessorSeed[]; steps?: readonly StepSeed[]; caches?: readonly CacheSeed[]; payloads?: readonly PayloadSeed[]; workflows?: readonly WorkflowSeed[] }

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
  const placed = (p?: Pt) => (p ? at(p) : {});
  const procOf = async (key?: string) => (key && id.has(key) ? ref(key) : processorId(key ?? 'archive-expander'));

  // schemas first, then the processors that reference them (teardown deletes in the opposite order)
  for (const x of spec.schemas ?? []) {
    changes.push({ op: 'create', table: 'schemas', id: make(x.key), row: { name: x.name, version: '1.0.0', description: null, definition: x.definition ?? '{}', ...placed(x.at) } });
  }
  for (const p of spec.processors ?? []) {
    changes.push({ op: 'create', table: 'processors', id: make(p.key), row: {
      name: p.name, version: '1.0.0', description: null, sourceHash: p.sourceHash, instanceId: null,
      inputSchemaId: p.input ? ref(p.input) : null, outputSchemaId: p.output ? ref(p.output) : null, configSchemaId: p.config ? ref(p.config) : null, ...placed(p.at),
    } });
  }

  for (const k of spec.caches ?? []) {
    changes.push({ op: 'create', table: 'caches', id: make(k.key), row: { name: k.name, version: '1.0.0', description: null, root: k.root ?? 'e2e', ...at(k.at) } });
  }
  for (const s of spec.steps ?? []) {
    changes.push({ op: 'create', table: 'steps', id: make(s.key), row: {
      name: s.name, version: '1.0.0', description: null, processorId: await procOf(s.processor),
      nextStepIds: [], entryCondition: s.condition ?? 1, ...at(s.at),
    } });
  }
  for (const p of spec.payloads ?? []) {
    changes.push({ op: 'create', table: 'assignments', id: make(p.key), row: { name: `e2e-pay-${p.key}`, version: '1.0.0', description: null, stepId: ref(p.step), payload: p.payload } });
  }
  for (const w of spec.workflows ?? []) {
    changes.push({ op: 'create', table: 'workflows', id: make(w.key), row: {
      name: w.name, version: '1.0.0', description: null, entryStepIds: (w.entry ?? []).map(ref),
      entryCrons: Object.fromEntries(Object.entries(w.entryCrons ?? {}).map(([k, v]) => [ref(k), v])),
      assignmentIds: (w.payloads ?? []).map(ref), cacheIds: (w.caches ?? []).map(ref), ...at(w.at),
    } });
  }
  for (const s of spec.steps ?? []) {
    if (!s.next?.length) continue;
    changes.push({ op: 'update', table: 'steps', id: ref(s.key), row: {
      name: s.name, version: '1.0.0', description: null, processorId: await procOf(s.processor),
      nextStepIds: s.next.map(ref), entryCondition: s.condition ?? 1, ...at(s.at),
    } });
  }
  const done = await apply(changes);
  for (const k of spec.caches ?? []) {
    if (k.items && Object.keys(k.items).length) await appendItems(done.made?.[ref(k.key)] ?? ref(k.key), { ...k.items });
  }
  return Object.fromEntries([...id].map(([key, client]) => [key, done.made?.[client] ?? client]));
}
