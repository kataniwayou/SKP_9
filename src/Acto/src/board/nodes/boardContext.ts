import { createContext, useContext } from 'react';
import type { Pick } from '../selection';

/** One button of an item's toolbar. */
export interface ToolbarItem {
  label: string;
  onClick: () => void;
  /** `go` / `stop` are the green and red run buttons; `danger` is Delete. */
  tone?: 'go' | 'stop' | 'danger' | 'primary';
  disabled?: boolean;
  /** A line of text in the bar (a confirm's question), not a button. */
  note?: boolean;
}

/**
 * What the toolbar over a lone pick holds (Task 12 provides it: triangle Start/Stop · Delete, step Copy · Delete, the rest
 * Delete). null or an empty list shows no toolbar; without a provider no node or edge draws one.
 */
export type ToolbarActions = (p: Pick) => ToolbarItem[] | null;
export const ToolbarContext = createContext<ToolbarActions | null>(null);
export const useToolbarActions = () => useContext(ToolbarContext);
