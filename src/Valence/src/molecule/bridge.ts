import type { Vec } from './layout';
import type { ArrowKind, AtomType } from './model';

/**
 * What the canvas offers the Toolbox while a tile is dragged (the user, 2026-10-17): the dock draws the two in separate
 * panes, so the canvas registers this while it is shown. Points are client (window) coordinates.
 */
export interface CanvasApi {
  /** Whether the point is over the canvas. */
  contains(x: number, y: number): boolean;
  /** The atom under the point, or null. */
  atomAt(x: number, y: number): string | null;
  /**
   * Where a new atom of `type` lands for a drop at the point — beside `near` (the atom it is dropped on), else on the
   * plane through the view's centre — and its radius on screen there, in px: the dragged ghost is drawn that size.
   */
  landing(x: number, y: number, type: AtomType, near: string | null): { pos: Vec; px: number } | null;
  /** A bond's radius on screen at the depth under the point, in px (an arrow tile's ghost). */
  bondPx(x: number, y: number, kind: ArrowKind): number | null;
  /** Shows only these atoms in full (the valid targets of a drag), the rest dimmed; null: as before. */
  spotlight(keys: ReadonlySet<string> | null): void;
  /** A real arrow of `kind` from `tail` to the point, or onto `head`'s surface; null clears it. */
  aim(preview: { kind: ArrowKind; tail: string; x: number; y: number; head: string | null } | null): void;
  /**
   * After an apply (2026-10-17): the atoms made in Valence get the ids BaseApi gave them. The next rebuild places each
   * real key where its client key stood (`rename`: client key → real key), so nothing jumps.
   */
  rekey(rename: ReadonlyMap<string, string>): void;
  /** While set, a click on the canvas is given to it (the atom under it, or null) instead of pinning. */
  onClick: ((atom: string | null) => void) | null;
}

let current: CanvasApi | null = null;
/** The canvas shown now, or null. */
export const canvasBridge = {
  get: (): CanvasApi | null => current,
  set: (api: CanvasApi | null) => { current = api; },
};
