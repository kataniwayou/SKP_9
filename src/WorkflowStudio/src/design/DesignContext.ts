import { createContext, type PointerEvent as ReactPointerEvent } from 'react';
import type { SourceId } from '../layout/ports';

/** Where wires and blocks hand a press to the designer's gestures. Null: read-only canvas. */
export interface DesignGestures {
  /** A press on a wire's hit band: dragged, any wire's body moves the whole wire (the user's rule, 2026-10-08); a click picks it. */
  wirePointerDown(wireId: string, e: ReactPointerEvent): void;
  /** A press on a block's connection point starts a new wire (spec §4.5). */
  portPointerDown(source: SourceId, e: ReactPointerEvent): void;
}

export const DesignContext = createContext<DesignGestures | null>(null);
