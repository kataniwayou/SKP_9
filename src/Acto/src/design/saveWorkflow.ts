import type { StudioApi } from '../api/client';
import { describeError } from '../api/describeError';
import { loadWorkflow } from '../board/loadBoard';
import type { Id } from '../model/graph';
import type { OutputStore } from '../output/outputStore';
import type { BoardStore } from './boardStore';
import { diagramSvg } from './diagramSvg';
import { designRequest } from './request';
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
  try {
    return await run(api, store, output, workflowId, entry);
  } finally {
    store.setSaving(workflowId, false);
  }
}

async function run(
  api: StudioApi, store: BoardStore, output: OutputStore, workflowId: Id, entry: NonNullable<ReturnType<BoardStore['entry']>>,
): Promise<'saved' | 'refused' | 'failed'> {
  const present = entry.history.present;
  const name = present.fields.name;

  if (entry.base) {
    const now = await api.getGraph(workflowId);
    if (now.ok && JSON.stringify(now.value.layout ?? null) !== JSON.stringify(entry.layout ?? null)) {
      output.log(`${name} changed elsewhere since it was loaded; saving over it`, 'warn');
    }
  }

  const saved = await api.saveDesign(workflowId, designRequest(entry.base, present, entry.layout));
  if (!saved.ok) { output.log(`${name}: ${describeError(saved.error)}`, 'error'); return 'failed'; }
  if (!saved.value.applied) {
    for (const e of saved.value.errors ?? []) {
      output.log(`${name}: ${e.id ? entityName(present, entry.base, e.id) : name} — ${e.message ?? ''}`, 'error');
    }
    return 'refused';
  }
  output.log(`${name} saved`, 'ok');

  const loaded = await loadWorkflow(api, workflowId);
  if (!loaded.ok) {
    store.adoptPresent(workflowId);
    output.log(`${name} saved, but could not be read back: ${describeError(loaded.error)}. Reload before editing it again`, 'error');
    return 'saved';
  }
  const { storedFrame: _stored, ...rest } = loaded.value;
  const bw = { ...rest, frame: { ...present.frame } };
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
  return 'saved';
}
