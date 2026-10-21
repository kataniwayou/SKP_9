import { isAutomatic, isFree, plainCircuit, type Circuit, type CircuitWire, type End, type Side } from '../circuit/circuit';
import { netsOf, shortedWires } from '../circuit/families';
import type { Id, Step } from '../model/graph';
import { clearPath } from './detour';
import { GRID, PMID, SPHERE_R, STEP_W, TRACK, clampLanding, offset, snap, type Point } from './geometry';
import { CONTACT_MARGIN, lengthOf, ownEnds, pointAt } from './junctions';
import { LineIndex, mayShare, overlapsOf, sharesNet, type Stretch } from './overlaps';
import type { Placement } from './placement';
import { landingsOf, WORKFLOW_SOURCE, type Arrival, type SourceId } from './ports';
import { hitsOf, route, simplify, type Box, type Pt, type RouteAvoid } from './router';
import { routeBlocks, Tracks } from './search';
import { JOG, pointsOfShape, shapeFromPoints, type Ends } from './shape';
import { blockBoxes, SPHERE_BOX_ID, stepBoxId, type WiringInput } from './wires';

/** What one end of a drawn wire is on (plan 9 §5): a ring or an arrow head on a terminal or open, a filled circle on a junction. */
export type EndKind = 'terminal' | 'junction' | 'open';

/** One wire of the circuit as drawn (plan 9 §5). */
export interface WireRoute {
  id: string;
  /** Its tail's terminal: a step (its output) or `wf` (the hub); null on a wire or open. */
  source: SourceId | null;
  /** Its head's step (its input); null on a wire or open. */
  target: Id | null;
  /** From its tail to its head. */
  points: Pt[];
  /** The part its bends shape: between a lead-out (the hub's ring, a junction on a level run) and a lead-in (a junction). */
  core: { ends: Ends; points: Pt[] };
  /** Its net's family, an entry condition; null: undecided, grey (spec §4). */
  condition: number | null;
  /** Both own ends connected and the family decided (spec §5); otherwise dashed. */
  solid: boolean;
  tailOn: EndKind;
  headOn: EndKind;
  /**
   * In a short-circuited net (§2.2-7): its families disagree, or one of its wires shares a stretch of line with a wire
   * of another net (the user's rule 2, 2026-10-09); its junctions are marked red.
   */
  short: boolean;
  /** The stretches it shares with wires of other nets (rule 2), drawn red; absent when none. */
  overlaps?: Stretch[];
  /** The wires it shares those stretches with, in the order they are drawn; absent when none. */
  shortWith?: string[];
  /** No end on a step or the hub (rule D, 2026-10-09): no direction yet, so neither a tail ring nor an arrow head. */
  free: boolean;
}

export interface RouteContext {
  placement: Placement;
  /** Every step on the canvas: the family a head on it decides is its entry condition. */
  steps: ReadonlyMap<Id, Step>;
}

/** The point `at` px along a drawn line, kept clear of its ends (plan 7 §5.3), and whether the run there is vertical. */
export function contactOn(points: readonly Pt[], at: number): { p: Pt; vertical: boolean } {
  return pointAt([points], contactDistance(points, at));
}

/** How far along a drawn line a junction stored `at` px along it is drawn: snapped to the grid, kept clear of its ends. */
export function contactDistance(points: readonly Pt[], at: number): number {
  const total = lengthOf([points]);
  return total < 2 * CONTACT_MARGIN ? total / 2 : Math.min(Math.max(snap(at, GRID), CONTACT_MARGIN), total - CONTACT_MARGIN);
}

const tenth = (v: number) => Math.round(v * 10) / 10;

/**
 * A tail on the hub's ring at `angle` (decision 4): from that ring point, on the right half sideways to the right,
 * on the left half up (top) or down (bottom) out of the hub's square and then right; `start` is where its own
 * route begins, `lead` the points before it.
 */
export function hubLead(cx: number, cy: number, angle: number): { start: Point; lead: Pt[] } {
  const r = (angle * Math.PI) / 180;
  const ring: Pt = [tenth(cx + SPHERE_R * Math.cos(r)), tenth(cy + SPHERE_R * Math.sin(r))];
  const right = snap(cx + SPHERE_R + JOG);
  if (Math.cos(r) > -1e-9) return { start: { x: right, y: ring[1] }, lead: [ring] };
  const y = snap(Math.sin(r) < 0 ? cy - SPHERE_R - JOG : cy + SPHERE_R + JOG);
  return { start: { x: right, y }, lead: [ring, [ring[0], y]] };
}

/**
 * Where a tail on the hub at `angle` starts its core, and the lead before it (review 2026-10-09). A wire with a shape of
 * its own (`aim`: the x of its first vertical run) starts at its ring point snapped to the grid, after a short lead
 * from the ring (one jog onto the grid), so a shape moved onto the hub keeps every run where it was put; a tail on the
 * hub's left half whose shape heads right, and an automatic wire (`aim` null), leave as `hubLead` draws them.
 */
export function hubStart(cx: number, cy: number, angle: number, aim: number | null): { start: Point; lead: Pt[] } {
  const h = hubLead(cx, cy, angle);
  if (aim === null || (Math.cos((angle * Math.PI) / 180) < -1e-9 && aim > cx)) return h;
  const ring = h.lead[0]!;
  const start = { x: snap(ring[0]), y: snap(ring[1]) };
  return { start, lead: [ring, [ring[0], start.y]] };
}

/** One end as routed: where it is, the router box it is on ('' for none), the points before it, and a junction's contact. */
interface Placed { at: Point; box: string; lead: Pt[]; contact: Pt | null; vertical: boolean }
const placedAt = (at: Point, box = '', lead: Pt[] = []): Placed => ({ at, box, lead, contact: null, vertical: false });
const kindOf = (e: End): EndKind => (e.on === 'wire' ? 'junction' : e.on === 'open' ? 'open' : 'terminal');
/** How far beside its other end an end is drawn when what it is on is gone (decision 6). */
const BESIDE = 96;

/**
 * Every wire of the circuit, drawn (plan 9 §5). Automatic tails of one source leave 16 apart round its processor
 * middle (the hub's centre), ordered by where they head; automatic heads land by the landing rule (spec §5.2);
 * slid ends sit where they were put; hub tails start on the ring; junctions sit on their host's drawn line (hosts
 * are drawn first). A wire's own bends shape its core; without them the router draws it around the blocks. Each
 * wire gets its net's family (§4), solid when both its ends are connected and the family is decided.
 */
export function routeCircuit(circuit: Readonly<Circuit>, ctx: RouteContext): WireRoute[] {
  const { placement, steps } = ctx;
  // routed in one stable order (by id), whatever order the circuit lists its wires in (review 2026-10-09)
  const ids = Object.keys(circuit).sort();
  const boxes = blockBoxes(placement);
  const stepAt = (id: Id) => (steps.has(id) ? placement.steps.get(id) : undefined);
  const wire = (id: string): CircuitWire => circuit[id]!;
  const hostOf = (e: End): string | undefined => (e.on === 'wire' && Object.hasOwn(circuit, e.host) ? e.host : undefined);

  // where a wire heads: the order its source's automatic tails leave in, so they never cross (spec §5.2)
  const aim = (id: string): Point => {
    const seen = new Set<string>();
    let w: string | undefined = id;
    while (w !== undefined && !seen.has(w)) {
      seen.add(w);
      const h: End = wire(w).head;
      if (h.on === 'step') { const p = stepAt(h.step); return p ? { x: p.x, y: p.y } : { x: 0, y: 0 }; }
      if (h.on === 'open') return { x: h.x, y: h.y };
      w = hostOf(h);
    }
    return { x: 0, y: 0 };
  };
  const conditionOf = (id: Id) => steps.get(id)?.entryCondition;
  const nets = netsOf(circuit, conditionOf);
  const sameNet = sharesNet(circuit, nets);
  const groups = new Map<SourceId, string[]>();
  for (const id of ids) {
    const t = wire(id).tail;
    // a hub tail held at its drawn height (`dy`) keeps it: it takes no part in the fan-out
    const s = t.on === 'step' && t.y === null && stepAt(t.step) ? t.step : t.on === 'hub' && t.angle === null && t.dy === undefined ? WORKFLOW_SOURCE : null;
    if (s !== null) groups.set(s, [...(groups.get(s) ?? []), id]);
  }
  // the tails of one source that share a net (or are its same-colour siblings, rule G's bus) leave at one height and
  // share one trunk, as Visio's fan-out does; each other group leaves a track (32) away (plan 10 phase 3, spec §4.2)
  const departY = new Map<string, number>(), nudge = new Map<string, number>();
  for (const [s, members] of groups) {
    const ordered = [...members].sort((a, b) => { const p = aim(a), q = aim(b); return p.y - q.y || p.x - q.x || (a < b ? -1 : a > b ? 1 : 0); });
    const classes: string[][] = [];
    for (const id of ordered) {
      const c = classes.find((m) => m.some((x) => sameNet(id, x)));
      if (c) c.push(id); else classes.push([id]);
    }
    const base = s === WORKFLOW_SOURCE ? placement.sphere.cy : placement.steps.get(s)!.y + PMID;
    classes.forEach((m, k) => { const o = offset(k, classes.length, TRACK); for (const id of m) { departY.set(id, base + o); nudge.set(id, o); } });
  }

  const { cx, cy } = placement.sphere;
  /** A tail that is not on a wire; null on a step off the canvas. */
  const tailOf = (id: string): Placed | null => {
    const t = wire(id).tail;
    if (t.on === 'step') {
      const p = stepAt(t.step);
      return p ? placedAt({ x: p.x + STEP_W, y: t.y === null ? departY.get(id)! : p.y + clampLanding(t.y) }, stepBoxId(t.step)) : null;
    }
    if (t.on === 'hub') {
      if (t.angle === null) return placedAt({ x: cx + SPHERE_R, y: t.dy !== undefined ? cy + t.dy : departY.get(id)! }, SPHERE_BOX_ID);
      const own = wire(id).bends;
      const h = hubStart(cx, cy, t.angle, own && own.xs.length > 0 ? own.xs[0]! : null);
      return placedAt(h.start, '', h.lead);
    }
    return t.on === 'open' ? placedAt({ x: t.x, y: t.y }) : null;
  };

  // every head on a step is an arrival (a slid one too: it keeps its slot, as in plan 4); a tail on a wire is not
  // known before its host is drawn, so it arrives bent, from the step's middle
  const arrivals: Arrival[] = [];
  for (const id of ids) {
    const h = wire(id).head;
    const p = h.on === 'step' ? stepAt(h.step) : undefined;
    if (!p || h.on !== 'step') continue;
    const t = wire(id).tail.on === 'wire' ? null : tailOf(id);
    arrivals.push(t ? { key: id, target: h.step, y: t.at.y, x: t.at.x } : { key: id, target: h.step, y: p.y + PMID, x: Infinity });
  }
  const landed = landingsOf(arrivals, placement);

  const families = new Map<string, number[]>();
  for (const n of nets) for (const w of n.wires) families.set(w, n.families);
  // what is drawn so far, so an automatic wire keeps off every wire of another net where it can (rule 2): it takes a
  // track of its own. Which overlaps are short circuits is `mayShare` (two automatic wires never are).
  const share = mayShare(circuit, nets);
  const boxById = new Map<string, Box>(boxes.map((b) => [b.id, b]));
  let taken = new LineIndex();
  const clashes = (id: string, pts: Pt[]): number => taken.count(pts, (x) => !sameNet(id, x));
  /** The runs of every wire drawn so far of another net than `id`'s, for Visio's router to keep off. */
  const othersOf = (id: string): Tracks => {
    const t = new Tracks();
    for (const [x, r] of out) if (x !== id && !sameNet(id, x)) t.add(r.points);
    return t;
  };
  /** The family of the step a wire's head chain goes into: what a wire of a shorted net is drawn in (decision 10). */
  const headFamily = (id: string): number | undefined => {
    const seen = new Set<string>();
    let w: string | undefined = id;
    while (w !== undefined && !seen.has(w)) {
      seen.add(w);
      const h: End = wire(w).head;
      if (h.on === 'step') return conditionOf(h.step);
      w = hostOf(h);
    }
    return undefined;
  };

  const out = new Map<string, WireRoute>();
  const busy = new Set<string>();
  const routeOne = (id: string): WireRoute | undefined => {
    const done = out.get(id);
    if (done || busy.has(id)) return done;
    busy.add(id);
    const w = wire(id);
    const onHost = (e: End): Placed | null => {
      const host = e.on === 'wire' && e.host !== id ? hostOf(e) : undefined;
      const drawn = host === undefined ? undefined : routeOne(host);
      if (!drawn || e.on !== 'wire') return null;
      const c = contactOn(drawn.points, e.at);
      return { at: { x: c.p[0], y: c.p[1] }, box: '', lead: [], contact: c.p, vertical: c.vertical };
    };
    const tail = w.tail.on === 'wire' ? onHost(w.tail) : tailOf(id);
    let head: Placed | null = null;
    const h = w.head;
    if (h.on === 'step') {
      const p = stepAt(h.step);
      if (p) head = placedAt({ x: p.x, y: h.y === null ? landed.get(id)! : p.y + clampLanding(h.y) }, stepBoxId(h.step));
    } else if (h.on === 'open') head = placedAt({ x: h.x, y: h.y });
    else head = onHost(h);
    // an end on nothing it can be drawn on (a host gone or looping back, a step off the canvas): open beside the other end
    const T: Placed = tail ?? placedAt(head ? { x: head.at.x - BESIDE, y: head.at.y } : { x: 0, y: 0 });
    const H: Placed = head ?? placedAt({ x: T.at.x + BESIDE, y: T.at.y });

    // both ends on blocks and no shape of its own: Visio's router (plan 10 phase 3), which keeps off other nets' runs
    // itself, so no spread of tracks is searched for it
    const searched = !(w.bends && w.bends.xs.length > 0) && T.box !== '' && H.box !== '' && boxById.has(T.box) && boxById.has(H.box);
    // a junction on a level run is left and reached square-on, one jog off the line (plan 7 §5.3), on the side the other
    // end is (`flip`: the other side)
    const drawWith = (flipTail: boolean, flipHead: boolean, spread: number, avoid = true, at: { sy?: number; ty?: number } = {}, mix = false): { ends: Ends; core: Pt[]; points: Pt[] } => {
      // a shape drawn by hand leaves and reaches a level junction on the side its own next (or last) run is, as it was
      // drawn (review 2026-10-09): its first run's way out, its last run's way in
      const b = w.bends && w.bends.xs.length > 0 ? w.bends : null;
      let sy = at.sy ?? T.at.y, lead = T.lead;
      if (T.contact && !T.vertical) {
        lead = [T.contact];
        const toward = b && b.ys.length > 0 ? b.ys[0]! : H.at.y;
        sy = snap(T.contact[1] + ((toward >= T.contact[1]) !== flipTail ? JOG : -JOG));
      }
      const sx = T.at.x;
      let tx = H.at.x, ty = at.ty ?? H.at.y, leadIn: Pt[] = [];
      if (H.contact) {
        const o = ownEnds(sx, sy, H.contact, H.vertical);
        tx = o.ends.tx; ty = o.ends.ty; leadIn = o.tail;
        if (b && !H.vertical) {
          const from = b.ys.length > 0 ? b.ys[b.ys.length - 1]! : sy;
          ty = snap(from > H.contact[1] ? H.contact[1] + JOG : H.contact[1] - JOG, GRID);
        }
        if (flipHead && !H.vertical) ty = snap(2 * H.contact[1] - ty, GRID);
      }
      const o: RouteAvoid = avoid ? { spread, mix, avoid: (pts) => clashes(id, pts) } : { spread };
      const coreTo = (ty: number) => w.bends && w.bends.xs.length > 0
        ? simplify(pointsOfShape({ sx, sy, tx, ty }, w.bends))
        : searched
          ? routeBlocks([sx, sy], [tx, ty], boxById.get(T.box)!, boxById.get(H.box)!, boxes, avoid ? othersOf(id) : new Tracks())
          : T.box !== '' && H.box !== ''
            ? route(sx, sy, tx, ty, T.box, H.box, nudge.get(id) ?? 0, boxes, o)
            : clearPath(route(sx, sy, tx, ty, T.box, H.box, 0, boxes, o), boxes);
      let core = coreTo(ty);
      // an automatic wire reaches a level junction from the side its last run comes from, as the shape it becomes when a
      // run is first dragged does (above): that drag never moves it (plan 10 phase 3)
      if (!b && H.contact && !H.vertical && !flipHead && at.ty === undefined) {
        const ys = shapeFromPoints(core).ys;
        const from = ys.length > 0 ? ys[ys.length - 1]! : sy;
        const side = snap(from > H.contact[1] ? H.contact[1] + JOG : H.contact[1] - JOG, GRID);
        if (side !== ty) {
          const again = coreTo(side);
          if (hitsOf(again, T.box, H.box, boxes) <= hitsOf(core, T.box, H.box, boxes)) { ty = side; core = again; }
        }
      }
      const ends: Ends = { sx, sy, tx, ty };
      return { ends, core, points: lead.length === 0 && leadIn.length === 0 ? core : simplify([...lead, ...core, ...leadIn]) };
    };
    let drawn = drawWith(false, false, 0);
    // the router's priorities (the coordinator's ruling, 2026-10-09): never through a block (its own included), then off
    // every other net's wire: the usual track, else the nearest one free of both (its elbows and U levels a grid step at
    // a time), a junction on a level run perhaps left or reached from its line's other side, and last its own start and
    // landing heights. A shape drawn by hand keeps its runs and its junction sides (above): nothing to search.
    const shaped = (w.bends?.xs.length ?? 0) > 0;
    const blocksOf = (d: { core: Pt[] }) => hitsOf(d.core, T.box, H.box, boxes);
    const scoreOf = (d: { core: Pt[]; points: Pt[] }) => [blocksOf(d), clashes(id, d.points)] as const;
    let best = scoreOf(drawn);
    // the blocks the usual track crosses anyway (avoiding nothing): no search for fewer (most wires cross none)
    const fewest = best[0] === 0 ? 0 : blocksOf(drawWith(false, false, 0, false));
    const finished = () => best[1] === 0 && best[0] <= fewest;
    const tryOne = (d: { ends: Ends; core: Pt[]; points: Pt[] }) => {
      const s = scoreOf(d);
      if (s[0] < best[0] || (s[0] === best[0] && s[1] < best[1])) { drawn = d; best = s; }
      return finished();
    };
    const flips: [boolean, boolean][] = [[false, false]];
    if (!shaped && T.contact && !T.vertical) flips.push([true, false]);
    if (!shaped && H.contact && !H.vertical) flips.push(...flips.map(([a]) => [a, true] as [boolean, boolean]));
    // a wire lying on its very start or landing (one grid step from either end) gets no free track from its elbows: on
    // to its heights at once
    const { sx: x0, sy: y0, tx: x1, ty: y1 } = drawn.ends;
    const stub = best[1] > 0 && !T.contact && !H.contact
      && (clashes(id, [[x0, y0], [x0 + GRID, y0]]) > 0 || clashes(id, [[x1 - GRID, y1], [x1, y1]]) > 0);
    // the usual tracks spread first; only then every mix of a U's parts moved and not (a wider, dearer search)
    search: for (const mix of [false, true]) {
      for (let k = mix ? 1 : 0; !finished() && !stub && k <= (shaped || searched ? 0 : SPREADS); k++) {
        for (const [ft, fh] of flips) {
          for (const spread of k === 0 ? [0] : [k * GRID, -k * GRID]) {
            if (k === 0 && !ft && !fh) continue;
            if (tryOne(drawWith(ft, fh, spread, true, {}, mix))) break search;
          }
        }
      }
    }
    if (!finished() && !shaped) {
      // its own heights, where the router chose them: a tail along its step's output, a head along its step's input
      const tailStep = w.tail.on === 'step' && w.tail.y === null && T.contact === null ? stepAt(w.tail.step) : undefined;
      const headStep = w.head.on === 'step' && w.head.y === null && H.contact === null ? stepAt(w.head.step) : undefined;
      heights: for (let k = 1; k <= HEIGHTS; k++) {
        for (const dy of [k * GRID, -k * GRID]) {
          if (tailStep) {
            const sy = tailStep.y + clampLanding(T.at.y + dy - tailStep.y);
            if (sy !== T.at.y && tryOne(drawWith(false, false, 0, true, { sy }))) break heights;
          }
          if (headStep) {
            const ty = headStep.y + clampLanding(H.at.y + dy - headStep.y);
            if (ty !== H.at.y && tryOne(drawWith(false, false, 0, true, { ty }))) break heights;
          }
          if (tailStep && headStep) {
            // both together: a straight wire stays straight, one track over
            const sy = tailStep.y + clampLanding(T.at.y + dy - tailStep.y), ty = headStep.y + clampLanding(H.at.y + dy - headStep.y);
            if (tryOne(drawWith(false, false, 0, true, { sy, ty }))) break heights;
          }
        }
      }
    }
    const { ends, core, points } = drawn;
    taken.add(id, points);

    const fam = families.get(id) ?? [];
    const short = fam.length > 1;
    const condition = short ? headFamily(id) ?? fam[0]! : fam[0] ?? null;
    const tailOn: EndKind = tail === null ? 'open' : kindOf(w.tail);
    const headOn: EndKind = head === null ? 'open' : kindOf(w.head);
    const source = tailOn !== 'terminal' ? null : w.tail.on === 'hub' ? WORKFLOW_SOURCE : w.tail.on === 'step' ? w.tail.step : null;
    const r: WireRoute = {
      id, source, target: headOn === 'terminal' && w.head.on === 'step' ? w.head.step : null,
      points, core: { ends, points: core }, condition, solid: tailOn !== 'open' && headOn !== 'open' && condition !== null,
      tailOn, headOn, short, free: isFree(w),
    };
    busy.delete(id);
    out.set(id, r);
    return r;
  };
  // the shapes drawn by hand first: those on no other wire (so all of them are recorded before an automatic host is
  // drawn, review 2026-10-09), then those joined on a wire (and the hosts they need), then the automatic wires, each in
  // id order: an automatic wire takes its track around what is already drawn (rule 2)
  const shapedByHand = (id: string) => (wire(id).bends?.xs.length ?? 0) > 0;
  const joined = (id: string) => wire(id).tail.on === 'wire' || wire(id).head.on === 'wire';
  for (const id of ids) if (shapedByHand(id) && !joined(id)) routeOne(id);
  for (const id of ids) if (shapedByHand(id)) routeOne(id);
  for (const id of ids) routeOne(id);

  // two automatic wires of different nets still on each other (the one drawn later found no free track): each is drawn
  // again against everything else, and keeps its new track only when that lies on fewer wires (review 2026-10-09).
  // A host is left as it is (what is joined on it follows its line).
  const hosts = new Set(ids.flatMap((id) => [wire(id).tail, wire(id).head].flatMap((e) => (e.on === 'wire' ? [e.host] : []))));
  const movable = (id: string) => isAutomatic(wire(id)) && !hosts.has(id);
  const others = (skip: string) => { taken = new LineIndex(); for (const id of ids) if (id !== skip) taken.add(id, out.get(id)!.points); };
  // a wire's standing against everything else drawn (`taken` without it): blocks crossed, short circuits it is in under
  // the rules, overlaps the rules allow (with other automatic wires), length
  const standing = (id: string, r: WireRoute): RipUpScore => ({
    blocks: hitsOf(r.core.points, r.source === null ? '' : r.source === WORKFLOW_SOURCE ? SPHERE_BOX_ID : stepBoxId(r.source), r.target === null ? '' : stepBoxId(r.target), boxes),
    shorts: taken.count(r.points, (x) => !share(id, x)),
    others: taken.count(r.points, (x) => share(id, x) && !sameNet(id, x)),
    length: lengthOf([r.points]),
  });
  for (let round = 0; round < RIPUPS; round++) {
    const stuck = overlapsOf(ids.map((id) => out.get(id)!)).filter((o) => !sameNet(o.a, o.b) && movable(o.a) && movable(o.b));
    if (stuck.length === 0) break;
    let moved = false;
    for (const id of [...new Set(stuck.flatMap((o) => [o.a, o.b]))].sort()) {
      const was = out.get(id)!;
      others(id);
      const before = standing(id, was);
      if (before.shorts === 0 && before.others === 0) continue;
      out.delete(id);
      const again = routeOne(id)!;
      others(id);
      if (ripUpBetter(standing(id, again), before)) moved = true;
      else out.set(id, was);
    }
    if (!moved) break;
  }
  const routes = Object.keys(circuit).map((id) => out.get(id)!);

  // wires sharing a stretch of line across nets (rule 2): both nets short-circuited, the stretches drawn red
  const lines = overlapsOf(ids.map((id) => out.get(id)!)).filter((o) => !share(o.a, o.b));
  if (lines.length === 0) return routes;
  const shorted = shortedWires(nets, lines.flatMap((o) => [o.a, o.b]));
  for (const o of lines) {
    for (const [me, other] of [[o.a, o.b], [o.b, o.a]] as const) {
      const r = out.get(me)!;
      (r.overlaps ??= []).push(...o.stretches);
      (r.shortWith ??= []).push(other);
    }
  }
  for (const r of routes) if (shorted.has(r.id)) r.short = true;
  return routes;
}

/** How many grid steps either way an automatic wire is moved at most to find a track no other net's wire lies on. */
const SPREADS = 6;
/** How many grid steps up or down along its side an automatic end is moved at most, when no track is free. */
const HEIGHTS = 4;
/** How many times automatic wires still on each other are drawn again, at most. */
const RIPUPS = 3;

/** A wire's standing when it is drawn again (rip-up): see `ripUpBetter`. */
export interface RipUpScore { blocks: number; shorts: number; others: number; length: number }

/**
 * A wire drawn again keeps its new track only when it is strictly better in the router's order (final check 2026-10-09):
 * fewer blocks crossed, then fewer short circuits under the rules (never trading overlaps with automatic wires for one
 * with a wire shaped by hand), then fewer overlaps with other nets' automatic wires, then shorter.
 */
export function ripUpBetter(next: RipUpScore, was: RipUpScore): boolean {
  for (const k of ['blocks', 'shorts', 'others', 'length'] as const) {
    if (next[k] !== was[k]) return next[k] < was[k];
  }
  return false;
}

/** Where each drawn wire's ends are (its first point the tail, its last the head): to open an end where it is drawn. */
export function endPointOf(routes: readonly WireRoute[]): (id: string, side: Side) => Point | null {
  const drawn = new Map(routes.map((r) => [r.id, r.points]));
  return (id, side) => {
    const pts = drawn.get(id);
    const p = pts ? pts[side === 'tail' ? 0 : pts.length - 1] : undefined;
    return p ? { x: p[0], y: p[1] } : null;
  };
}

/**
 * The workflow's own wiring, routed (plan 2 §5.2): an automatic wire per entry step and next step whose two ends are
 * on the canvas.
 */
export function routeWires(input: WiringInput, placement: Placement): WireRoute[] {
  const c = plainCircuit(input.entryStepIds, input.steps, (id) => placement.steps.has(id));
  return routeCircuit(c, { placement, steps: input.steps });
}
