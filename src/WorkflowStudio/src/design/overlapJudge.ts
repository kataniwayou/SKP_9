import type { StudioDocument } from '../app/document';
import type { Circuit } from '../circuit/circuit';
import { netsOf } from '../circuit/families';
import { routeCircuit } from '../layout/circuitRoute';
import { LineIndex, mayShare, type Stretch } from '../layout/overlaps';
import type { Pt } from '../layout/router';

/**
 * Whether the dragged wire, drawn as `points`, makes a new short circuit by lying on another wire; `after` is the
 * circuit the drop makes (asked for only when the path lies on something).
 */
export type OverlapJudge = (points: readonly Pt[], after: () => Readonly<Circuit>) => boolean;

/** Within (a hair over) a stretch on the same line. */
const within = (s: Stretch, t: Stretch): boolean => {
  const level = s[0][1] === s[1][1];
  if (level !== (t[0][1] === t[1][1])) return false;
  const [k, a, b] = level ? [s[0][1], s[0][0], s[1][0]] : [s[0][0], s[0][1], s[1][1]];
  const [kt, at, bt] = level ? [t[0][1], t[0][0], t[1][0]] : [t[0][0], t[0][1], t[1][1]];
  return Math.abs(k - kt) < 0.01 && Math.min(a, b) >= Math.min(at, bt) - 0.01 && Math.max(a, b) <= Math.max(at, bt) + 0.01;
};

/**
 * For one drag of wire `id` (the user's rule 2, 2026-10-09): the other wires as `shown` draws them are indexed once, so
 * each pointer move only looks at the lines the dragged path lies on. A move makes a new short circuit when the path
 * shares a stretch of line with a wire that may not share one with it in `after` (`mayShare`), and that stretch is new:
 * a stretch the two wires already shared as drawn before the drag (a short circuit already there, or two automatic wires
 * the router left on each other) never refuses it (review 2026-10-09). A wire shaped by hand stays where it is; an
 * automatic one takes a free track around a shape drawn by hand if it can, so then the circuit after the drop is drawn
 * and asked (rarely: only when the path lies on an automatic wire of another net).
 */
export function overlapJudge(shown: StudioDocument, id: string): OverlapJudge {
  const index = new LineIndex();
  for (const w of shown.wires) if (w.id !== id) index.add(w.id, w.points);
  const mine = shown.wires.find((w) => w.id === id);
  // the stretches it shares with each wire as drawn now
  const before = mine ? index.stretches(mine.points, () => true) : new Map<string, Stretch[]>();
  const fresh = (x: string, stretches: readonly Stretch[]) => stretches.some((s) => !(before.get(x) ?? []).some((t) => within(s, t)));
  const conditionOf = (s: string) => shown.graph.steps.get(s)?.entryCondition;
  return (points, after) => {
    const hits = [...index.stretches(points, () => true)].filter(([x, ss]) => fresh(x, ss));
    if (hits.length === 0) return false;
    const c = after();
    const share = mayShare(c, netsOf(c, conditionOf));
    const clash = hits.map(([x]) => x).filter((x) => !share(id, x));
    if (clash.length === 0) return false;
    if (clash.some((x) => !Object.hasOwn(c, x) || (c[x]!.bends?.xs.length ?? 0) > 0)) return true;
    // automatic wires may step aside: ask the drawing after the drop, still counting new stretches only
    const routes = routeCircuit(c, { placement: shown.placement, steps: shown.graph.steps });
    const drawn = routes.find((r) => r.id === id);
    if (!drawn) return false;
    const now = new LineIndex();
    for (const r of routes) if (r.id !== id && (drawn.shortWith ?? []).includes(r.id)) now.add(r.id, r.points);
    return [...now.stretches(drawn.points, () => true)].some(([x, ss]) => fresh(x, ss));
  };
}
