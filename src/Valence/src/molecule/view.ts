import type { Vec } from './layout';

/**
 * How the canvas looks (the user, 2026-10-17): the camera and every atom's place, by atom key. Kept in this browser with
 * the session, so a refresh or a browser restart opens on it; never sent to BaseApi.
 */
export interface CanvasView {
  camera: Vec; target: Vec; up: Vec;
  /** The canvas slide (a lens shift), in px. */
  shift: { x: number; y: number };
  atoms: Record<string, Vec>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const vec = (v: unknown): Vec | null => (Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n)) ? [v[0], v[1], v[2]] as Vec : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** A stored view, or null when its camera is not whole; an atom whose place is not whole is dropped. */
export function parseView(v: unknown): CanvasView | null {
  if (!isRecord(v)) return null;
  const camera = vec(v.camera), target = vec(v.target), up = vec(v.up);
  if (!camera || !target || !up) return null;
  const s = isRecord(v.shift) ? v.shift : {};
  const atoms: Record<string, Vec> = {};
  if (isRecord(v.atoms)) for (const [k, p] of Object.entries(v.atoms)) { const at = vec(p); if (at) atoms[k] = at; }
  return { camera, target, up, shift: { x: num(s.x), y: num(s.y) }, atoms };
}
