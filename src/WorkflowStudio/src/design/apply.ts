import type { StudioDocument } from '../app/document';
import { snap, type Point } from '../layout/geometry';
import type { Placement } from '../layout/placement';
import { routeCircuit, routeWires } from '../layout/circuitRoute';
import type { Assignment, Cache, Graph, Id, Processor, Schema, Step } from '../model/graph';
import { reachableStepIds } from '../model/reachability';
import { circuitOf, isEmptyDraft, listsOf, type Draft } from './draft';
import { isEmptyEdits, parseSlotKey, valueText, type EntityEdits, type FieldValue } from './design';

/**
 * What the canvas shows (spec §5.1; plan 9 §7): the saved workflow with the draft laid over it. The circuit's current
 * gives every step's next steps and the entry steps, and so reachability and the parked steps (§3.5); moved blocks sit
 * where the draft has them (the automatic layout is not run again); every wire of the circuit is drawn again. Parts
 * naming what the saved document does not have are ignored. Pure; an empty draft gives the saved document back unchanged.
 */
export function applyDraft(saved: StudioDocument, draft: Draft): StudioDocument {
  if (isEmptyDraft(draft)) return saved;
  const { graph } = saved;
  const circuit = circuitOf(saved, draft);
  const lists = listsOf(saved, circuit);
  const steps = new Map<Id, Step>(graph.steps);
  for (const [id, next] of lists.next) steps.set(id, { ...steps.get(id)!, nextStepIds: next });
  const entryStepIds = lists.entries;
  const shownGraph: Graph = { ...graph, workflow: { ...graph.workflow, entryStepIds }, steps };

  const reachable = new Set(reachableStepIds(entryStepIds, steps));
  const parkedIds = [
    ...saved.parkedIds.filter((id) => !reachable.has(id)),
    ...[...steps.keys()].filter((id) => !reachable.has(id) && !saved.parkedIds.includes(id)),
  ];

  const placement: Placement = {
    sphere: draft.sphere ? { cx: snap(draft.sphere.x), cy: snap(draft.sphere.y) } : saved.placement.sphere,
    steps: overlay(saved.placement.steps, draft.steps),
    caches: overlay(saved.placement.caches, draft.caches),
  };
  return { graph: shownGraph, parkedIds, placement, wires: routeCircuit(circuit, { placement, steps }) };
}

function overlay(base: ReadonlyMap<Id, Point>, moved: Readonly<Record<Id, Point>>): Map<Id, Point> {
  const out = new Map(base);
  for (const [id, p] of Object.entries(moved)) if (out.has(id)) out.set(id, { x: snap(p.x), y: snap(p.y) });
  return out;
}

const NO_AUDIT = { createdAt: '', createdBy: null, updatedAt: '', updatedBy: null };
const text = (f: Readonly<Record<string, FieldValue>>, k: string, was: string): string => (Object.hasOwn(f, k) ? valueText(f[k]) : was);
const nullable = (f: Readonly<Record<string, FieldValue>>, k: string, was: string | null): string | null =>
  (Object.hasOwn(f, k) ? (valueText(f[k]) === '' ? null : valueText(f[k])) : was);

/**
 * The base with the design's entity edits laid over it (spec §3.1): fields, a slot re-pointed to its schema
 * copy, assignments created, updated or deleted. Wires are routed again, so an entry condition changed in the
 * design colours its wires. Pure; edits that change nothing give the base back unchanged.
 */
export function applyEdits(base: StudioDocument, edits: EntityEdits): StudioDocument {
  if (isEmptyEdits(edits)) return base;
  const g = base.graph;
  const wf = edits.workflow?.fields ?? {};
  const workflow = {
    ...g.workflow, name: text(wf, 'name', g.workflow.name), version: text(wf, 'version', g.workflow.version),
    description: nullable(wf, 'description', g.workflow.description), cronExpression: nullable(wf, 'cronExpression', g.workflow.cronExpression),
  };

  const steps = new Map(g.steps);
  for (const [id, e] of Object.entries(edits.steps)) {
    const s = steps.get(id);
    if (!s) continue;
    const f = e.fields;
    steps.set(id, {
      ...s, name: text(f, 'name', s.name), version: text(f, 'version', s.version), description: nullable(f, 'description', s.description),
      entryCondition: typeof f.entryCondition === 'number' ? f.entryCondition : s.entryCondition,
    });
  }

  const processors = new Map<string, Processor>(g.processors);
  for (const [id, e] of Object.entries(edits.processors)) {
    const p = processors.get(id);
    if (!p) continue;
    const f = e.fields;
    processors.set(id, {
      ...p, name: text(f, 'name', p.name), version: text(f, 'version', p.version), description: nullable(f, 'description', p.description),
      sourceHash: text(f, 'sourceHash', p.sourceHash), instanceId: nullable(f, 'instanceId', p.instanceId),
    });
  }

  const schemas = new Map<string, Schema>(g.schemas);
  for (const [key, c] of Object.entries(edits.schemas)) {
    const parsed = parseSlotKey(key);
    if (!parsed) continue;
    const { processorId: pid, slot } = parsed;
    const p = processors.get(pid);
    if (!p) continue;
    const was = slot === 'input' ? p.inputSchemaId : slot === 'output' ? p.outputSchemaId : p.configSchemaId;
    schemas.set(c.id, { id: c.id, name: c.name, version: c.version, description: c.description, audit: (was ? g.schemas.get(was)?.audit : undefined) ?? NO_AUDIT });
    processors.set(pid, slot === 'input' ? { ...p, inputSchemaId: c.id } : slot === 'output' ? { ...p, outputSchemaId: c.id } : { ...p, configSchemaId: c.id });
  }

  const caches = new Map<string, Cache>(g.caches);
  for (const [id, e] of Object.entries(edits.caches)) {
    const c = caches.get(id);
    if (!c) continue;
    const f = e.fields;
    caches.set(id, {
      ...c, name: text(f, 'name', c.name), version: text(f, 'version', c.version), description: nullable(f, 'description', c.description),
      root: text(f, 'root', c.root), items: text(f, 'items', c.items),
    });
  }

  let assignments: Assignment[] = g.assignments;
  for (const [stepId, op] of Object.entries(edits.assignments)) {
    if (op.op === 'delete') assignments = assignments.filter((a) => a.id !== op.id);
    else if (op.op === 'update') assignments = assignments.map((a) => (a.id === op.id && typeof op.fields.payload === 'string' ? { ...a, payload: op.fields.payload } : a));
    else assignments = [...assignments.filter((a) => a.stepId !== stepId), { id: op.id, stepId, payload: typeof op.fields.payload === 'string' ? op.fields.payload : '{}', updatedAt: '' }];
  }

  const graph: Graph = { ...g, workflow, steps, processors, schemas, caches, assignments };
  const wires = routeWires({ entryStepIds: workflow.entryStepIds, steps }, base.placement);
  return { ...base, graph, wires };
}

/** What the canvas shows (spec §3.1): the base, the entity edits, then the canvas draft. */
export function applyDesign(base: StudioDocument, draft: Draft, edits: EntityEdits): StudioDocument {
  return applyDraft(applyEdits(base, edits), draft);
}
