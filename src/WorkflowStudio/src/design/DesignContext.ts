import { createContext, type PointerEvent as ReactPointerEvent } from 'react';
import type { SourceId } from '../layout/ports';

/** Where wires and blocks hand a press to the designer's gestures (Tasks 7-8). Null: read-only canvas. */
export interface DesignGestures {
  /** A press on a wire's hit band; a picked wire's body drags its nearest run (spec §4.2). */
  wirePointerDown(wireId: string, e: ReactPointerEvent, part?: 'own' | 'branch'): void;
  /** A press on a block's connection point starts a new wire (spec §4.5). */
  portPointerDown(source: SourceId, e: ReactPointerEvent): void;
  /** A press on a loose wire's open end, or open start (plan 8 §5): drags it onto a step, or elsewhere. */
  looseEndPointerDown(looseId: string, e: ReactPointerEvent, end: 'start' | 'end'): void;
}

export const DesignContext = createContext<DesignGestures | null>(null);
