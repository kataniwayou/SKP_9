import type { StudioApi } from '../api/client';
import { describeError } from '../api/describeError';
import { loadWorkflow } from '../board/loadBoard';
import type { Id } from '../model/graph';
import type { OutputStore } from '../output/outputStore';
import type { BoardStore } from './boardStore';
import { diagramSvg } from './diagramSvg';
import { designRequest } from './request';
import { changedEntities, holders, type EntityKey } from './shared';
import type { WorkflowState } from './state';

function entityName(s: WorkflowState, base: WorkflowState | null, id: string): string {
  for (const st of [s, base]) {
    if (!st) continue;
    const found = st.steps[id]?.name ?? st.caches[id]?.name ?? Object.values(st.assignments).find((a) => a.id === id)?.name;
    if (found) return found;
  }
  return id === s.workflowId ? s.fields.name : id;
}

/** Saves one workflow: design request, validation, Kibana diagram. Never throws; the Output says what happened. */
export async function saveWorkflow(
  api: StudioApi, store: BoardStore, output: OutputStore, workflowId: Id,
): Promise<'saved' | 'refused' | 'failed'> {
  const entry = store.entry(workflowId);
  if (!entry) return 'failed';
  if (entry.saving) {
    output.log(`${entry.history.present.fields.name} is already saving`, 'info');
    return 'refused';
  }
  store.setSaving(workflowId, true);
  let out: Ran;
  try {
    out = await run(api, store, output, workflowId, entry);
  } finally {
    store.setSaving(workflowId, false);
  }
  // after the save lock is released: the saved workflow is editable again while its sharers re-read
  if (out.sharers) await refreshSharers(api, store, output, workflowId, out.sharers);
  return out.result;
}

/** How the save went, and (after an applied save) what it changed that other workflows may show too. */
interface Ran { result: 'saved' | 'refused' | 'failed'; sharers?: Set<EntityKey> }

async function run(
  api: StudioApi, store: BoardStore, output: OutputStore, workflowId: Id, entry: NonNullable<ReturnType<BoardStore['entry']>>,
): Promise<Ran> {
  const present = entry.history.present;
  const name = present.fields.name;
  // what this save changes, taken before the save replaces the base: the workflows sharing it re-read it after
  const changed = changedEntities(entry.base, present);

  if (entry.base) {
    const now = await api.getGraph(workflowId);
    if (now.ok && JSON.stringify(now.value.layout ?? null) !== JSON.stringify(entry.layout ?? null)) {
      output.log(`${name} changed elsewhere since it was loaded; saving over it`, 'warn');
    }
  }

  const req = designRequest(entry.base, present, entry.layout);
  const saved = await api.saveDesign(workflowId, req);
  // BaseAPI stores the layout before it dry-runs the design (only a new workflow it refuses is not stored)
  const stored = saved.ok ? saved.value.applied || entry.base !== null : saved.error.kind === 'conflict' || saved.error.kind === 'unprocessable';
  if (stored) store.setLayout(workflowId, req.layout);
  if (!saved.ok) { output.log(`${name}: ${describeError(saved.error)}`, 'error'); return { result: 'failed' }; }
  if (!saved.value.applied) {
    for (const e of saved.value.errors ?? []) {
      output.log(`${name}: ${e.id ? entityName(present, entry.base, e.id) : name} — ${e.message ?? ''}`, 'error');
    }
    return { result: 'refused' };
  }
  output.log(`${name} saved`, 'ok');

  const loaded = await loadWorkflow(api, workflowId);
  if (!loaded.ok) {
    store.adoptPresent(workflowId);
    output.log(`${name} saved, but could not be read back: ${describeError(loaded.error)}. Reload before editing it again`, 'error');
    return { result: 'saved', sharers: changed };
  }
  const { storedFrame: _stored, ...rest } = loaded.value;
  // what was just saved stays where it was drawn; only a step the save newly brought in takes the re-read place
  const stepAt = new Map(rest.stepIds.map((id) => [id, present.steps[id] ? { ...present.steps[id]!.at } : rest.stepAt.get(id)!]));
  const bw = { ...rest, stepAt, frame: { ...present.frame } };
  store.replace(workflowId, bw);

  const v = await api.validateWorkflow(workflowId);
  if (v.ok) {
    const problems = v.value.problems ?? [];
    for (const p of problems) output.log(`${name}: ${p.title ?? p.gate ?? 'problem'} — ${p.detail ?? ''}`, 'warn');
    store.setProblems(workflowId, problems.length);
  } else {
    output.log(`${name}: could not validate — ${describeError(v.error)}`, 'warn');
  }

  const pub = await api.publishDiagram(workflowId, diagramSvg(bw));
  if (pub.ok) output.log(`${name}: Kibana diagram published`, 'ok');
  else output.log(`${name}: Kibana diagram not published — ${describeError(pub.error)}`, 'warn');
  return { result: 'saved', sharers: changed };
}

/**
 * After `savedId` saved the entities in `changed`, every other workflow showing one of them re-reads itself and takes
 * the new values of those entities, keeping its own unsaved work (BoardStore.rebase). One that cannot be re-read
 * stays as it was. Never throws.
 */
export async function refreshSharers(
  api: StudioApi, store: BoardStore, output: OutputStore, savedId: Id, changed: Set<EntityKey>,
): Promise<void> {
  if (changed.size === 0) return;
  const held = holders(store.boards());
  const keysOf = new Map<Id, Set<EntityKey>>();
  for (const key of changed) {
    for (const wf of held.get(key) ?? []) {
      if (wf === savedId) continue;
      const ks = keysOf.get(wf) ?? new Set<EntityKey>();
      ks.add(key);
      keysOf.set(wf, ks);
    }
  }
  const savedName = store.entry(savedId)?.history.present.fields.name ?? savedId;
  for (const [wf, keys] of keysOf) {
    const entry = store.entry(wf);
    if (!entry?.base) continue; // never saved: BaseAPI has nothing to re-read
    const name = entry.history.present.fields.name;
    const loaded = await loadWorkflow(api, wf);
    if (!loaded.ok) {
      output.log(`${name}: could not re-read after ${savedName} saved — ${describeError(loaded.error)}`, 'warn');
      continue;
    }
    const { storedFrame: _stored, ...rest } = loaded.value;
    const frame = store.boards().find((b) => b.graph.workflow.id === wf)?.frame ?? { x: 0, y: 0, w: 0, h: 0 };
    store.rebase(wf, { ...rest, frame }, keys);
    output.log(`${name}: re-read after ${savedName} saved`, 'info');
  }
}
