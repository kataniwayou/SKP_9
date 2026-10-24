import { createContext, useContext } from 'react';
import type { Id } from '../model/graph';
import type { StudioApi } from '../api/client';
import type { InspectorService } from './inspectorService';
import type { StudioCommands } from './studioCommands';

/** What the panes may ask of the page (slice 3b). Dock panels are React portals, so they see it too. */
export interface StudioActions {
  service: InspectorService;
  /** BaseApi, for panes that read lists of their own (the Toolbox, 2026-10-11). Absent in a pane's own tests. */
  api?: StudioApi;
  /**
   * Runs `proceed` now; it waits only while a dialog is open (plan 8: Inspector edits live in the design,
   * so moving away loses nothing). `doc`: the window the action came from.
   */
  guard(workflowId: Id, proceed: () => void, doc?: Document): void;
  /** The page's workflow commands for the chat (2026-10-23), without the dialogs. Absent in a pane's own tests. */
  commands?: StudioCommands;
}

const Context = createContext<StudioActions | null>(null);

export const StudioActionsProvider = Context.Provider;

export function useStudioActions(): StudioActions {
  const actions = useContext(Context);
  if (!actions) throw new Error('useStudioActions needs a StudioActionsProvider above it.');
  return actions;
}

/** The page's actions, or null (a panel rendered on its own, in a test, has no page). */
export function useStudioActionsOrNull(): StudioActions | null {
  return useContext(Context);
}

const UNGUARDED: StudioActions['guard'] = (_workflowId, proceed) => proceed();

/** The page's guard, or none (a pane rendered on its own, in a test, has nothing to guard). */
export function useGuard(): StudioActions['guard'] {
  return useContext(Context)?.guard ?? UNGUARDED;
}
