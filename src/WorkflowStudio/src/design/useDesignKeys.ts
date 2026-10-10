import type { KeyboardEvent as ReactKeyboardEvent, MutableRefObject } from 'react';
import type { StudioDocument } from '../app/document';
import { moveWire } from '../circuit/circuit';
import { endPointOf } from '../layout/circuitRoute';
import { GRID } from '../layout/geometry';
import { translatePoints } from '../layout/wireMove';
import { nodePickIds, wirePickIds } from '../store/picks';
import { landBody } from './bodyDrop';
import type { DesignProps } from './designProps';
import { circuitOf, moveGroup, removeWires, withCircuit, type Draft } from './draft';
import { nodeBox } from './hit';
import { overlapJudge } from './overlapJudge';

/** The capsule toolbar and its zoom are drawn inside the canvas: their keys are their own; so are a text field's. */
const NOT_CANVAS = '.docbar, .zoom, input, textarea, select, [contenteditable]';

const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/**
 * The canvas's own keys while it has focus (spec §3.4, §4.5, §5.3): arrows nudge the picked blocks 8 px, the picked
 * wires with them (decision 8, 2026-10-10; a run of nudges is one step); with no block picked, the picked wires as the
 * closed hand moves them (`nudgeWires`, 2026-10-10); Delete removes the picked steps, caches and
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
) {
  return (e: ReactKeyboardEvent) => {
    if (!design) return;
    if ((e.target as Element).closest?.(NOT_CANVAS)) return;
    if (busy()) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && !e.altKey && key === 'z') { e.preventDefault(); if (e.shiftKey) design.onRedo(); else design.onUndo(); return; }
    if (mod && !e.altKey && key === 'y') { e.preventDefault(); design.onRedo(); return; }
    if (mod && !e.altKey && !e.shiftKey && key === 'c') { if (design.onCopy) { e.preventDefault(); design.onCopy(); } return; }
    if (mod && !e.altKey && !e.shiftKey && key === 'v') { if (design.onPaste) { e.preventDefault(); design.onPaste(); } return; }
    if (mod || e.altKey) return;
    const arrow = ARROWS[e.key];
    if (arrow) {
      const moved = new Map<string, { x: number; y: number }>();
      for (const id of nodePickIds(design.picks)) {
        const b = nodeBox(shown.current, id);
        if (b) moved.set(id, { x: b.x + arrow[0] * GRID, y: b.y + arrow[1] * GRID });
      }
      if (moved.size === 0) {
        // no block picked: the picked wires move as the closed hand moves them (the user's rule, 2026-10-10)
        const draft = nudgeWires(saved, shown.current, design.draft, wirePickIds(design.picks), arrow[0] * GRID, arrow[1] * GRID);
        if (draft === null) return;
        e.preventDefault();
        design.onCommit(draft, { merge: 'nudge' });
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

/** How near a nudged end must come to a contact to take it: within half a grid step, so only one it lands on. */
const NUDGE_REACH = GRID / 2;

/**
 * The picked wires (no block picked) moved one grid step by an arrow, each as the closed hand moves it (rule B,
 * `landBody`; the user's rule, 2026-10-10): whole, its shape kept, detached from every contact, the ends joined on it
 * opened where they are drawn; an end that lands on a contact it may take connects there, the others stay open; one
 * that would make a new short circuit stays open. Null when no picked wire is in the circuit or drawn.
 */
export function nudgeWires(saved: StudioDocument, shown: StudioDocument, draft: Draft, ids: readonly string[], dx: number, dy: number): Draft | null {
  let circuit = circuitOf(saved, draft);
  const drawn = new Map(shown.wires.map((w) => [w.id, w.points]));
  const drawnAt = endPointOf(shown.wires);
  let moved = false;
  for (const id of ids) {
    const points = drawn.get(id);
    if (!Object.hasOwn(circuit, id) || !points || points.length < 2) continue;
    const landing = landBody(shown, circuit, id, points, drawnAt, dx, dy, null, NUDGE_REACH, overlapJudge(shown, id, circuit));
    // only a contact it lands on exactly: one it would be shifted onto (a pointer's magnet) would undo the press, so
    // the wire moves the full step, open
    circuit = landing.dx === dx && landing.dy === dy ? landing.result : moveWire(circuit, id, translatePoints(points, dx, dy), drawnAt);
    moved = true;
  }
  return moved ? withCircuit(draft, saved, circuit) : null;
}
