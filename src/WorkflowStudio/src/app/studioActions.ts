import { createContext, useContext } from 'react';
import type { Id } from '../model/graph';
import type { InspectorService } from './inspectorService';

/** What the panes may ask of the page (slice 3b). Dock panels are React portals, so they see it too. */
export interface StudioActions {
  service: InspectorService;
  /**
   * Runs `proceed` now, or, when the document has unsaved Inspector edits, after the user chose
   * Save (and it worked) or Discard in the dialog (spec §7.1). `doc`: the window the action came from.
   */
  guard(workflowId: Id, proceed: () => void, doc?: Document): void;
  /** Asks before removing a step's assignment (taken off this workflow and deleted), then removes it. */
  confirmRemove(workflowId: Id, assignmentId: Id, doc?: Document): void;
}

const Context = createContext<StudioActions | null>(null);

export const StudioActionsProvider = Context.Provider;

export function useStudioActions(): StudioActions {
  const actions = useContext(Context);
  if (!actions) throw new Error('useStudioActions needs a StudioActionsProvider above it.');
  return actions;
}

const UNGUARDED: StudioActions['guard'] = (_workflowId, proceed) => proceed();

/** The page's guard, or none (a pane rendered on its own, in a test, has nothing to guard). */
export function useGuard(): StudioActions['guard'] {
  return useContext(Context)?.guard ?? UNGUARDED;
}
