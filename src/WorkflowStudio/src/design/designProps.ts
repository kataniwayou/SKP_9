import type { Pick } from '../store/picks';
import type { Draft } from './draft';

/** What the canvas needs to design (plan 4). Without it the canvas stays read-only, as before. */
export interface DesignProps {
  draft: Draft;
  picks: readonly Pick[];
  /** Picks change with no Inspector question: a drag of a block that was not picked (spec §3.4). */
  onPick: (picks: Pick[]) => void;
  /** A finished gesture: one history step (spec §5.3). */
  onCommit: (draft: Draft, options?: { merge?: string; picks?: Pick[] }) => void;
  onUndo: () => void;
  onRedo: () => void;
}
