import type { Pick } from '../store/picks';
import type { Dir } from './autoConnect';
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
  /** Ctrl+C (2026-10-10): the picks to the studio's clipboard. */
  onCopy?: () => void;
  /** Ctrl+V: the clipboard pasted here, one history step. */
  onPaste?: () => void;
  /** Delete: the picked steps, caches and wires out of the design, one history step; absent, only picked wires go. */
  onDelete?: () => void;
  /** A click on block `id`'s AutoConnect arrow `dir` (plan 10 phase 6): one history step, or nothing when refused. */
  onAutoConnect?: (id: string, dir: Dir) => void;
}
