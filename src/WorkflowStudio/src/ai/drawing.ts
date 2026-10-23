import type { StudioDocument } from '../app/document';
import { setBends, setEnd, type Circuit, type End, type Side } from '../circuit/circuit';
import { netsOf } from '../circuit/families';
import { applyDraft } from '../design/apply';
import { circuitOf, moveBlocks, withCircuit, type Draft } from '../design/draft';
import { nodeBox } from '../design/hit';
import { writtenLists } from '../design/shortCircuits';
import { CACHE_NODE_PREFIX, SPHERE_NODE_ID } from '../layout/nodeIds';
import { clampLanding, GRID, PMID, snap, STEP_H, STEP_W, TRACK } from '../layout/geometry';
import { JOG } from '../layout/shape';
import { blockBoxes } from '../layout/wires';
import type { Pt } from '../layout/router';
import { CONDITIONS } from '../model/entryConditions';

/** How far above or below its centre a tail may leave the workflow circle's right side. */
const HUB_REACH = 64;

/**
 * AI drawing (the user's design, 2026-10-11): the model (Kimi K3, behind the studio's own nginx route `/ai/`) gets the
 * drawing rules and the design graph and answers with a new drawing; the studio applies it to a candidate draft and
 * keeps it only when the relations between the steps are exactly what they were. The model only draws: it cannot add,
 * remove or reconnect a wire to another step.
 */

/** The drawing rules, highest priority first (the user's list, 2026-10-11; symmetry and equal gaps after rule 4, 2026-10-12). */
export const DRAWING_RULES = `Drawing rules for SKP Studio, highest priority first. When two rules conflict, the higher one wins.

Correctness (never broken)
1. The drawing must mean the workflow. Every step's next steps, entry steps and caches stay exactly as they are. You only move blocks and reshape wires; never move a wire's end onto another step.
2. No short circuits: a wire never lies on top of (shares a stretch of line with) a wire of another net. Wires of different families are never joined at a junction.
3. Nothing runs through a block.

Crossings
4. Don't cross: a wire crosses no other wire of any colour (a crossing can be misread as a junction).

Symmetry
5. Equal gaps: every column is the same distance from the next, and every row the same distance from the next. Blocks in one column share one x; blocks in one row share one y.
6. Vertical symmetry: parallel branches sit symmetrically above and below their source's row: 2 branches at -1 and +1 row, 3 at -1, 0 and +1. Parallel branches are next steps of one step in the same family (same colour) that do not lead into each other. This rule never moves a main-path step: the main path stays on its row (rule 16), a Failed branch goes below (rule 17), and a skip is not a branch (rule 18).
7. Horizontal symmetry: parallel branches that split from one step and join again into one step mirror each other about the middle column between the split and the join.

Readability
8. Straight lines: a wire keeps the height it leaves at and runs straight to its target. Straight comes before centred; no small jogs just to reach a centre.
9. Centre inputs with equal gaps: a step's inputs are centred on its middle (step y + 96), 16 px apart, ordered top to bottom by where they come from: 1 input at the centre, 2 at +-8, 3 at -16, 0, +16.
10. Symmetric hub contact points: with more than one entry step, each entry step gets its own wire from the workflow circle (never one fan-out trunk from the circle), and their contact points are symmetric about the circle's centre (centreY), 16 px apart and ordered top to bottom like the entry steps: 2 at +-8, 3 at -16, 0, +16. Place the entry steps so each of these wires runs straight into its input.
11. Outputs are placed by the forward inputs: each output takes the height of the input it feeds, so it is straight and centred at once. Outputs that feed no step input (e.g. drops onto a trunk) take the next slots below, 16 px apart.
12. Fan-in and fan-out through one trunk: several wires of the same family into one step become one trunk with each wire joining it at a junction; the same for one step feeding several steps. To merge, keep one wire as the trunk and turn the other wires' ends on that step into junctions on it (head for a fan-in, tail for a fan-out).
13. Clean T junctions: a joining wire runs straight into the trunk at a right angle, with no hook before the junction.
14. No staircases: no wire segment shorter than 16 px; arrowheads stay clean.

Layout
15. Left to right by depth: the workflow circle on the far left, steps in columns in order of execution, aligned on the 8 px grid.
16. The main path (the Completed chain) is one straight row.
17. Failure handling sits below the row: the Failed trunk under the row, the steps it feeds at its end.
18. Skips go over the row: a wire that jumps past steps arcs above the row, clear of the drops below. Give it a "lane" above the row and put its ends on the top slots of both steps (above the row's own wires there), or it crosses them.
19. Place blocks so the rules agree (e.g. a step's height so a trunk enters it straight at its centre).
20. Caches sit under the workflow circle, out of the wiring's way.

Finish
21. Zero crossings, every main-path step on the one row, every step on a column with equal gaps, balanced parallel branches, no bent main-path wire, no segment shorter than 16 px, no short circuit.`;

/** The answer's shape, as the model is told it. */
export const ANSWER_SCHEMA = `Answer with ONE JSON object and nothing else:
{
  "blocks": { "<block id>": { "x": <number>, "y": <number> } },
  "wires": {
    "<wire id>": {
      "tail": { "y": <number> } | { "auto": true } | { "junction": { "host": "<wire id>", "x": <number>, "y": <number> } },
      "head": (same as tail),
      "lane": <number>
    }
  }
}
- blocks: the new top-left corner of any block you move (ids as given: "wf", step ids, "cache:<id>"); multiples of 8.
- An end on a step: "y" is the flow y where it meets the step's side (within the side's landing range); "auto" lets the router choose. It stays on the same step.
- A tail on the workflow circle: "y" is the flow y where it leaves the circle's right side (within its "tailsRange"); "auto" spaces the circle's tails symmetrically about its centre, 16 px apart.
- An end on a wire (a junction): "junction" names the host wire and the point where it should join; the studio puts it at the nearest point of the host's line.
- Merging into a trunk: an end on a step may become a junction on another wire of the same family that ends on the same step (a head, fan-in) or starts on the same step (a tail, fan-out). Never join wires of different families or different steps; a wire on the workflow circle stays separate.
- lane (optional): for a wire that cannot run straight (a skip past steps, a loop back), the flow y of its middle run; the studio draws it out of the tail, along the lane, and into the head. Use it to send skips over the row (rule 18), clear of every block. Only for a wire whose ends are on steps or the workflow circle.
- You do not draw the wires' routes: the studio's router draws every wire from its ends, square and around blocks. Choose block positions, end heights and junction points so the routes come out straight and uncrossed. Omit a key to leave it as it is.
- Leave out blocks and wires you do not change. Never invent ids.`;

const conditionName = (n: number | undefined) => CONDITIONS.find((c) => c.value === n)?.name ?? 'undecided';

/** The canvas as the model reads it: every block's box and every wire's ends, route and family. */
export function graphOf(edited: StudioDocument, draft: Draft): object {
  const shown = applyDraft(edited, draft);
  const circuit = circuitOf(edited, draft);
  const blocks: object[] = [];
  const hub = nodeBox(shown, SPHERE_NODE_ID)!;
  blocks.push({ id: SPHERE_NODE_ID, kind: 'workflow', ...hub, tailsLeave: { x: hub.x + hub.w, centreY: hub.y + hub.h / 2 }, tailsRange: [hub.y + hub.h / 2 - HUB_REACH, hub.y + hub.h / 2 + HUB_REACH] });
  for (const [id, p] of shown.placement.steps) {
    const s = shown.graph.steps.get(id);
    blocks.push({
      id, kind: 'step', name: s?.name ?? id, entryCondition: conditionName(s?.entryCondition), x: p.x, y: p.y, w: STEP_W, h: STEP_H,
      inputX: p.x, outputX: p.x + STEP_W, centreY: p.y + PMID, landingRange: [p.y + 16, p.y + STEP_H - 16],
    });
  }
  for (const [id, p] of shown.placement.caches) blocks.push({ id: `${CACHE_NODE_PREFIX}${id}`, kind: 'cache', ...nodeBox(shown, `${CACHE_NODE_PREFIX}${id}`)!, x: p.x, y: p.y });
  const endOf = (e: End, at: Pt | undefined, side: Side) => {
    switch (e.on) {
      case 'step': return { on: 'step', step: e.step, side: side === 'tail' ? 'output' : 'input', y: at?.[1], held: e.y !== null };
      case 'hub': return { on: 'workflow', y: at?.[1], held: e.angle !== null || e.dy !== undefined };
      case 'wire': return { on: 'junction', host: e.host, x: at?.[0], y: at?.[1] };
      case 'open': return { on: 'open', x: e.x, y: e.y };
    }
  };
  const wires = shown.wires.map((w) => {
    const c = circuit[w.id]!;
    return {
      id: w.id, family: conditionName(w.condition ?? undefined), tail: endOf(c.tail, w.points[0], 'tail'), head: endOf(c.head, w.points.at(-1), 'head'),
      points: w.points,
    };
  });
  return { grid: GRID, portGap: TRACK, blocks, wires };
}

/** The system and user messages for one drawing. */
export function promptOf(edited: StudioDocument, draft: Draft): { system: string; user: string } {
  return {
    system: `You redraw workflow graphs in SKP Studio. Coordinates are flow pixels, y grows downward.\n\n${DRAWING_RULES}\n\n${ANSWER_SCHEMA}`,
    user: `Redraw this workflow by the rules. The graph:\n${JSON.stringify(graphOf(edited, draft))}`,
  };
}

/**
 * The relations the drawing means (what Save writes and the nets): every step's next steps, the entry steps, the caches,
 * and which wires form which net with which families. Canonical JSON, so two drawings compare by string.
 */
export function relationsOf(edited: StudioDocument, draft: Draft): string {
  const shown = applyDraft(edited, draft);
  const lists = writtenLists(edited, shown, draft);
  const steps = [...shown.graph.steps.keys()].sort();
  const next = Object.fromEntries(steps.map((id) => [id, [...lists.nextOf(id)].sort()]));
  const nets = netsOf(circuitOf(edited, draft), (id) => shown.graph.steps.get(id)?.entryCondition)
    .map((n) => ({ wires: [...n.wires].sort(), families: [...n.families].sort() }))
    .sort((a, b) => (a.wires[0]! < b.wires[0]! ? -1 : 1));
  return JSON.stringify({ next, entries: [...lists.entries].sort(), caches: [...(shown.graph.workflow.cacheIds ?? [])].sort(), nets });
}

/** One end as the answer gives it. */
export type EndPlan = { y: number } | { auto: true } | { junction: { host: string; x: number; y: number } };
/** A drawing as the answer gives it, checked: known ids, finite numbers, well-formed bends. */
export interface DrawingPlan {
  blocks: Map<string, { x: number; y: number }>;
  wires: Map<string, { tail?: EndPlan; head?: EndPlan; lane?: number }>;
}

export class DrawingError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, what: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e6) throw new DrawingError(`${what} is not a number`);
  return v;
};

/** The model's text parsed and checked against the canvas; any doubt refuses the whole answer. */
export function parsePlan(text: string, edited: StudioDocument, draft: Draft): DrawingPlan {
  let v: unknown;
  // a model may wrap JSON in a code fence: take the outermost object
  const body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { v = JSON.parse(body); } catch { throw new DrawingError('the answer is not JSON'); }
  if (!isObj(v)) throw new DrawingError('the answer is not a JSON object');
  const shown = applyDraft(edited, draft);
  const circuit = circuitOf(edited, draft);
  const plan: DrawingPlan = { blocks: new Map(), wires: new Map() };
  if (v.blocks !== undefined) {
    if (!isObj(v.blocks)) throw new DrawingError('"blocks" is not an object');
    for (const [id, p] of Object.entries(v.blocks)) {
      if (!nodeBox(shown, id)) throw new DrawingError(`unknown block "${id.slice(0, 60)}"`);
      if (!isObj(p)) throw new DrawingError(`block ${id} is not {x, y}`);
      plan.blocks.set(id, { x: snap(num(p.x, `block ${id} x`)), y: snap(num(p.y, `block ${id} y`)) });
    }
  }
  if (v.wires !== undefined) {
    if (!isObj(v.wires)) throw new DrawingError('"wires" is not an object');
    for (const [id, w] of Object.entries(v.wires)) {
      const c = circuit[id];
      if (!Object.hasOwn(circuit, id) || !c) throw new DrawingError(`unknown wire "${id.slice(0, 60)}"`);
      if (!isObj(w)) throw new DrawingError(`wire ${id} is not an object`);
      const entry: { tail?: EndPlan; head?: EndPlan; lane?: number } = {};
      for (const side of ['tail', 'head'] as const) {
        const e = w[side];
        if (e === undefined) continue;
        if (!isObj(e)) throw new DrawingError(`wire ${id} ${side} is not an object`);
        const now = c[side];
        if ('junction' in e) {
          // an end on a wire moves along; an end on a step may join a wire of its own kind (a fan-in or fan-out trunk, 2026-10-11)
          if (now.on !== 'wire' && now.on !== 'step') throw new DrawingError(`wire ${id} ${side} is not on a wire or a step: it cannot become a junction`);
          const j = e.junction;
          if (!isObj(j) || typeof j.host !== 'string' || !Object.hasOwn(circuit, j.host) || j.host === id) throw new DrawingError(`wire ${id} ${side}: unknown host`);
          entry[side] = { junction: { host: j.host, x: num(j.x, `wire ${id} ${side} x`), y: num(j.y, `wire ${id} ${side} y`) } };
        } else if (now.on !== 'step' && !(now.on === 'hub' && side === 'tail')) {
          throw new DrawingError(`wire ${id} ${side} is not on a step or the workflow circle: only its junction may move`);
        } else if (e.auto === true) {
          entry[side] = { auto: true };
        } else {
          entry[side] = { y: snap(num(e.y, `wire ${id} ${side} y`)) };
        }
      }
      // no routes from the model (2026-10-11): the router draws every wire, so a stray "bends" is ignored
      // a lane (2026-10-11): the height of the wire's middle run, for a wire that cannot run straight (a skip, a loop back)
      if (w.lane !== undefined && w.lane !== null) entry.lane = snap(num(w.lane, `wire ${id} lane`));
      plan.wires.set(id, entry);
    }
  }
  return plan;
}

/**
 * The plan drawn over the draft: blocks moved, every wire's route given back to the router (the model only places,
 * 2026-10-11), ends slid, then each junction put at the nearest point of its host as drawn.
 */
export function applyPlan(edited: StudioDocument, draft: Draft, plan: DrawingPlan): Draft {
  let d = moveBlocks(draft, edited, plan.blocks);
  const placed = applyDraft(edited, d);
  let c: Circuit = circuitOf(edited, d);
  for (const id of Object.keys(c)) if (c[id]!.bends) c = setBends(c, id, null);
  const junctions: { id: string; side: Side; host: string; at: Pt }[] = [];
  for (const [id, w] of plan.wires) {
    for (const side of ['tail', 'head'] as const) {
      const e = w[side];
      const now = c[id]![side];
      if (!e) continue;
      if ('junction' in e) junctions.push({ id, side, host: e.junction.host, at: [e.junction.x, e.junction.y] });
      else if (now.on === 'step') {
        const top = placed.placement.steps.get(now.step)?.y;
        if (top === undefined) throw new DrawingError(`wire ${id} ${side}: its step is not on the canvas`);
        c = setEnd(c, id, side, { on: 'step', step: now.step, y: 'auto' in e ? null : clampLanding(e.y - top) });
      } else if (now.on === 'hub') {
        // a hub tail (the user's rule, 2026-10-11): leaves the circle's right side at that height; auto spaces the tails symmetrically
        const dy = 'auto' in e ? undefined : Math.max(-HUB_REACH, Math.min(HUB_REACH, e.y - placed.placement.sphere.cy));
        c = setEnd(c, id, side, dy === undefined ? { on: 'hub', angle: null } : { on: 'hub', angle: null, dy });
      }
    }
  }
  d = withCircuit(d, edited, c);
  // lanes, before junctions so a trunk on a lane is drawn there first: out of the tail, along the lane, into the head
  const laned = [...plan.wires].filter(([, w]) => w.lane !== undefined);
  if (laned.length > 0) {
    const drawn = applyDraft(edited, d);
    for (const [id, w] of laned) {
      const cw = c[id]!;
      if (cw.tail.on === 'wire' || cw.head.on === 'wire' || cw.tail.on === 'open' || cw.head.on === 'open' || junctions.some((j) => j.id === id)) {
        throw new DrawingError(`wire ${id}: a lane is only for a wire from a step or the workflow circle to a step`);
      }
      const pts = drawn.wires.find((x) => x.id === id)?.points;
      if (!pts || pts.length < 2) throw new DrawingError(`wire ${id} is not drawn`);
      c = setBends(c, id, { xs: [snap(pts[0]![0] + JOG), snap(pts.at(-1)![0] - JOG)], ys: [w.lane!] });
    }
    d = withCircuit(d, edited, c);
    const after = applyDraft(edited, d);
    const boxes = blockBoxes(after.placement);
    for (const [id] of laned) {
      const pts = after.wires.find((x) => x.id === id)!.points;
      const hit = boxes.find((b) => runsThrough(pts, b));
      if (hit) throw new DrawingError(`wire ${id}: its lane at y ${plan.wires.get(id)!.lane} runs through a block (${hit.id})`);
    }
  }
  // host first: a wire that joins a trunk which itself joins another is placed once the trunk is drawn where it goes
  const pending = [...junctions];
  while (pending.length > 0) {
    const k = pending.findIndex((j) => !pending.some((o) => o.id === j.host));
    if (k < 0) throw new DrawingError(`the junctions of wires ${pending.map((j) => j.id).join(', ')} host each other`);
    const j = pending.splice(k, 1)[0]!;
    const host = applyDraft(edited, d).wires.find((w) => w.id === j.host);
    const at = host ? nearestAlong(host.points, j.at) : null;
    if (at === null) throw new DrawingError(`wire ${j.id} ${j.side}: wire ${j.host} is not drawn`);
    c = setEnd(c, j.id, j.side, { on: 'wire', host: j.host, at });
    d = withCircuit(d, edited, c);
  }
  return cleanTees(edited, d, new Set([...plan.wires].filter(([, w]) => w.lane !== undefined).map(([id]) => id)));
}

/**
 * Clean T junctions (rule 13, 2026-10-11): a wire joining a level run of its trunk from a step meets it square, its
 * vertical run right at the junction (the router alone puts it midway, leaving a hook). Every such wire without a lane,
 * hosts first; kept only when the drawn wire really ends (or starts) square on the junction, else left to the router.
 */
export function cleanTees(edited: StudioDocument, draft: Draft, laned: ReadonlySet<string> = new Set()): Draft {
  let d = draft;
  let c: Circuit = circuitOf(edited, d);
  const joining = Object.entries(c)
    .filter(([id, w]) => !laned.has(id) && !w.bends && ((w.head.on === 'wire' && w.tail.on === 'step') || (w.tail.on === 'wire' && w.head.on === 'step')))
    .map(([id]) => id);
  const hostOf = (id: string) => { const w = c[id]!; return w.head.on === 'wire' ? w.head.host : w.tail.on === 'wire' ? w.tail.host : ''; };
  const pending = [...joining];
  while (pending.length > 0) {
    const k = Math.max(0, pending.findIndex((id) => !pending.includes(hostOf(id))));
    const id = pending.splice(k, 1)[0]!;
    const atHead = c[id]!.head.on === 'wire';
    const drawn = applyDraft(edited, d).wires.find((w) => w.id === id)?.points;
    if (!drawn || drawn.length < 2) continue;
    const j = atHead ? drawn.at(-1)! : drawn[0]!;
    const step = atHead ? drawn[0]! : drawn.at(-1)!;
    // only from a step that lies before (fan-in) or after (fan-out) the junction by more than a jog, off the trunk's level
    if (j[1] === step[1] || (atHead ? j[0] - step[0] : step[0] - j[0]) < JOG) continue;
    const tried = setBends(c, id, { xs: [j[0]], ys: [] });
    const nd = withCircuit(d, edited, tried);
    const pts = applyDraft(edited, nd).wires.find((w) => w.id === id)?.points;
    const end = pts && (atHead ? [pts.at(-2)!, pts.at(-1)!] : [pts[0]!, pts[1]!]);
    const square = !!end && end[0]![0] === j[0] && end[1]![0] === j[0] && (atHead ? pts!.at(-1)! : pts![0]!)[1] === j[1];
    if (square) { c = tried; d = nd; }
  }
  return d;
}

/** A drawn line passing through a block's inside (its own ends touch the sides, which is not through). */
function runsThrough(points: readonly Pt[], b: { x: number; y: number; w: number; h: number }): boolean {
  const inside = (v: number, lo: number, hi: number) => v > lo + 0.5 && v < hi - 0.5;
  for (let i = 0; i + 1 < points.length; i++) {
    const [p, q] = [points[i]!, points[i + 1]!];
    if (p[1] === q[1] && inside(p[1], b.y, b.y + b.h) && Math.max(p[0], q[0]) > b.x + 0.5 && Math.min(p[0], q[0]) < b.x + b.w - 0.5) return true;
    if (p[0] === q[0] && inside(p[0], b.x, b.x + b.w) && Math.max(p[1], q[1]) > b.y + 0.5 && Math.min(p[1], q[1]) < b.y + b.h - 0.5) return true;
  }
  return false;
}

/** How far along a drawn line its point nearest to `p` lies; null for a line with no segment. */
export function nearestAlong(points: readonly Pt[], p: Pt): number | null {
  let best: { gap: number; at: number } | null = null, d = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const [a, b] = [points[i]!, points[i + 1]!];
    const len = Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / (len * len)));
    const q: Pt = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    const gap = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (!best || gap < best.gap) best = { gap, at: d + t * len };
    d += len;
  }
  return best && Math.round(best.at);
}

/** Every crossing between two drawn wires: perpendicular runs meeting strictly inside both. */
export function crossingsOf(wires: readonly { id: string; points: readonly Pt[] }[]): number {
  return crossingPairsOf(wires).reduce((n, c) => n + c.times, 0);
}

/** The pairs of drawn wires that cross, and how often each pair does (2026-10-12: named in the refinement round). */
export function crossingPairsOf(wires: readonly { id: string; points: readonly Pt[] }[]): { a: string; b: string; times: number }[] {
  const out: { a: string; b: string; times: number }[] = [];
  const inside = (v: number, a: number, b: number) => v > Math.min(a, b) && v < Math.max(a, b);
  for (let i = 0; i < wires.length; i++) for (let j = i + 1; j < wires.length; j++) {
    const A = wires[i]!.points, B = wires[j]!.points;
    let n = 0;
    for (let a = 0; a + 1 < A.length; a++) for (let b = 0; b + 1 < B.length; b++) {
      const [p, q, r, s] = [A[a]!, A[a + 1]!, B[b]!, B[b + 1]!];
      const ah = p[1] === q[1], bh = r[1] === s[1];
      if (ah === bh) continue;
      const [h0, h1, v0, v1] = ah ? [p, q, r, s] : [r, s, p, q];
      if (inside(v0[0], h0[0], h1[0]) && inside(h0[1], v0[1], v1[1])) n++;
    }
    if (n > 0) out.push({ a: wires[i]!.id, b: wires[j]!.id, times: n });
  }
  return out;
}

/** How many wires are in a short circuit (a junction across families, or a stretch shared with another net). */
export const shortedOf = (doc: StudioDocument): number => doc.wires.filter((w) => w.short || (w.shortWith?.length ?? 0) > 0).length;

const COMPLETED = 1;

/**
 * The main path (rule 16, 2026-10-12): from an entry step, the longest chain of Completed links. It ends at a step whose
 * Completed next steps split into parallel branches (two that do not lead into each other); a skip (one leading into the
 * other) does not end it. Of several entry steps, the one with the longest chain.
 */
export function mainPathOf(doc: StudioDocument, nextOf: (id: string) => string[], entries: readonly string[]): string[] {
  const completed = (id: string) => nextOf(id).filter((n) => doc.graph.steps.get(n)?.entryCondition === COMPLETED);
  const reach = new Map<string, Set<string>>();
  const reachOf = (id: string, seen = new Set<string>()): Set<string> => {
    const known = reach.get(id);
    if (known) return known;
    const out = new Set<string>();
    seen.add(id);
    for (const n of completed(id)) {
      if (seen.has(n)) continue;
      out.add(n);
      for (const m of reachOf(n, seen)) out.add(m);
    }
    seen.delete(id);
    reach.set(id, out);
    return out;
  };
  const longest = new Map<string, string[]>();
  const chainOf = (id: string, seen = new Set<string>()): string[] => {
    const known = longest.get(id);
    if (known) return known;
    const nexts = completed(id).filter((n) => !seen.has(n));
    const parallel = nexts.some((a) => nexts.some((b) => a !== b && !reachOf(a).has(b) && !reachOf(b).has(a)));
    seen.add(id);
    let best: string[] = [];
    if (!parallel) for (const n of nexts) { const c = chainOf(n, seen); if (c.length > best.length) best = c; }
    seen.delete(id);
    const chain = [id, ...best];
    longest.set(id, chain);
    return chain;
  };
  let path: string[] = [];
  for (const e of entries) { const c = chainOf(e); if (c.length > path.length) path = c; }
  return path;
}

/** The value most of `xs` share; on a tie, the first of them. */
const commonest = (xs: readonly number[]): number => {
  const n = new Map<number, number>();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  return xs.reduce((best, x) => (n.get(x)! > n.get(best)! ? x : best), xs[0]!);
};

/**
 * Where a step the drawing moves may not land (the user, 2026-10-12), in words; null when nowhere. The row is the y most
 * main-path steps share, the columns the main path's commonest gap from its first step. A main-path step moved off the
 * row (rule 16), behind the step before it (rule 15), or any step moved off the columns (rule 5) refuses the drawing,
 * and the model's one correction round hears why. Steps it leaves where they are are not judged.
 */
export function layoutProblemOf(edited: StudioDocument, draft: Draft, moved: ReadonlySet<string>): string | null {
  return layoutIssuesOf(edited, draft, moved)[0] ?? null;
}

/** The layout issues of the steps in `moved`, or of every step ('all': the refinement round, 2026-10-12). */
function layoutIssuesOf(edited: StudioDocument, draft: Draft, moved: ReadonlySet<string> | 'all'): string[] {
  const shown = applyDraft(edited, draft);
  const lists = writtenLists(edited, shown, draft);
  const path = mainPathOf(shown, lists.nextOf, lists.entries);
  const at = (id: string) => shown.placement.steps.get(id);
  const name = (id: string) => `step "${shown.graph.steps.get(id)?.name ?? id}"`;
  const all = moved === 'all';
  const judged = (id: string) => moved === 'all' || moved.has(id);
  if (path.length < 2 || path.some((id) => !at(id))) return [];
  const out: string[] = [];
  const row = commonest(path.map((id) => at(id)!.y));
  const gaps = path.slice(1).map((id, i) => at(id)!.x - at(path[i]!)!.x).filter((g) => g > 0);
  const x0 = at(path[0]!)!.x, pitch = gaps.length ? commonest(gaps) : 0;
  for (const [i, id] of path.entries()) {
    if (!judged(id)) continue;
    const p = at(id)!;
    if (p.y !== row) out.push(`${name(id)} is on the main path, so it stays on the row: it ${all ? 'is at' : 'was moved to'} y ${p.y}, the row is at y ${row} (rule 16)`);
    if (i > 0 && p.x <= at(path[i - 1]!)!.x) out.push(`${name(id)} ${all ? 'is' : 'was moved'} left of ${name(path[i - 1]!)}, the step before it on the main path (rule 15)`);
  }
  if (pitch <= 0) return out;
  for (const [id, p] of shown.placement.steps) {
    if (judged(id) && (p.x - x0) % pitch !== 0) out.push(`${name(id)} ${all ? 'is' : 'was moved'} off the columns: x ${p.x}, the columns are at x ${x0} + k × ${pitch} (rule 5)`);
  }
  return out;
}

/** The shortest a wire's segment may be (rule 14). */
const MIN_SEGMENT = 16;

/**
 * What is still wrong with an applied drawing (the user, 2026-10-12), in words, for the refinement round: every step's
 * layout (rules 5, 15, 16), each pair of crossing wires (rule 4), each bent main-path wire (rules 8, 16) and each wire
 * with a segment shorter than 16 px (rule 14). Empty when the drawing keeps them all.
 */
export function remainingProblemsOf(edited: StudioDocument, draft: Draft): string[] {
  const shown = applyDraft(edited, draft);
  const out = layoutIssuesOf(edited, draft, 'all');
  for (const c of crossingPairsOf(shown.wires)) out.push(`wires ${c.a} and ${c.b} cross${c.times > 1 ? ` ${c.times} times` : ''} (rule 4)`);
  const lists = writtenLists(edited, shown, draft);
  const path = mainPathOf(shown, lists.nextOf, lists.entries);
  for (let i = 0; i + 1 < path.length; i++) {
    const w = shown.wires.find((x) => x.id === `${path[i]}->${path[i + 1]}`);
    if (w && w.points.some((p) => p[1] !== w.points[0]![1])) out.push(`the main-path wire ${w.id} is bent: it should run straight along the row (rules 8 and 16)`);
  }
  for (const w of shown.wires) {
    const lens = w.points.slice(1).map((p, i) => Math.abs(p[0] - w.points[i]![0]) + Math.abs(p[1] - w.points[i]![1]));
    const short = lens.find((len) => len > 0 && len < MIN_SEGMENT);
    if (short !== undefined) out.push(`wire ${w.id} has a segment of ${short} px, shorter than ${MIN_SEGMENT} px (rule 14)`);
  }
  return out;
}

/** How many blocks stand elsewhere in `b` than in `a`: the steps, the caches and the workflow circle. */
export function movedBlocksOf(edited: StudioDocument, a: Draft, b: Draft): number {
  const pa = applyDraft(edited, a).placement, pb = applyDraft(edited, b).placement;
  const differ = (m: ReadonlyMap<string, { x: number; y: number }>, n: ReadonlyMap<string, { x: number; y: number }>) =>
    [...m].filter(([id, p]) => { const q = n.get(id); return !q || q.x !== p.x || q.y !== p.y; }).length;
  return differ(pa.steps, pb.steps) + differ(pa.caches, pb.caches) + (JSON.stringify(pa.sphere) === JSON.stringify(pb.sphere) ? 0 : 1);
}

/** The outcome of one drawing: the candidate draft and what to tell the user. */
export type DrawingOutcome =
  | { ok: true; draft: Draft; moved: number; rerouted: number; crossings: number; shorted: number }
  | { ok: false; reason: string };

/**
 * The model's answer judged (step 5 of the user's flow): parsed and applied to a candidate; refused unless the relations
 * are exactly the snapshot's, no short circuit is added and no step is moved off the row or the columns. Never a partial
 * drawing. `draft` is what the answer was drawn against: the design, or the first drawing in the refinement round.
 */
export function judgeDrawing(edited: StudioDocument, draft: Draft, snapshot: string, text: string): DrawingOutcome {
  let candidate: Draft;
  let plan: DrawingPlan;
  try {
    plan = parsePlan(text, edited, draft);
    candidate = applyPlan(edited, draft, plan);
  } catch (e) {
    return { ok: false, reason: e instanceof DrawingError ? e.message : 'the answer could not be applied' };
  }
  const after = relationsOf(edited, candidate);
  const changed = changeOf(snapshot, after);
  if (changed !== null) return { ok: false, reason: `it would have changed the workflow: ${changed}` };
  const before = applyDraft(edited, draft), shown = applyDraft(edited, candidate);
  if (shortedOf(shown) > shortedOf(before)) return { ok: false, reason: 'it would have added a short circuit' };
  const layout = layoutProblemOf(edited, candidate, new Set(plan.blocks.keys()));
  if (layout !== null) return { ok: false, reason: layout };
  return { ok: true, draft: candidate, moved: plan.blocks.size, rerouted: shown.wires.length, crossings: crossingsOf(shown.wires), shorted: shortedOf(shown) };
}

/**
 * What a drawing changes in the workflow's meaning, in words; null when nothing. Every step's next steps, the entry steps
 * and the caches stay exactly; nets may only merge (a fan-in or fan-out trunk, 2026-10-11): each net before lies wholly
 * in one net after, of the very same family. So a net never splits, and never takes another kind of wire or an undecided one.
 */
export function changeOf(a: string, b: string): string | null {
  type Rel = { next: Record<string, string[]>; entries: string[]; caches: string[]; nets: { wires: string[]; families: number[] }[] };
  const A = JSON.parse(a) as Rel, B = JSON.parse(b) as Rel;
  for (const id of Object.keys(A.next)) if (JSON.stringify(A.next[id]) !== JSON.stringify(B.next[id])) return `${id.slice(0, 8)}… next steps ${JSON.stringify(A.next[id])} → ${JSON.stringify(B.next[id])}`;
  if (JSON.stringify(A.entries) !== JSON.stringify(B.entries)) return 'the entry steps';
  if (JSON.stringify(A.caches) !== JSON.stringify(B.caches)) return 'the caches';
  const netOf = new Map<string, number>();
  B.nets.forEach((n, i) => n.wires.forEach((w) => netOf.set(w, i)));
  for (const n of A.nets) {
    const into = new Set(n.wires.map((w) => netOf.get(w)));
    if (into.size !== 1) return `wire ${n.wires[0]} and the wires joined to it no longer form one net`;
    const after = B.nets[[...into][0]!]!;
    if (JSON.stringify(after.wires) === JSON.stringify(n.wires)) continue;
    // merged: only a net of one family, into a net of that same family
    if (n.families.length !== 1 || JSON.stringify(after.families) !== JSON.stringify(n.families)) return `wire ${n.wires[0]} would join a wire of another kind`;
  }
  return null;
}

/** How hard the model thinks (the analyst's convention: low | high | max). Low by default (2026-10-11): about 2 minutes a drawing, where high took about 5. */
export const AI_EFFORT = 'low';
/**
 * How long the model may stay silent, no byte of its stream arriving, before the round is given up (2026-10-12): a model
 * still thinking keeps streaming, so only a dead one is cut off.
 */
export const AI_SILENCE_MS = 60_000;
/** How long one press may take in all, every round together (2026-10-12). */
export const AI_TOTAL_MS = 15 * 60_000;

/** One message of the conversation with the model. */
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

/** The first round's messages: the rules and schema, then the graph. */
export const firstMessages = (prompt: { system: string; user: string }): ChatMessage[] =>
  [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }];

/**
 * The refinement round (the user, 2026-10-12): the model's applied drawing as the studio now draws it (its blocks and the
 * router's routes, which the model could not see while it answered) and what is still wrong with it, for one more answer
 * against that drawing. A second press of the wand did this by hand.
 */
export const refinementMessages = (before: readonly ChatMessage[], answer: string, graph: object, problems: readonly string[]): ChatMessage[] => [
  ...before,
  { role: 'assistant', content: answer },
  {
    role: 'user',
    content: `The studio applied your drawing. This is how it is drawn now, with the router's routes:\n${JSON.stringify(graph)}\n\n`
      + `These problems remain:\n${problems.map((p) => `- ${p}`).join('\n')}\n\n`
      + 'Fix them by the rules, changing as little else as you can. Answer with ONE JSON object in the same schema, against this drawing: leave out the blocks and wires you do not change.',
  },
];

/** The one correction round (2026-10-11): the refused answer and exactly why, and a request for the whole answer again. */
export const correctionMessages = (first: readonly ChatMessage[], answer: string, reason: string): ChatMessage[] => [
  ...first,
  { role: 'assistant', content: answer },
  { role: 'user', content: `The studio refused that answer: ${reason}. Answer again with the whole corrected JSON object, following the schema exactly.` },
];

/** How much of one answer has arrived (2026-10-12): the characters of the model's thinking and of its answer. */
export interface StreamProgress { thinking: number; writing: number }

export const NOT_CONFIGURED = 'AI drawing is not configured: the studio has no model (env KIMI_API_KEY, KIMI_BASE_URL, KIMI_MODEL_ID)';

/**
 * The model the studio draws with (2026-10-12): KIMI_MODEL_ID in the studio's environment (k8s/31-workflow-studio.yaml in
 * the cluster, the dev server's environment in dev), which /ai/config reports; the key and the base URL never leave nginx.
 */
export async function modelOf(signal: AbortSignal, fetchFn: typeof fetch = fetch): Promise<string> {
  let r: Response;
  try {
    r = await fetchFn('/ai/config', { signal });
  } catch (e) {
    if (signal.aborted) throw new DrawingError('cancelled');
    throw new DrawingError(`the studio's model settings could not be read (${e instanceof Error ? e.message : 'network error'})`);
  }
  const model: unknown = r.ok ? ((await r.json().catch(() => null)) as { model?: unknown } | null)?.model : null;
  if (typeof model !== 'string' || model.trim() === '') throw new DrawingError(NOT_CONFIGURED);
  return model;
}

/**
 * Asks the model through the studio's own route, streamed (2026-10-11) so a long think is never cut off; `onChunk` hears
 * each piece as it arrives, with the progress so far. The text of its answer, or a DrawingError saying why not. A plain
 * JSON reply is read too.
 */
export async function requestDrawing(
  model: string, messages: readonly ChatMessage[], signal: AbortSignal, fetchFn: typeof fetch = fetch, onChunk?: (p: StreamProgress) => void,
): Promise<string> {
  let r: Response;
  try {
    r = await fetchFn('/ai/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({
        model, reasoning_effort: AI_EFFORT, response_format: { type: 'json_object' }, stream: true, messages,
      }),
    });
  } catch (e) {
    if (signal.aborted) throw new DrawingError('cancelled');
    throw new DrawingError(`the model could not be reached (${e instanceof Error ? e.message : 'network error'})`);
  }
  if (r.status === 503 || r.status === 404) throw new DrawingError(NOT_CONFIGURED);
  if (r.status === 401 || r.status === 403) throw new DrawingError(`AI drawing is not configured: the model refused the key (HTTP ${r.status})`);
  if (!r.ok) throw new DrawingError(`the model answered HTTP ${r.status}`);
  let content: unknown;
  try {
    content = (r.headers.get('content-type') ?? '').includes('text/event-stream') && r.body
      ? await readStream(r.body, onChunk)
      : messageOf(await r.json());
  } catch (e) {
    if (signal.aborted) throw new DrawingError('cancelled');
    if (e instanceof DrawingError) throw e;
    throw new DrawingError('the model\'s reply is not JSON');
  }
  if (typeof content !== 'string' || content.trim() === '') throw new DrawingError('the model gave no drawing');
  return content;
}

const messageOf = (body: unknown): unknown =>
  (isObj(body) && Array.isArray(body.choices) && isObj(body.choices[0]) && isObj(body.choices[0].message) ? body.choices[0].message.content : undefined);

/**
 * The answer's text from an OpenAI-style event stream: every `data:` line's delta content, until `[DONE]`; `onChunk`
 * hears each line with the characters of thinking (Kimi's reasoning_content) and of answer so far.
 */
export async function readStream(body: ReadableStream<Uint8Array>, onChunk?: (p: StreamProgress) => void): Promise<string> {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = '', text = '', thinking = 0;
  const line = (l: string): boolean => {
    const t = l.trim();
    if (!t.startsWith('data:')) return false;
    const data = t.slice(5).trim();
    if (data === '[DONE]') return true;
    const v: unknown = JSON.parse(data);
    if (isObj(v) && isObj(v.error)) throw new DrawingError(`the model failed: ${String(v.error.message ?? 'error').slice(0, 200)}`);
    const delta = isObj(v) && Array.isArray(v.choices) && isObj(v.choices[0]) && isObj(v.choices[0].delta) ? v.choices[0].delta : undefined;
    if (delta && typeof delta.content === 'string') text += delta.content;
    if (delta && typeof delta.reasoning_content === 'string') thinking += delta.reasoning_content.length;
    onChunk?.({ thinking, writing: text.length });
    return false;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = done ? '' : lines.pop()!;
    for (const l of lines) if (line(l)) { void reader.cancel(); return text; }
    if (done) return text;
  }
}
