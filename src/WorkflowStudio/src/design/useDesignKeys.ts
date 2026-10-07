import type { KeyboardEvent as ReactKeyboardEvent, MutableRefObject } from 'react';
import type { StudioDocument } from '../app/document';
import { GRID } from '../layout/geometry';
import { nodePickIds, wirePickIds } from '../store/picks';
import type { DesignProps } from './designProps';
import { moveBlocks, removeWires } from './draft';
import { nodeBox } from './hit';

/** The capsule toolbar and its zoom are drawn inside the canvas: their keys are their own. */
const NOT_CANVAS = '.docbar, .zoom';

const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/**
 * The canvas's own keys while it has focus (spec §3.4, §4.5, §5.3): arrows nudge the picked blocks 8 px
 * (a run of nudges is one step), Delete removes the picked wires, Ctrl+Z undoes, Ctrl+Y and Ctrl+Shift+Z
 * redo. Keys typed in an Inspector field never reach here: the Inspector is outside the canvas. Picks
 * naming blocks or wires the document no longer has (after an undo) are skipped. While `busy` (a rectangle,
 * a wire gesture or a block drag runs) no key acts: the drop would overwrite it. Escape is the gesture's own.
 */
export function useDesignKeys(
  saved: StudioDocument,
  shown: MutableRefObject<StudioDocument>,
  design: DesignProps | undefined,
  busy: () => boolean = () => false,
) {
  return (e: ReactKeyboardEvent) => {
    if (!design) return;
    if ((e.target as Element).closest?.(NOT_CANVAS)) return;
    if (busy()) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && !e.altKey && key === 'z') { e.preventDefault(); if (e.shiftKey) design.onRedo(); else design.onUndo(); return; }
    if (mod && !e.altKey && key === 'y') { e.preventDefault(); design.onRedo(); return; }
    if (mod || e.altKey) return;
    const arrow = ARROWS[e.key];
    if (arrow) {
      const moved = new Map<string, { x: number; y: number }>();
      for (const id of nodePickIds(design.picks)) {
        const b = nodeBox(shown.current, id);
        if (b) moved.set(id, { x: b.x + arrow[0] * GRID, y: b.y + arrow[1] * GRID });
      }
      if (moved.size === 0) return;
      e.preventDefault();
      design.onCommit(moveBlocks(design.draft, saved, moved), { merge: 'nudge' });
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const wires = wirePickIds(design.picks).filter((id) => shown.current.wires.some((w) => w.id === id));
      if (wires.length === 0) return; // blocks are never removed in the trial (spec §2)
      e.preventDefault();
      design.onCommit(removeWires(design.draft, saved, wires), { picks: design.picks.filter((p) => p.kind !== 'wire') });
    }
  };
}
