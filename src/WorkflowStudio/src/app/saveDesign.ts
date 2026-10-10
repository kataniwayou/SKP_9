import type { StudioApi } from '../api/client';
import { describeError } from '../api/describeError';
import { designErrorsFromDto, designLogFromDto } from '../api/toModel';
import type { DesignSaveRequest } from '../api/types';
import { applyDesign } from '../design/apply';
import { parseSlotKey, type Design, type FieldValue, type SchemaCopy } from '../design/design';
import { sameList } from '../design/draft';
import { layoutOf, type SavedLayout } from '../design/layoutDesign';
import { heldLinkCount, shortCircuitErrors, writtenLists } from '../design/shortCircuits';
import type { Id } from '../model/graph';
import type { SchemaSlot } from '../store/inspectorTarget';
import { saveStartText } from '../store/saveLog';
import { canSave, designOf } from '../store/studioState';
import type { StudioStore } from '../store/studioStore';
import type { StudioDocument } from './document';
import { loadDocument } from './loadDocument';

type Fields = Record<string, FieldValue>;

/** The body of `PUT /workflows/{id}/design` (plan 8 §4.2) as the studio builds it: every change, nothing else. */
export interface DesignRequest {
  workflow: { updatedAt: string | null; fields: Fields; entryStepIds: Id[] | null; cacheIds: Id[] | null };
  steps: { id: Id; updatedAt: string | null; fields: Fields; nextStepIds: Id[] | null }[];
  processors: { id: Id; fields: Fields; slots: Partial<Record<SchemaSlot, Id>> }[];
  caches: { id: Id; fields: Fields }[];
  schemas: SchemaCopy[];
  /** `copyOf` (a pasted step's assignment, 2026-10-10): the real row whose fields BaseApi starts from. */
  assignments: { op: 'create' | 'update' | 'delete'; id: Id; stepId: Id; updatedAt: string | null; fields: Fields; copyOf?: Id }[];
  layout: SavedLayout;
  /** Pasted steps (2026-10-10): sent only when there are some, so an older BaseApi never sees an empty list it does not know. */
  newSteps?: { id: Id; copyOf: Id | null; processorId: Id; fields: Fields; nextStepIds: Id[] | null }[];
  newCaches?: { id: Id; copyOf: Id | null; fields: Fields }[];
  /** Deleted steps with the stamp the designer loaded (steps are owned). */
  deletedSteps?: { id: Id; updatedAt: string | null }[];
  deletedCaches?: { id: Id; updatedAt: null }[];
}

/**
 * The design's changes relative to the base (spec §4.2; plan 9 §7). The lists are the shown ones, which the
 * circuit's current gives with no step its own next step: a step whose list differs from the base's sends it, and
 * so does the entry list. A source with a wire in a short-circuited net (the hub for the entry list) keeps the
 * loaded workflow's list: no link is written, dropped or added through the net; the layout keeps it as drawn. A
 * list keeps an id the workflow lacks where the saved one has it (as `listsOf` does: no wire can say otherwise).
 * The workflow always carries its stamp (the workflow stage needs it when assignment links change); a step carries
 * the stamp the design kept, else the base's. A wire with an open end makes no link: it lives only in the layout.
 * Entities the base no longer has are left out.
 */
export function buildDesignRequest(base: StudioDocument, shown: StudioDocument, { draft, edits }: Design): DesignRequest {
  const g = base.graph;
  const { blocks } = draft;
  // deleted steps and caches (2026-10-10): sent to be deleted, and out of every list and change
  const removed = new Set(blocks.removed.steps.filter((id) => g.steps.has(id)));
  const removedCaches = new Set(blocks.removed.caches.filter((id) => g.caches.has(id)));
  const has = (id: Id) => g.steps.has(id) && !removed.has(id);
  // what Save writes is the same as what the Inspector's read-outs show (`writtenLists`)
  const written = writtenLists(base, shown, draft);
  const nextOf = (id: Id) => written.nextOf(id).filter((t) => !removed.has(t));
  const entries = written.entries.filter((t) => !removed.has(t));
  const rewired = new Set([...g.steps.keys()].filter((id) => has(id) && !sameList(nextOf(id), g.steps.get(id)!.nextStepIds)));
  const stepIds = [...new Set([...Object.keys(edits.steps), ...rewired])].filter(has).sort();

  const slots = new Map<Id, Partial<Record<SchemaSlot, Id>>>();
  const schemas: SchemaCopy[] = [];
  for (const [key, c] of Object.entries(edits.schemas)) {
    const parsed = parseSlotKey(key);
    if (parsed === null || !g.processors.has(parsed.processorId)) continue;
    slots.set(parsed.processorId, { ...slots.get(parsed.processorId), [parsed.slot]: c.id });
    schemas.push({ ...c });
  }
  const processorIds = [...new Set([...Object.keys(edits.processors), ...slots.keys()])].filter((id) => g.processors.has(id)).sort();

  // pasted steps and caches (2026-10-10): their fields as copied with the Inspector's edits over them
  const pasted = Object.entries(blocks.steps).filter(([id]) => !g.steps.has(id));
  const newSteps = pasted.map(([id, n]) => {
    const next = nextOf(id);
    return {
      id, copyOf: n.copyOf, processorId: n.processorId,
      fields: { name: n.name, version: n.version, description: n.description, entryCondition: n.entryCondition, ...edits.steps[id]?.fields },
      nextStepIds: next.length > 0 ? [...next] : null,
    };
  });
  const newCaches = Object.entries(blocks.caches).filter(([id]) => !g.caches.has(id)).map(([id, c]) => ({
    id, copyOf: c.copyOf, fields: { name: c.name, version: c.version, description: c.description, root: c.root, items: c.items, ...edits.caches[id]?.fields },
  }));
  // a pasted step's assignment is created with it: as copied, unless the Inspector removed it, changed it or made another
  const pastedAssignments: DesignRequest['assignments'] = pasted.flatMap(([stepId, n]) => {
    const op = edits.assignments[stepId];
    if (op?.op === 'delete') return [];
    if (op?.op === 'create') return [{ op: 'create', id: op.id, stepId, updatedAt: null, fields: { ...op.fields } }];
    const a = n.assignment;
    if (!a) return [];
    const changed = op?.op === 'update' && op.id === a.id ? op.fields : {};
    return [{ op: 'create', id: a.id, stepId, updatedAt: null, fields: { ...a.fields, ...changed }, ...(a.copyOf ? { copyOf: a.copyOf } : {}) }];
  });
  const cacheIds = shown.graph.workflow.cacheIds;

  return {
    workflow: {
      updatedAt: edits.workflow?.updatedAt ?? g.workflow.updatedAt, fields: { ...edits.workflow?.fields },
      entryStepIds: sameList(entries, g.workflow.entryStepIds) ? null : [...entries],
      cacheIds: sameList(cacheIds, g.workflow.cacheIds) ? null : [...cacheIds],
    },
    steps: stepIds.map((id) => ({
      id, updatedAt: edits.steps[id]?.updatedAt ?? g.steps.get(id)!.updatedAt, fields: { ...edits.steps[id]?.fields },
      nextStepIds: rewired.has(id) ? [...nextOf(id)] : null,
    })),
    processors: processorIds.map((id) => ({ id, fields: { ...edits.processors[id]?.fields }, slots: slots.get(id) ?? {} })),
    caches: Object.entries(edits.caches).filter(([id]) => g.caches.has(id) && !removedCaches.has(id)).map(([id, e]) => ({ id, fields: { ...e.fields } })),
    schemas,
    assignments: [
      ...Object.entries(edits.assignments).filter(([stepId]) => has(stepId)).map(([stepId, op]) => ({
        op: op.op, id: op.id, stepId, updatedAt: op.op === 'create' ? null : op.updatedAt, fields: op.op === 'delete' ? {} : { ...op.fields },
      })),
      ...pastedAssignments,
    ],
    layout: layoutOf(shown, draft),
    ...(newSteps.length > 0 ? { newSteps } : {}),
    ...(newCaches.length > 0 ? { newCaches } : {}),
    ...(removed.size > 0 ? { deletedSteps: [...removed].map((id) => ({ id, updatedAt: edits.steps[id]?.updatedAt ?? g.steps.get(id)!.updatedAt })) } : {}),
    ...(removedCaches.size > 0 ? { deletedCaches: [...removedCaches].map((id) => ({ id, updatedAt: null })) } : {}),
  };
}

/**
 * Save (spec §4.1): the design's changes in one request, the design read-only until the answer. Either way
 * the design is then stored on the workflow: the document is read again with GETs (the stored design comes
 * back with it), its errors are pinned at the top of Output, and Output logs the whole save (2026-10-09): "Save
 * started", BaseApi's own log line by line, the verdict, the re-read and how the drawing was aligned. A request
 * that got no answer stored nothing: Output says why in red and the edits stay. A short circuit (plan 9 §7) is an
 * error of the design's wiring: the design is stored as drawn, its sources keep their loaded lists, and its errors
 * come with the answer's.
 */
export async function saveDesign(api: StudioApi, store: StudioStore, workflowId: Id, now: () => Date = () => new Date()): Promise<void> {
  const open = store.getState().docs.find((d) => d.workflowId === workflowId);
  if (!open || open.status.kind !== 'ready' || !canSave(open)) return;
  const base = open.status.doc;
  const design = designOf(open);
  const shown = applyDesign(base, design.draft, design.edits);
  const shorts = shortCircuitErrors(shown, design.draft);
  const held = heldLinkCount(base, shown, design.draft);
  const body = buildDesignRequest(base, shown, design);
  store.dispatch({ type: 'saving', workflowId });
  store.dispatch({ type: 'log', workflowId, lines: [{ at: now().toISOString(), text: saveStartText(body) }] });
  const answer = await api.saveDesign(workflowId, body as unknown as DesignSaveRequest);
  if (!answer.ok) {
    store.dispatch({ type: 'saveFailed', workflowId, at: now().toISOString(), message: describeError(answer.error) });
    return;
  }
  const reread = await loadDocument(api, workflowId);
  store.dispatch({
    type: 'saveAnswered', workflowId, at: now().toISOString(), applied: answer.value.applied === true, held,
    errors: [...shorts, ...designErrorsFromDto(answer.value)], doc: reread.ok ? reread.value : null,
    log: designLogFromDto(answer.value), ...(reread.ok ? {} : { reread: describeError(reread.error) }),
  });
}
