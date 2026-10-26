import type { StudioDocument } from '../app/document';
import type { Circuit, Side } from '../circuit/circuit';
import { endPointOf } from '../layout/circuitRoute';
import type { Pt } from '../layout/router';
import { landBody, type BodyEnd } from './bodyDrop';
import { circuitOf, withCircuit, type Draft } from './draft';
import { overlapJudge } from './overlapJudge';

/**
 * A run of arrow presses on picked wires with no block picked (the user's rule, 2026-10-10): one closed-hand drag of
 * them, measured from where it began, as a drag is from its press. `base` is the draft and `shown` the wires as drawn
 * before its first press; `dx`, `dy` how far it has moved them; `first` each wire's end that reached a contact first;
 * `after` the picked wires as its last release left them (a later press continues the run only while they are still
 * so: an undo or any other change starts a new one).
 */
export interface WireRun {
  ids: string;
  base: Draft;
  shown: StudioDocument;
  dx: number;
  dy: number;
  first: Record<string, Side | null>;
  after: string;
}

/** Where a run's presses so far land the wires: what to show while the arrow is held, and what its release makes. */
export interface RunLanding {
  run: WireRun;
  /** Moved, open at their ends (the drag's preview). */
  preview: Circuit;
  /** Each end over a contact it may take connected there (the drag's drop). */
  result: Circuit;
  /** Every moved wire's ends: what each is over and its verdict (the drag's hints: the step's frame, "connect here"). */
  ends: BodyEnd[];
  /** Back exactly where the run began: the release leaves the draft as it was. */
  still: boolean;
  /** The draft the release commits. */
  next: Draft;
}

const wiresKey = (c: Readonly<Circuit>, ids: readonly string[]) => JSON.stringify(ids.map((id) => c[id] ?? null));

/**
 * The picked wires `ids` moved one more step (`ddx`, `ddy`) in a run of arrow presses, exactly as the closed hand moves
 * them (rule B, `landBody`, with the drag's reach): each whole, its shape kept, detached from every contact, the ends
 * joined on it opened where they are drawn; an end over a contact it may take shifts the wire onto it and connects there
 * on release (the end that got there first decides), the others stay open; connected, a new short circuit leaves its
 * ends open. Back exactly where the run began, the draft is as it was. `held`: the arrow is still down (nothing
 * committed since the last press), so the run goes on whatever the draft. Null when no picked wire is in the circuit or
 * drawn.
 */
export function landWires(
  saved: StudioDocument, shown: StudioDocument, draft: Draft, ids: readonly string[], ddx: number, ddy: number,
  last: WireRun | null, held: boolean, reach: number,
): RunLanding | null {
  const key = JSON.stringify(ids);
  const go = last !== null && last.ids === key && (held || last.after === wiresKey(circuitOf(saved, draft), ids));
  const run: WireRun = go ? last : { ids: key, base: draft, shown, dx: 0, dy: 0, first: {}, after: '' };
  const dx = run.dx + ddx, dy = run.dy + ddy;
  const from = run.shown;
  const drawn = new Map(from.wires.map((w) => [w.id, w.points as readonly Pt[]]));
  const drawnAt = endPointOf(from.wires);
  let result = circuitOf(saved, run.base), preview = result;
  const first: Record<string, Side | null> = {};
  const ends: BodyEnd[] = [];
  let moved = false, still = true;
  for (const id of ids) {
    const points = drawn.get(id);
    if (!Object.hasOwn(result, id) || !points || points.length < 2) continue;
    moved = true;
    const l = landBody(from, result, id, points, drawnAt, dx, dy, run.first[id] ?? null, reach, overlapJudge(from, id, result));
    first[id] = l.first;
    ends.push(...l.ends, ...l.joins);
    // shifted back exactly where it was: as it was (a drag back to its start)
    if (l.dx === 0 && l.dy === 0) continue;
    still = false;
    result = l.result;
    preview = landBody(from, preview, id, points, drawnAt, dx, dy, run.first[id] ?? null, reach).preview;
  }
  if (!moved) return null;
  // moved together, the links between them stay (rule 2, the user's 2026-10-26): an end joined on another of them is
  // joined there again, as far along it (both moved alike)
  if (!still) {
    const before = circuitOf(saved, run.base), inGroup = new Set(ids);
    for (const id of ids) {
      const w = result[id], was = before[id];
      if (!w || !was) continue;
      const keep = (side: Side) => {
        const e = was[side];
        return e.on === 'wire' && inGroup.has(e.host) && Object.hasOwn(result, e.host) ? e : w[side];
      };
      const tail = keep('tail'), head = keep('head');
      if (tail !== w.tail || head !== w.head) result = { ...result, [id]: { ...w, tail, head } };
    }
  }
  const next = still ? run.base : withCircuit(run.base, saved, result);
  return { run: { ...run, dx, dy, first, after: wiresKey(circuitOf(saved, next), ids) }, preview, result, ends, still, next };
}
