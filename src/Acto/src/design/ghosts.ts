import type { OutputStore } from '../output/outputStore';
import type { Id } from '../model/graph';
import type { Point } from '../model/geometry';
import { NO_AUDIT, type AssignmentRow, type BoardState, type CacheRow, type Edit, type SchemaRow, type StepRow, type WorkflowRow } from './board';
import type { BoardStore } from './boardStore';

/** An assignment row on a step as last seen, with the workflows that linked it then. */
export interface StepAssignment { row: AssignmentRow; workflowIds: Id[] }

/**
 * A board item seen earlier in this page session and not on the board now: its last snapshot. Keys: `step:<id>`,
 * `cache:<id>`, `workflow:<id>`, `schema:<id>`, `wire:<from>:<to>`, `entry:<wf>:<step>`, `cacheLink:<wf>:<cache>`.
 * A wire's `condition` is its target step's entryCondition when the wire was last seen.
 */
export type GhostItem = { key: string } & (
  | { kind: 'step'; row: StepRow; assignments?: StepAssignment[] }
  | { kind: 'cache'; row: CacheRow }
  | { kind: 'workflow'; row: WorkflowRow; assignments: AssignmentRow[] }
  | { kind: 'schema'; row: SchemaRow }
  | { kind: 'wire'; from: Id; to: Id; condition: number }
  | { kind: 'entry'; workflowId: Id; stepId: Id; cron?: string }
  | { kind: 'cacheLink'; workflowId: Id; cacheId: Id }
);

export interface GhostStore {
  /** The ghosts, oldest seen first; the same array until something changes. */
  ghosts(): GhostItem[];
  get(key: string): GhostItem | undefined;
  /** Drops these ghosts for this session (not an undo step); one comes back if its item is on the board and goes again. */
  remove(keys: string[]): void;
  /** Moves ghost steps, caches, workflows and schemas to these places (their rows' `at`); kept with the ghosts, not an undo step. Other keys are ignored. */
  moveGhosts(moves: { key: string; at: Point }[]): void;
  /** Saved creates take BaseAPI's ids: recorded keys and the ids inside the snapshots. Call before the board adopts the re-read. */
  remap(made: Record<string, string>): void;
  subscribe(fn: () => void): () => void;
}

/** Every item on the board, keyed as ghosts are. */
function itemsOf(b: BoardState): Map<string, GhostItem> {
  const out = new Map<string, GhostItem>();
  const linkers = new Map<Id, Id[]>();
  for (const w of Object.values(b.workflows)) {
    for (const a of w.assignmentIds) linkers.set(a, [...(linkers.get(a) ?? []), w.id]);
  }
  const byStep = new Map<Id, StepAssignment[]>();
  for (const a of Object.values(b.assignments)) {
    byStep.set(a.stepId, [...(byStep.get(a.stepId) ?? []), { row: a, workflowIds: linkers.get(a.id) ?? [] }]);
  }
  for (const s of Object.values(b.steps)) {
    out.set(`step:${s.id}`, { key: `step:${s.id}`, kind: 'step', row: s, assignments: byStep.get(s.id) ?? [] });
  }
  for (const s of Object.values(b.steps)) {
    for (const to of s.nextStepIds) {
      const t = b.steps[to];
      if (!t) continue;
      const key = `wire:${s.id}:${to}`;
      out.set(key, { key, kind: 'wire', from: s.id, to, condition: t.entryCondition });
    }
  }
  for (const c of Object.values(b.caches)) out.set(`cache:${c.id}`, { key: `cache:${c.id}`, kind: 'cache', row: c });
  for (const s of Object.values(b.schemas)) out.set(`schema:${s.id}`, { key: `schema:${s.id}`, kind: 'schema', row: s });
  for (const w of Object.values(b.workflows)) {
    const assignments = w.assignmentIds.map((a) => b.assignments[a]).filter((a): a is AssignmentRow => !!a);
    out.set(`workflow:${w.id}`, { key: `workflow:${w.id}`, kind: 'workflow', row: w, assignments });
    for (const st of w.entryStepIds) {
      if (b.steps[st]) out.set(`entry:${w.id}:${st}`, { key: `entry:${w.id}:${st}`, kind: 'entry', workflowId: w.id, stepId: st, ...(w.entryCrons[st] ? { cron: w.entryCrons[st] } : {}) });
    }
    for (const c of w.cacheIds) {
      if (b.caches[c]) out.set(`cacheLink:${w.id}:${c}`, { key: `cacheLink:${w.id}:${c}`, kind: 'cacheLink', workflowId: w.id, cacheId: c });
    }
  }
  return out;
}

function remapItem(g: GhostItem, m: (id: Id) => Id): GhostItem {
  const asg = (a: AssignmentRow): AssignmentRow => ({ ...a, id: m(a.id), stepId: m(a.stepId) });
  switch (g.kind) {
    case 'step': {
      const row = { ...g.row, id: m(g.row.id), nextStepIds: g.row.nextStepIds.map(m), processorId: g.row.processorId === null ? null : m(g.row.processorId) };
      return { key: `step:${row.id}`, kind: 'step', row, assignments: g.assignments?.map((x) => ({ row: asg(x.row), workflowIds: x.workflowIds.map(m) })) };
    }
    case 'cache': return { key: `cache:${m(g.row.id)}`, kind: 'cache', row: { ...g.row, id: m(g.row.id) } };
    case 'workflow': {
      const row = { ...g.row, id: m(g.row.id), entryStepIds: g.row.entryStepIds.map(m), entryCrons: Object.fromEntries(Object.entries(g.row.entryCrons ?? {}).map(([k, v]) => [m(k), v])), assignmentIds: g.row.assignmentIds.map(m), cacheIds: g.row.cacheIds.map(m) };
      return { key: `workflow:${row.id}`, kind: 'workflow', row, assignments: g.assignments.map(asg) };
    }
    case 'schema': return { key: `schema:${m(g.row.id)}`, kind: 'schema', row: { ...g.row, id: m(g.row.id) } };
    case 'wire': return { key: `wire:${m(g.from)}:${m(g.to)}`, kind: 'wire', from: m(g.from), to: m(g.to), condition: g.condition };
    case 'entry': return { key: `entry:${m(g.workflowId)}:${m(g.stepId)}`, kind: 'entry', workflowId: m(g.workflowId), stepId: m(g.stepId), ...(g.cron ? { cron: g.cron } : {}) };
    case 'cacheLink': return { key: `cacheLink:${m(g.workflowId)}:${m(g.cacheId)}`, kind: 'cacheLink', workflowId: m(g.workflowId), cacheId: m(g.cacheId) };
  }
}

const GHOSTS_KEY = 'acto.ghosts';

/**
 * Writes the store's ghosts to `storage` now and on every change; answers the unsubscribe. Only the store the page uses
 * is kept: a twin (React StrictMode creates one) that never saw a Remove must not overwrite it.
 */
export function keepGhosts(ghosts: GhostStore, storage: Storage | null | undefined, output?: OutputStore): () => void {
  let warned = false;
  const write = () => {
    try { storage?.setItem(GHOSTS_KEY, JSON.stringify(ghosts.ghosts())); } catch (e) {
      // blocked or full storage: the ghosts stay in this page only; said once, as the draft does
      if (warned) return;
      warned = true;
      output?.log(`Ghosts are no longer kept across refresh: ${e instanceof Error ? e.message : String(e)}`, 'warn');
    }
  };
  write();
  return ghosts.subscribe(write);
}

/** A workflow ghost stored before 2026-11-24 carries the removed workflow cronExpression: it is dropped on reading. */
function withoutLegacyCron(g: GhostItem): GhostItem {
  if (g.kind !== 'workflow') return g;
  const { cronExpression: _legacy, ...row } = g.row as typeof g.row & { cronExpression?: unknown };
  return { ...g, row };
}

/** The ghosts kept in `storage` (a JSON array of GhostItem); none when unreadable. */
function readGhosts(storage: Storage | null | undefined): GhostItem[] {
  try {
    const raw = storage?.getItem(GHOSTS_KEY);
    if (!raw) return [];
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((g): g is GhostItem => !!g && typeof g === 'object' && typeof (g as GhostItem).key === 'string' && typeof (g as GhostItem).kind === 'string').map(withoutLegacyCron) : [];
  } catch { return []; }
}

/** Whether a ghost's item was ever saved: a row BaseAPI stamped, or a link whose two ends both were. */
function everSaved(g: GhostItem, base: BoardState, lookup: (key: string) => GhostItem | undefined): boolean {
  const row = (kind: 'step' | 'cache' | 'workflow', id: Id): boolean => {
    const table = kind === 'step' ? base.steps : kind === 'cache' ? base.caches : base.workflows;
    if (table[id]) return true;
    const s = lookup(`${kind}:${id}`);
    return !!s && (s.kind === 'step' || s.kind === 'cache' || s.kind === 'workflow') && s.row.updatedAt !== null;
  };
  switch (g.kind) {
    case 'step': case 'cache': case 'workflow': case 'schema': return g.row.updatedAt !== null;
    case 'wire': return row('step', g.from) && row('step', g.to);
    case 'entry': return row('workflow', g.workflowId) && row('step', g.stepId);
    case 'cacheLink': return row('workflow', g.workflowId) && row('cache', g.cacheId);
  }
}

/**
 * Records every item of the board's present on each change; ghosts = recorded ∩ active − present − removed. The ghosts
 * belong to the draft [user, 2026-11-23]: `storage` holds the ones kept from an earlier page (written by keepGhosts); one
 * whose item is on the board again is no ghost.
 * <p>
 * Only a delete makes a ghost [user, 2026-11-25]. `active` is the set of keys a delete took off the board, and it follows
 * the undo history: each board state remembers the set it was reached with. An edit adds what it took off (a delete, a
 * wire re-pointed); an undo or a redo goes back to the set of the state it lands on, so a Ctrl+Z of a create leaves no
 * ghost, while a Ctrl+Z of a Restore, or a redo of a delete, brings the ghost back. A Discard adds nothing and also drops
 * the ghosts of items never saved (created and deleted since the last Save): with the changes discarded, they were never
 * made. A ghost of a saved item stays until Remove, as before.
 * </p>
 */
export function createGhostStore(board: BoardStore, storage?: Storage | null): GhostStore {
  let recorded = new Map<string, GhostItem>(readGhosts(storage).map((g) => [g.key, g]));
  let removed = new Set<string>();
  let present = new Set<string>();
  /** Keys a delete took off the board, as of the present; the stored ghosts are active from the start. */
  let active = new Set<string>(recorded.keys());
  /** The active set each board state was reached with, so undo and redo find it again. */
  let activeAt = new WeakMap<BoardState, Set<string>>();
  let seen: BoardState | null = null;
  let list: GhostItem[] = [];
  let byKey = new Map<string, GhostItem>();
  const subs = new Set<() => void>();

  const recompute = () => {
    const next = [...recorded.values()].filter((g) => active.has(g.key) && !present.has(g.key) && !removed.has(g.key));
    if (next.length === list.length && next.every((g, i) => g === list[i])) return;
    list = next;
    byKey = new Map(next.map((g) => [g.key, g]));
    subs.forEach((f) => f());
  };

  const record = () => {
    const b = board.state();
    if (b === seen) return;
    seen = b;
    const items = itemsOf(b);
    for (const [k, g] of items) recorded.set(k, g);
    const before = present;
    present = new Set(items.keys());
    const why = board.lastCause();
    const gone = [...before].filter((k) => !present.has(k));
    const kept = (from: Set<string>) => new Set([...from].filter((k) => !present.has(k)));
    if (why === 'undo' || why === 'redo') {
      // back (or forward again) to that state's own ghosts; a state this page never reached (none: history starts at load)
      // keeps what it has, and nothing the step took off becomes a ghost
      active = kept(activeAt.get(b) ?? active);
    } else if (why === 'discard') {
      const base = board.base();
      active = new Set([...kept(active)].filter((k) => { const g = recorded.get(k); return !!g && everSaved(g, base, (x) => recorded.get(x)); }));
    } else {
      // an edit (a delete, a re-pointed wire), or a load / Save re-read / dropped workflow, as before: what it took off is a ghost
      active = new Set([...kept(active), ...gone]);
    }
    activeAt.set(b, active);
    // an item back on the board is no longer removed: it is a ghost again when it goes again
    for (const k of removed) if (present.has(k)) removed.delete(k);
    recompute();
  };

  record();
  board.subscribe(record);

  return {
    ghosts: () => list,
    get: (key) => byKey.get(key),
    remove(keys) {
      for (const k of keys) if (!present.has(k)) removed.add(k);
      recompute();
    },
    moveGhosts(moves) {
      let changed = false;
      for (const { key, at } of moves) {
        const g = recorded.get(key);
        if (!g || present.has(key) || (g.kind !== 'step' && g.kind !== 'cache' && g.kind !== 'workflow' && g.kind !== 'schema')) continue;
        if (g.row.at?.x === at.x && g.row.at?.y === at.y) continue;
        recorded.set(key, { ...g, row: { ...g.row, at: { x: at.x, y: at.y } } } as GhostItem);
        changed = true;
      }
      if (changed) recompute();
    },
    remap(made) {
      if (Object.keys(made).length === 0) return;
      const m = (id: Id) => made[id] ?? id;
      const rekey = (k: string) => {
        const i = k.indexOf(':');
        return k.slice(0, i + 1) + k.slice(i + 1).split(':').map(m).join(':');
      };
      recorded = new Map([...recorded.values()].map((g) => { const n = remapItem(g, m); return [n.key, n]; }));
      removed = new Set([...removed].map(rekey));
      present = new Set([...present].map(rekey));
      active = new Set([...active].map(rekey));
      activeAt = new WeakMap();
      // the board still shows the client ids until it adopts the re-read: record it afresh then
      seen = null;
      recompute();
    },
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
  };
}

/**
 * `ids` with `id` put back where `order` has it: before the first element `order` places after it (links are ordered
 * rows, so an unsaved delete restored comes back unchanged). Appended when `order` does not have it.
 */
export function placeIn(ids: Id[], id: Id, order: readonly Id[] | undefined): Id[] {
  const at = order ? order.indexOf(id) : -1;
  if (at < 0) return [...ids, id];
  const i = ids.findIndex((x) => { const j = order!.indexOf(x); return j > at; });
  return i < 0 ? [...ids, id] : [...ids.slice(0, i), id, ...ids.slice(i)];
}

/**
 * Stamp and audit of the row BaseAPI still has (an unsaved delete comes back unchanged); else a null stamp and no audit
 * (created on the next Save: the deleted row's createdAt/createdBy/updatedBy are not the new row's).
 */
const stamp = (rows: Record<Id, { updatedAt: string | null; createdAt: string | null; createdBy: string | null; updatedBy: string | null }>, id: Id) => {
  const r = rows[id];
  return r ? { updatedAt: r.updatedAt, createdAt: r.createdAt, createdBy: r.createdBy, updatedBy: r.updatedBy } : { updatedAt: null, ...NO_AUDIT };
};

/**
 * The ghosts to restore with the ghost wires of every step among them [user, 2026-11-24: "a step with a wire that became a
 * ghost — restore means restoring both"]: a wire into or out of a restored step comes along when its other end is on the
 * board or restored too; one whose other end stays a ghost stays a ghost (no refusal).
 */
export function withTheirWires(b: BoardState, items: GhostItem[], all: readonly GhostItem[]): GhostItem[] {
  const steps = new Set(items.flatMap((g) => (g.kind === 'step' ? [g.row.id] : [])));
  if (steps.size === 0) return items;
  const there = (id: Id) => steps.has(id) || !!b.steps[id];
  const keys = new Set(items.map((g) => g.key));
  const wires = all.filter((g) => g.kind === 'wire' && !keys.has(g.key)
    && (steps.has(g.from) || steps.has(g.to)) && there(g.from) && there(g.to));
  return wires.length ? [...items, ...wires] : items;
}

/**
 * Puts ghosts back as one edit: rows first (steps, caches, schemas, workflows with their assignments), then links. A restored
 * step keeps its wires to steps on the board after the restore and its assignment rows, linked into the workflows that
 * linked them and are on the board; a restored workflow its entry, cache and assignment links whose ends exist. A link
 * with a missing end is refused: `restore <name> first`, the end's name from the ghost snapshots (`items`, then `lookup`).
 */
export function restoreGhosts(
  b: BoardState, base: BoardState, items: GhostItem[], lookup?: (key: string) => GhostItem | undefined,
): Edit {
  const steps = { ...b.steps };
  const caches = { ...b.caches };
  const workflows = { ...b.workflows };
  const assignments = { ...b.assignments };
  const schemas = { ...b.schemas };
  const by = <K extends GhostItem['kind']>(k: K) => items.filter((g): g is Extract<GhostItem, { kind: K }> => g.kind === k);

  const newSteps = by('step').filter((g) => !steps[g.row.id]);
  for (const g of newSteps) steps[g.row.id] = { ...g.row, ...stamp(base.steps, g.row.id) };
  for (const g of newSteps) {
    const s = steps[g.row.id]!;
    steps[g.row.id] = { ...s, nextStepIds: s.nextStepIds.filter((x) => !!steps[x]) };
  }
  for (const g of by('cache')) if (!caches[g.row.id]) caches[g.row.id] = { ...g.row, ...stamp(base.caches, g.row.id) };
  for (const g of by('schema')) if (!schemas[g.row.id]) schemas[g.row.id] = { ...g.row, updatedAt: base.schemas[g.row.id]?.updatedAt ?? null, audit: base.schemas[g.row.id]?.audit ?? { createdAt: '', createdBy: null, updatedAt: '', updatedBy: null } };

  /** The row a link's order comes from: base's when BaseAPI still has it, else the ghost snapshot's. */
  const snapshot = (kind: 'step' | 'workflow', id: Id) => {
    const key = `${kind}:${id}`;
    const g = items.find((x) => x.key === key) ?? lookup?.(key);
    return g && (g.kind === 'step' || g.kind === 'workflow') ? g.row : undefined;
  };
  const stepOrder = (id: Id) => (base.steps[id] ?? (snapshot('step', id) as StepRow | undefined));
  const wfOrder = (id: Id) => (base.workflows[id] ?? (snapshot('workflow', id) as WorkflowRow | undefined));

  const putAssignment = (a: AssignmentRow): boolean => {
    if (assignments[a.id]) return true;
    if (!steps[a.stepId]) return false;
    assignments[a.id] = { ...a, ...stamp(base.assignments, a.id) };
    return true;
  };
  for (const g of by('workflow')) {
    if (workflows[g.row.id]) continue;
    const own = new Map(g.assignments.map((a) => [a.id, a]));
    const assignmentIds = g.row.assignmentIds.filter((id) => {
      const a = own.get(id);
      return a ? putAssignment(a) : !!assignments[id];
    });
    workflows[g.row.id] = {
      ...g.row,
      entryStepIds: g.row.entryStepIds.filter((x) => !!steps[x]),
      entryCrons: Object.fromEntries(Object.entries(g.row.entryCrons ?? {}).filter(([k]) => !!steps[k] && g.row.entryStepIds.includes(k))),
      cacheIds: g.row.cacheIds.filter((x) => !!caches[x]),
      assignmentIds,
      ...stamp(base.workflows, g.row.id),
    };
  }
  for (const g of newSteps) {
    for (const { row, workflowIds } of g.assignments ?? []) {
      const linkers = workflowIds.filter((w) => !!workflows[w]);
      if (linkers.length === 0 || assignments[row.id] || !putAssignment(row)) continue;
      for (const w of linkers) {
        const wf = workflows[w]!;
        if (!wf.assignmentIds.includes(row.id)) workflows[w] = { ...wf, assignmentIds: placeIn(wf.assignmentIds, row.id, wfOrder(w)?.assignmentIds) };
      }
    }
  }

  const name = (kind: 'step' | 'cache' | 'workflow', id: Id): string => {
    const key = `${kind}:${id}`;
    const g = items.find((x) => x.key === key) ?? lookup?.(key);
    if (g && (g.kind === 'step' || g.kind === 'cache' || g.kind === 'workflow')) return g.row.name;
    const table = kind === 'step' ? 'steps' : kind === 'cache' ? 'caches' : 'workflows';
    return (b[table] as Record<Id, { name: string }>)[id]?.name ?? (base[table] as Record<Id, { name: string }>)[id]?.name ?? id;
  };
  const refuse = (kind: 'step' | 'cache' | 'workflow', id: Id): Edit => ({ refused: `restore ${name(kind, id)} first` });

  for (const g of items) {
    if (g.kind === 'wire') {
      if (!steps[g.from]) return refuse('step', g.from);
      if (!steps[g.to]) return refuse('step', g.to);
      const s = steps[g.from]!;
      if (!s.nextStepIds.includes(g.to)) steps[g.from] = { ...s, nextStepIds: placeIn(s.nextStepIds, g.to, stepOrder(g.from)?.nextStepIds) };
    } else if (g.kind === 'entry') {
      if (!workflows[g.workflowId]) return refuse('workflow', g.workflowId);
      if (!steps[g.stepId]) return refuse('step', g.stepId);
      const w = workflows[g.workflowId]!;
      if (!w.entryStepIds.includes(g.stepId)) {
        workflows[g.workflowId] = {
          ...w, entryStepIds: placeIn(w.entryStepIds, g.stepId, wfOrder(g.workflowId)?.entryStepIds),
          entryCrons: g.cron ? { ...w.entryCrons, [g.stepId]: g.cron } : w.entryCrons,
        };
      }
    } else if (g.kind === 'cacheLink') {
      if (!workflows[g.workflowId]) return refuse('workflow', g.workflowId);
      if (!caches[g.cacheId]) return refuse('cache', g.cacheId);
      const w = workflows[g.workflowId]!;
      if (!w.cacheIds.includes(g.cacheId)) workflows[g.workflowId] = { ...w, cacheIds: placeIn(w.cacheIds, g.cacheId, wfOrder(g.workflowId)?.cacheIds) };
    }
  }
  return { state: { ...b, steps, caches, workflows, assignments, schemas } };
}
