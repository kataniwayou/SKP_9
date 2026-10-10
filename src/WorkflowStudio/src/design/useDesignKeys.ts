import type { KeyboardEvent as ReactKeyboardEvent, MutableRefObject } from 'react';
import type { StudioDocument } from '../app/document';
import { endPointOf } from '../layout/circuitRoute';
import { GRID } from '../layout/geometry';
import { nodePickIds, wirePickIds } from '../store/picks';
import type { DesignProps } from './designProps';
import { circuitOf, moveGroup, removeWires } from './draft';
import { nodeBox } from './hit';

/** The capsule toolbar and its zoom are drawn inside the canvas: their keys are their own; so are a text field's. */
const NOT_CANVAS = '.docbar, .zoom, input, textarea, select, [contenteditable]';

const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/**
 * The canvas's own keys while it has focus (spec §3.4, §4.5, §5.3): arrows nudge the picked blocks 8 px, the picked
 * wires with them (decision 8, 2026-10-10; a run of nudges is one step); with no block picked, the picked wires as the
 * closed hand drags them (`wires`, 2026-10-10: held, its hints shown; let go, dropped); Delete removes the picked steps, caches and
 * wires (2026-10-10; a wire joined on one keeps its place, open; Backspace does nothing); Ctrl+C copies the picks and
 * Ctrl+V pastes the clipboard (Cmd on a Mac); Ctrl+Z undoes, Ctrl+Y and Ctrl+Shift+Z
 * redo. Keys typed in an Inspector field never reach here: the Inspector is outside the canvas. Picks
 * naming blocks or wires the document no longer has (after an undo) are skipped. While `busy` (a rectangle,
 * a wire gesture or a block drag runs) no key acts: the drop would overwrite it. Escape is the gesture's own.
 */
export function useDesignKeys(
  saved: StudioDocument,
  shown: MutableRefObject<StudioDocument>,
  design: DesignProps | undefined,
  busy: () => boolean = () => false,
  /** The closed hand's drag driven by the arrows (`useWireGestures().keys`): picked wires with no block picked. */
  wires?: WireKeys,
) {
  return (e: ReactKeyboardEvent) => {
    if (!design) return;
    if ((e.target as Element).closest?.(NOT_CANVAS)) return;
    if (busy()) return;
    // Escape while an arrow is held drops the held move, as a drag's Escape does
    if (e.key === 'Escape' && wires?.cancel()) { e.preventDefault(); return; }
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod) wires?.release();
    if (mod && !e.altKey && key === 'z') { e.preventDefault(); if (e.shiftKey) design.onRedo(); else design.onUndo(); return; }
    if (mod && !e.altKey && key === 'y') { e.preventDefault(); design.onRedo(); return; }
    if (mod && !e.altKey && !e.shiftKey && key === 'c') { if (design.onCopy) { e.preventDefault(); design.onCopy(); } return; }
    if (mod && !e.altKey && !e.shiftKey && key === 'v') { if (design.onPaste) { e.preventDefault(); design.onPaste(); } return; }
    const arrow = ARROWS[e.key];
    // any other key first lets go of a held arrow move, as a drop
    if (!arrow) wires?.release();
    if (mod || e.altKey) return;
    if (arrow) {
      const moved = new Map<string, { x: number; y: number }>();
      for (const id of nodePickIds(design.picks)) {
        const b = nodeBox(shown.current, id);
        if (b) moved.set(id, { x: b.x + arrow[0] * GRID, y: b.y + arrow[1] * GRID });
      }
      if (moved.size === 0) {
        // no block picked: the picked wires move as the closed hand drags them, its hints shown; the key's release drops them
        if (wires?.move(wirePickIds(design.picks), arrow[0] * GRID, arrow[1] * GRID)) e.preventDefault();
        return;
      }
      e.preventDefault();
      design.onCommit(moveGroup(design.draft, saved, moved, wirePickIds(design.picks), arrow[0] * GRID, arrow[1] * GRID), { merge: 'nudge' });
      return;
    }
    if (e.key === 'Delete' && design.onDelete) {
      e.preventDefault();
      design.onDelete();
      return;
    }
    if (e.key === 'Delete') {
      // every picked wire the circuit has (one gone after an undo is skipped); blocks are never removed (spec §2)
      const circuit = circuitOf(saved, design.draft);
      const ids = wirePickIds(design.picks).filter((id) => Object.hasOwn(circuit, id));
      if (ids.length === 0) return;
      e.preventDefault();
      // a wire joined on a removed one keeps its place: its end opens where it is drawn (plan 9 §2.2-6)
      design.onCommit(removeWires(design.draft, saved, ids, endPointOf(shown.current.wires)), { picks: design.picks.filter((p) => p.kind !== 'wire') });
    }
  };
}

/** The closed hand's drag of the picked wires, driven by the arrows (`useWireGestures().keys`). */
export interface WireKeys {
  move: (ids: readonly string[], ddx: number, ddy: number) => boolean;
  release: () => void;
  cancel: () => boolean;
}

/** Whether a key is one of the arrows (its release lets go of a held wire move). */
export const isArrow = (key: string): boolean => Object.hasOwn(ARROWS, key);
