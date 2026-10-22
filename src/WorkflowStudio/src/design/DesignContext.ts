import { createContext, type PointerEvent as ReactPointerEvent } from 'react';
import type { SourceId } from '../layout/ports';
import type { Dir } from './autoConnect';

/** Where wires and blocks hand a press to the designer's gestures. Null: read-only canvas. */
export interface DesignGestures {
  /** A press on a wire's hit band: dragged, any wire's body moves the whole wire (the user's rule, 2026-10-08); a click picks it. */
  wirePointerDown(wireId: string, e: ReactPointerEvent): void;
  /** A press on a block's connection point starts a new wire (spec §4.5). */
  portPointerDown(source: SourceId, e: ReactPointerEvent): void;
  /**
   * A press on block `id`'s AutoConnect arrow `dir` (plan 10 phase 6): dragged, a new wire from it (into it for `left`)
   * as from a connection point; released where it was pressed, Visio's click.
   */
  arrowPointerDown(id: string, dir: Dir, e: ReactPointerEvent): void;
  /** The pointer over an arrow (or off it, null): the canvas previews what its click does. */
  arrowHover(at: { id: string; dir: Dir } | null): void;
}

export const DesignContext = createContext<DesignGestures | null>(null);
