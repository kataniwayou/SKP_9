import type { StudioDocument } from '../app/document';
import type { Circuit } from '../circuit/circuit';
import { netsOf } from '../circuit/families';
import { routeCircuit } from '../layout/circuitRoute';
import { LineIndex, mayShare } from '../layout/overlaps';
import type { Pt } from '../layout/router';

/**
 * Whether the dragged wire, drawn as `points`, makes a new short circuit by lying on another wire; `after` is the
 * circuit the drop makes (asked for only when the path lies on something).
 */
export type OverlapJudge = (points: readonly Pt[], after: () => Readonly<Circuit>) => boolean;

/**
 * For one drag of wire `id` (the user's rule 2, 2026-10-09): the other wires as `shown` draws them are indexed once, so
 * each pointer move only looks at the lines the dragged path lies on. A move makes a new short circuit when the path
 * shares a stretch of line with a wire that may not share one with it in `after` (`mayShare`: both directed, one net)
 * and that pair was not already a short circuit before the drag (one already there does not refuse it). A wire shaped
 * by hand stays where it is; an automatic one takes a free track around a shape drawn by hand if it can, so then the
 * circuit after the drop is drawn and asked (rarely: only when the path lies on an automatic wire of another net).
 */
export function overlapJudge(shown: StudioDocument, id: string): OverlapJudge {
  const index = new LineIndex();
  for (const w of shown.wires) if (w.id !== id) index.add(w.id, w.points);
  const before = new Set(shown.wires.find((w) => w.id === id)?.shortWith ?? []);
  const conditionOf = (s: string) => shown.graph.steps.get(s)?.entryCondition;
  return (points, after) => {
    const hits = index.stretches(points, (x) => !before.has(x));
    if (hits.size === 0) return false;
    const c = after();
    const share = mayShare(c, netsOf(c, conditionOf));
    const clash = [...hits.keys()].filter((x) => !share(id, x));
    if (clash.length === 0) return false;
    if (clash.some((x) => !Object.hasOwn(c, x) || (c[x]!.bends?.xs.length ?? 0) > 0)) return true;
    const drawn = routeCircuit(c, { placement: shown.placement, steps: shown.graph.steps }).find((r) => r.id === id);
    return (drawn?.shortWith ?? []).some((x) => !before.has(x));
  };
}
