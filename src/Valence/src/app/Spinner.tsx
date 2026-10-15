import { useEffect, useRef, useState } from 'react';

/** Once a spinner shows, it shows at least this long, so a fast Save does not flicker (the visual only). */
export const MIN_SPIN_MS = 300;

/**
 * Whether a busy mark shows: while `active`, and until MIN_SPIN_MS after it began showing. Only the visual waits; the
 * state behind it (a Save's answer) is not delayed.
 */
export function useMinShown(active: boolean, ms = MIN_SPIN_MS): boolean {
  const since = useRef<number | null>(active ? Date.now() : null);
  const [lingering, setLingering] = useState(false);
  if (active && since.current === null) since.current = Date.now();
  useEffect(() => {
    if (active) { setLingering(false); return; }
    if (since.current === null) return;
    const left = since.current + ms - Date.now();
    if (left <= 0) { since.current = null; setLingering(false); return; }
    setLingering(true);
    const timer = setTimeout(() => { since.current = null; setLingering(false); }, left);
    return () => clearTimeout(timer);
  }, [active, ms]);
  return active || lingering;
}

const REDUCED = '(prefers-reduced-motion: reduce)';

/** The user's reduced-motion preference, followed live (false where the browser cannot say). */
export function useReducedMotion(): boolean {
  const query = () => { try { return globalThis.matchMedia?.(REDUCED) ?? null; } catch { return null; } };
  const [reduced, setReduced] = useState(() => query()?.matches === true);
  useEffect(() => {
    const m = query();
    if (!m) return;
    const changed = () => setReduced(m.matches);
    changed();
    m.addEventListener?.('change', changed);
    return () => m.removeEventListener?.('change', changed);
  }, []);
  return reduced;
}

/** A small CSS spinner (2026-10-10); with reduced motion a gentle pulse instead of a rotation. Decorative: the busy state is said by aria-busy and the page's announcement. */
export function Spinner() {
  const reduced = useReducedMotion();
  return <span className={reduced ? 'spin reduced' : 'spin'} aria-hidden="true" data-testid="spinner" />;
}
