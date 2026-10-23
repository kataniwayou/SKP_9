import type { ApiResult } from '../api/client';
import type { WorkflowReadDto } from '../api/types';
import type { Id } from '../model/graph';
import type { RunOp } from '../store/run';
import type { StudioStore } from '../store/studioStore';
import type { DeletePlan } from './deleteWorkflow';

/**
 * What the chat may ask of the page (2026-10-23): App's workflow-level handlers without their pop-up dialogs, because
 * the chat asks the user itself. The guards and Output lines the UI has (still loading or saving, the AI drawing,
 * one deletion at a time) are the same ones: App shares one path between its menus and these.
 */
export interface StudioCommands {
  listWorkflows(): Promise<ApiResult<WorkflowReadDto[]>>;
  /** Opens (or activates) the workflow; resolves 'ready' when its document is ready, or the failure message. */
  open(workflowId: Id): Promise<'ready' | string>;
  /** A blank workflow, as Workflow › New workflow makes it; resolves its id once the document exists. */
  newWorkflow(): Promise<Id>;
  activate(workflowId: Id): void;
  /** App's Save (it re-reads the picker list when a new workflow was created). */
  save(workflowId: Id): Promise<void>;
  /** Start or Stop, as the toolbar does it. */
  run(workflowId: Id, op: RunOp): Promise<void>;
  /** The delete up to its warning, with no warning shown; null when the deletion stopped here (Output says why). */
  prepareDelete(workflowId: Id): Promise<DeletePlan | null>;
  /** The real deletion, after App's cleanup (views, opens, picker list); true when it was deleted. */
  commitDelete(plan: DeletePlan): Promise<boolean>;
  /** Closes the document with no question: its design draft goes with it. Refused while the AI is drawing it. */
  close(workflowId: Id): void;
}

/**
 * Resolves 'ready' when the document is ready, or the failure message when it failed; a document that is gone (closed
 * while loading) says so. Reads the store now, then on every change.
 */
export function documentSettled(store: StudioStore, workflowId: Id): Promise<'ready' | string> {
  return new Promise((resolve) => {
    const check = (): boolean => {
      const doc = store.getState().docs.find((d) => d.workflowId === workflowId);
      if (!doc) { resolve('The workflow was closed before it finished loading'); return true; }
      if (doc.status.kind === 'ready') { resolve('ready'); return true; }
      if (doc.status.kind === 'failed') { resolve(doc.status.message); return true; }
      return false;
    };
    if (check()) return;
    const stop = store.subscribe(() => { if (check()) stop(); });
  });
}
