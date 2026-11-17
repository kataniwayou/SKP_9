import type { components } from '../api/schema';
import type { Cache, Id } from '../model/graph';
import { cacheChipAt } from '../board/cacheChips';
import { FRAME_PAD, STEP_H } from '../board/geometry';
import { derivedEntrySteps, stepRoles } from '../board/roles';
import { wiresOf } from '../board/wires';
import type { AssignmentState, CacheFields, CacheState, StepState, WorkflowState } from './state';
import { removeStep } from './state';

export type DesignSaveRequest = components['schemas']['DesignSaveRequest'];
type Fields = Record<string, unknown>;

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
const sameSet = (a: Id[], b: Id[]) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

function diff<T extends object>(base: T | undefined, cur: T, keys: readonly (keyof T & string)[]): Fields {
  const out: Fields = {};
  for (const k of keys) if (!base || !same(base[k], cur[k])) out[k] = cur[k];
  return out;
}
const has = (o: Fields) => Object.keys(o).length > 0;

const STEP_KEYS = ['name', 'version', 'description', 'entryCondition', 'processorId'] as const;
const WF_KEYS = ['name', 'version', 'description', 'cronExpression'] as const;
const CACHE_KEYS = ['name', 'version', 'description', 'root', 'items'] as const;
const ASSIGN_KEYS = ['name', 'version', 'description', 'payload'] as const;

function derivedOf(s: WorkflowState): Id[] {
  const ids = Object.keys(s.steps);
  const steps = new Map(ids.map((id) => [id, { nextStepIds: s.steps[id]!.nextStepIds, entryCondition: s.steps[id]!.entryCondition }]));
  return derivedEntrySteps(stepRoles(ids, wiresOf(ids, steps)));
}

export function designRequest(base: WorkflowState | null, cur: WorkflowState, storedLayout: unknown): DesignSaveRequest {
  const req: DesignSaveRequest = {};
  const derived = derivedOf(cur);

  const workflow: NonNullable<DesignSaveRequest['workflow']> = {
    updatedAt: cur.updatedAt, fields: base ? diff(base.fields, cur.fields, WF_KEYS) : {},
  };
  const baseEntry = base ? derivedOf(base) : [];
  const stored = base?.storedEntry ?? baseEntry;
  if (!sameSet(derived, baseEntry) || !sameSet(derived, stored)) workflow.entryStepIds = derived;
  const linked = Object.keys(cur.caches);
  if (!sameSet(linked, base ? Object.keys(base.caches) : [])) workflow.cacheIds = linked;
  req.workflow = workflow;
  if (!base) req.newWorkflow = { fields: { ...cur.fields } };

  const steps: NonNullable<DesignSaveRequest['steps']> = [];
  const newSteps: NonNullable<DesignSaveRequest['newSteps']> = [];
  for (const st of Object.values(cur.steps)) {
    const b = base?.steps[st.id];
    if (st.isNew || !b) {
      newSteps.push({
        id: st.id, copyOf: null, processorId: st.processorId,
        fields: { name: st.name, version: st.version, description: st.description, entryCondition: st.entryCondition },
        nextStepIds: [...st.nextStepIds],
      });
      continue;
    }
    const fields = diff(b, st, STEP_KEYS);
    const nextChanged = !same(b.nextStepIds, st.nextStepIds);
    if (has(fields) || nextChanged) {
      steps.push({ id: st.id, updatedAt: st.updatedAt, fields, nextStepIds: nextChanged ? [...st.nextStepIds] : null });
    }
  }
  req.steps = steps;
  if (newSteps.length) req.newSteps = newSteps;
  const deleted = Object.entries(cur.deletedSteps).map(([id, updatedAt]) => ({ id, updatedAt }));
  if (deleted.length) req.deletedSteps = deleted;

  const assignments: NonNullable<DesignSaveRequest['assignments']> = [];
  if (base) {
    // deletes go first: a removed then re-added assignment is a delete of the old row and a create of the new one
    for (const b of Object.values(base.assignments)) {
      // a deleted step takes its assignment with it; the studio leaves those out too
      if (cur.assignments[b.stepId]?.id === b.id || b.stepId in cur.deletedSteps) continue;
      assignments.push({ op: 'delete', id: b.id, stepId: b.stepId, updatedAt: b.updatedAt });
    }
  }
  for (const a of Object.values(cur.assignments)) {
    const b = base?.assignments[a.stepId];
    if (a.isNew || !b || b.id !== a.id) {
      assignments.push({ op: 'create', id: a.id, stepId: a.stepId, updatedAt: null, fields: diff(undefined, a, ASSIGN_KEYS) });
    } else {
      const fields = diff(b, a, ASSIGN_KEYS);
      if (has(fields)) assignments.push({ op: 'update', id: a.id, stepId: a.stepId, updatedAt: a.updatedAt, fields });
    }
  }
  req.assignments = assignments;

  const caches: NonNullable<DesignSaveRequest['caches']> = [];
  const newCaches: NonNullable<DesignSaveRequest['newCaches']> = [];
  for (const c of Object.values(cur.caches)) {
    if (c.isNew) {
      newCaches.push({ id: c.id, copyOf: null, fields: diff(undefined, c, CACHE_KEYS) });
      continue;
    }
    // an existing cache linked here and not saved yet is diffed against what it was when linked
    const ref = base?.caches[c.id] ?? c.linked;
    const fields = diff(ref, c, CACHE_KEYS);
    if (ref && has(fields)) caches.push({ id: c.id, fields });
  }
  req.caches = caches;
  if (newCaches.length) req.newCaches = newCaches;

  req.layout = layoutOf(cur, storedLayout);
  return req;
}

const isPoint = (v: unknown): v is { x: number; y: number } =>
  !!v && typeof v === 'object' && typeof (v as { x?: unknown }).x === 'number' && typeof (v as { y?: unknown }).y === 'number';

export function layoutOf(cur: WorkflowState, storedLayout: unknown): object {
  const ids = Object.keys(cur.steps);
  const derived = derivedOf(cur);
  const steps: Record<Id, { x: number; y: number }> = {};
  for (const id of ids) steps[id] = { x: cur.steps[id]!.at.x, y: cur.steps[id]!.at.y };
  const caches: Record<Id, { x: number; y: number }> = {};
  Object.keys(cur.caches).forEach((id, i) => { caches[id] = cacheChipAt(i, cur.frame); });
  const wires: Record<string, unknown> = {};
  for (const id of derived) {
    wires[`wf->${id}`] = { tail: { on: 'hub', angle: null }, head: { on: 'step', step: id, y: null } };
  }
  for (const from of ids) {
    for (const to of cur.steps[from]!.nextStepIds) {
      if (!cur.steps[to]) continue;
      wires[`${from}->${to}`] = { tail: { on: 'step', step: from, y: null }, head: { on: 'step', step: to, y: null } };
    }
  }
  const storedSphere = (storedLayout as { sphere?: unknown } | null)?.sphere;
  const first = cur.steps[derived[0] ?? ids[0] ?? ''];
  const sphere = isPoint(storedSphere) ? { x: storedSphere.x, y: storedSphere.y } : { x: -150, y: (first?.at.y ?? FRAME_PAD) + 46 };
  return { v: 2, sphere, steps, caches, parked: [...ids], wires, board: { ...cur.frame } };
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): v is string => typeof v === 'string';
const nullableStr = (v: unknown): string | null => (str(v) ? v : null);

type Kind = 'string' | 'nstring' | 'number';

function pickFields<T extends object>(target: T, fields: unknown, types: Record<string, Kind>): T {
  const f = obj(fields);
  if (!f) return target;
  const out = { ...target } as Record<string, unknown>;
  for (const [k, t] of Object.entries(types)) {
    if (!(k in f)) continue;
    const v = f[k];
    if (t === 'string' && str(v)) out[k] = v;
    else if (t === 'nstring' && (str(v) || v === null)) out[k] = v;
    else if (t === 'number' && typeof v === 'number') out[k] = v;
  }
  return out as T;
}

const STEP_TYPES: Record<string, Kind> = { name: 'string', version: 'string', description: 'nstring', entryCondition: 'number', processorId: 'nstring' };
const WF_TYPES: Record<string, Kind> = { name: 'string', version: 'string', description: 'nstring', cronExpression: 'nstring' };
const CACHE_TYPES: Record<string, Kind> = { name: 'string', version: 'string', description: 'nstring', root: 'string', items: 'string' };
const ASSIGN_TYPES: Record<string, Kind> = { name: 'string', version: 'string', description: 'nstring', payload: 'string' };

/**
 * `known`: existing caches the design links that the base does not hold, as read from the server (their real
 * fields); without one such a cache is restored from the design alone.
 */
export function applyStored(
  base: WorkflowState, stored: unknown, storedLayout: unknown = null, known: ReadonlyMap<Id, Cache> = new Map(),
): WorkflowState {
  const d = obj(stored);
  if (!d) return base;
  let s: WorkflowState = { ...base };

  const wf = obj(d.workflow);
  if (wf) s = { ...s, fields: pickFields(s.fields, wf.fields, WF_TYPES) };

  for (const e of list(d.steps)) {
    const o = obj(e);
    const st = o && str(o.id) ? s.steps[o.id] : undefined;
    if (!o || !st) continue;
    let next: StepState = pickFields(st, o.fields, STEP_TYPES);
    if (Array.isArray(o.nextStepIds)) next = { ...next, nextStepIds: o.nextStepIds.filter(str) };
    s = { ...s, steps: { ...s.steps, [st.id]: next } };
  }

  // positions are in the stored layout; without one a new step stacks down the frame
  const laid = obj(obj(storedLayout)?.steps);
  // loading may have shifted the stored positions into the frame (a WorkflowStudio layout): a restored new
  // step takes the same shift, read off any step the base and the layout share
  let shift = { x: 0, y: 0 };
  for (const [id, st] of Object.entries(base.steps)) {
    const p = laid?.[id];
    if (isPoint(p)) { shift = { x: st.at.x - p.x, y: st.at.y - p.y }; break; }
  }
  for (const e of list(d.newSteps)) {
    const o = obj(e);
    if (!o || !str(o.id) || s.steps[o.id]) continue;
    const n = Object.keys(s.steps).length;
    const p = laid?.[o.id];
    const st: StepState = pickFields({
      id: o.id, name: o.id, version: '1.0.0', description: null, entryCondition: 1,
      processorId: nullableStr(o.processorId), nextStepIds: list(o.nextStepIds).filter(str),
      at: isPoint(p) ? { x: Math.max(0, p.x + shift.x), y: Math.max(0, p.y + shift.y) } : { x: FRAME_PAD, y: FRAME_PAD + n * (STEP_H + 40) },
      updatedAt: null, isNew: true,
    }, o.fields, { name: 'string', version: 'string', description: 'nstring', entryCondition: 'number' });
    s = { ...s, steps: { ...s.steps, [st.id]: st } };
  }

  for (const e of list(d.deletedSteps)) {
    const o = obj(e);
    if (!o || !str(o.id) || !s.steps[o.id]) continue;
    s = removeStep(s, o.id);
  }

  for (const e of list(d.assignments)) {
    const o = obj(e);
    if (!o || !str(o.id) || !str(o.stepId) || !s.steps[o.stepId]) continue;
    const existing = s.assignments[o.stepId];
    if (o.op === 'delete') {
      if (existing?.id === o.id) { const a = { ...s.assignments }; delete a[o.stepId]; s = { ...s, assignments: a }; }
    } else if (o.op === 'update') {
      if (existing?.id === o.id) s = { ...s, assignments: { ...s.assignments, [o.stepId]: pickFields(existing, o.fields, ASSIGN_TYPES) } };
    } else if (o.op === 'create' && !existing) {
      const made: AssignmentState = pickFields({
        id: o.id, stepId: o.stepId, name: `${s.steps[o.stepId]!.name}-assignment`, version: '1.0.0', description: null,
        payload: '{}', updatedAt: null, isNew: true,
      }, o.fields, ASSIGN_TYPES);
      s = { ...s, assignments: { ...s.assignments, [o.stepId]: made } };
    }
  }

  const changed = new Map<string, unknown>();
  for (const e of list(d.caches)) { const o = obj(e); if (o && str(o.id)) changed.set(o.id, o.fields); }
  const created = new Map<string, Record<string, unknown>>();
  for (const e of list(d.newCaches)) { const o = obj(e); if (o && str(o.id)) created.set(o.id, o); }
  const ids = wf && Array.isArray(wf.cacheIds) ? wf.cacheIds.filter(str) : null;
  if (ids) {
    const caches: Record<Id, CacheState> = {};
    for (const id of ids) {
      const held = s.caches[id];
      const made = created.get(id);
      const e = known.get(id);
      if (held) caches[id] = held;
      else if (made) caches[id] = pickFields({ id, name: id, version: '1.0.0', description: null, root: '', items: '{}', isNew: true }, made.fields, CACHE_TYPES);
      else {
        // an existing cache linked by the design: its edits (below) are diffed against it as linked
        const linked: CacheFields = e
          ? { name: e.name, version: e.version, description: e.description, root: e.root, items: e.items }
          : { name: id, version: '1.0.0', description: null, root: '', items: '{}' };
        caches[id] = { id, ...linked, isNew: false, linked };
      }
    }
    s = { ...s, caches };
  }
  for (const [id, f] of changed) {
    const c = s.caches[id];
    if (c) s = { ...s, caches: { ...s.caches, [id]: pickFields(c, f, CACHE_TYPES) } };
  }
  return s;
}
