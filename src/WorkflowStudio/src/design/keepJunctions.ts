import type { StudioDocument } from '../app/document';
import { setEnd, type Circuit, type CircuitWire } from '../circuit/circuit';
import { contactOn } from '../layout/circuitRoute';
import { snap } from '../layout/geometry';
import { nearestOn } from '../layout/junctions';
import type { Pt } from '../layout/router';
import { applyDraft } from './apply';
import { circuitOf, withCircuit, type Draft } from './draft';

const same = (a: CircuitWire | undefined, b: CircuitWire | undefined) => a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b);
const samePoints = (a: readonly Pt[], b: readonly Pt[]) => a.length === b.length && a.every((p, i) => p[0] === b[i]![0] && p[1] === b[i]![1]);

/**
 * Junctions keep their place on the drawing (the user's ruling, 2026-10-20): when a commit leaves a host wire as it was
 * in the circuit (same ends, same bends) but the router draws it again elsewhere (a block moved, another wire in its
 * way), every junction on it that the commit did not touch moves to the point of the new line nearest where it was
 * drawn, instead of keeping its distance along the line (which slid it along the new route). A host the commit edits
 * itself (dragged, shaped, its end moved) still carries its junctions with it. `saved` is the edited document the
 * drafts lie over. Returns `next`, with the junctions re-pinned when any moved.
 */
export function keepJunctions(saved: StudioDocument, prev: Draft, next: Draft): Draft {
  if (prev === next) return next;
  const was = circuitOf(saved, prev), now = circuitOf(saved, next);
  if (!Object.values(now).some((w) => w.tail.on === 'wire' || w.head.on === 'wire')) return next;
  const before = new Map(applyDraft(saved, prev).wires.map((w) => [w.id, w.points]));
  const after = new Map(applyDraft(saved, next).wires.map((w) => [w.id, w.points]));
  let out: Circuit = now;
  for (const [id, w] of Object.entries(now)) {
    for (const side of ['tail', 'head'] as const) {
      const end = w[side];
      if (end.on !== 'wire') continue;
      const old = was[id]?.[side];
      // the commit moved this end (a drop, a slide along its host): it is where the gesture put it
      if (old === undefined || old.on !== 'wire' || old.host !== end.host || old.at !== end.at) continue;
      if (!same(was[end.host], now[end.host])) continue;
      const from = before.get(end.host), to = after.get(end.host);
      if (!from || !to || samePoints(from, to)) continue;
      const at = snap(nearestOn([to], contactOn(from, end.at).p).at);
      if (at !== end.at) out = setEnd(out, id, side, { on: 'wire', host: end.host, at });
    }
  }
  return out === now ? next : withCircuit(next, saved, out);
}
