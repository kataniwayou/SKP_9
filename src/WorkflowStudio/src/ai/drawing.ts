import type { StudioDocument } from '../app/document';
import { setBends, setEnd, type Circuit, type End, type Side } from '../circuit/circuit';
import { netsOf } from '../circuit/families';
import { applyDraft } from '../design/apply';
import { circuitOf, moveBlocks, withCircuit, type Draft } from '../design/draft';
import { nodeBox } from '../design/hit';
import { writtenLists } from '../design/shortCircuits';
import { CACHE_NODE_PREFIX, SPHERE_NODE_ID } from '../layout/nodeIds';
import { clampLanding, GRID, PMID, PORT_GAP, snap, STEP_H, STEP_W } from '../layout/geometry';
import type { Pt } from '../layout/router';
import type { Bends } from '../layout/shape';
import { CONDITIONS } from '../model/entryConditions';

/** How far above or below its centre a tail may leave the workflow circle's right side. */
const HUB_REACH = 64;

/**
 * AI drawing (the user's design, 2026-10-11): the model (Kimi K3, behind the studio's own nginx route `/ai/`) gets the
 * drawing rules and the design graph and answers with a new drawing; the studio applies it to a candidate draft and
 * keeps it only when the relations between the steps are exactly what they were. The model only draws: it cannot add,
 * remove or reconnect a wire to another step.
 */

/** The drawing rules, highest priority first (the user's list, 2026-10-11). */
export const DRAWING_RULES = `Drawing rules for SKP Studio, highest priority first. When two rules conflict, the higher one wins.

Correctness (never broken)
1. The drawing must mean the workflow. Every step's next steps, entry steps and caches stay exactly as they are. You only move blocks and reshape wires; never move a wire's end onto another step.
2. No short circuits: a wire never lies on top of (shares a stretch of line with) a wire of another net. Wires of different families are never joined at a junction.
3. Nothing runs through a block.

Readability
4. Don't cross: a wire crosses no other wire of any colour (a crossing can be misread as a junction).
5. Straight lines: a wire keeps the height it leaves at and runs straight to its target. Straight comes before centred; no small jogs just to reach a centre.
6. Centre inputs with equal gaps: a step's inputs are centred on its middle (step y + 96), 16 px apart, ordered top to bottom by where they come from: 1 input at the centre, 2 at +-8, 3 at -16, 0, +16.
7. Symmetric hub contact points: with more than one entry step, each entry step gets its own wire from the workflow circle (never one fan-out trunk from the circle), and their contact points are symmetric about the circle's centre (centreY), 16 px apart and ordered top to bottom like the entry steps: 2 at +-8, 3 at -16, 0, +16. Place the entry steps so each of these wires runs straight into its input.
8. Outputs are placed by the forward inputs: each output takes the height of the input it feeds, so it is straight and centred at once. Outputs that feed no step input (e.g. drops onto a trunk) take the next slots below, 16 px apart.
9. Fan-in and fan-out through one trunk: several wires of the same family into one step become one trunk with each wire joining it at a junction; the same for one step feeding several steps.
10. Clean T junctions: a joining wire runs straight into the trunk at a right angle, with no hook before the junction.
11. No staircases: no wire segment shorter than 16 px; arrowheads stay clean.

Layout
12. Left to right by depth: the workflow circle on the far left, steps in columns in order of execution, aligned on the 8 px grid.
13. The main path (the Completed chain) is one straight row.
14. Failure handling sits below the row: the Failed trunk under the row, the steps it feeds at its end.
15. Skips go over the row: a wire that jumps past steps arcs above the row, clear of the drops below.
16. Place blocks so the rules agree (e.g. a step's height so a trunk enters it straight at its centre).
17. Caches sit under the workflow circle, out of the wiring's way.

Finish
18. Zero crossings, no bent main-path wire, no segment shorter than 16 px, no short circuit.`;

/** The answer's shape, as the model is told it. */
export const ANSWER_SCHEMA = `Answer with ONE JSON object and nothing else:
{
  "blocks": { "<block id>": { "x": <number>, "y": <number> } },
  "wires": {
    "<wire id>": {
      "tail": { "y": <number> } | { "auto": true } | { "junction": { "host": "<wire id>", "x": <number>, "y": <number> } },
      "head": (same as tail),
      "bends": { "xs": [<number>...], "ys": [<number>...] } | null
    }
  }
}
- blocks: the new top-left corner of any block you move (ids as given: "wf", step ids, "cache:<id>"); multiples of 8.
- An end on a step: "y" is the flow y where it meets the step's side (within the side's landing range); "auto" lets the router choose. It stays on the same step.
- A tail on the workflow circle: "y" is the flow y where it leaves the circle's right side (within its "tailsRange"); "auto" spaces the circle's tails symmetrically about its centre, 16 px apart.
- An end on a wire (a junction): "junction" names the host wire and a point exactly on the host's drawn line after your changes.
- bends: the wire's own route from its tail: it leaves horizontally, turns vertical at xs[0], horizontal at ys[0], vertical at xs[1], ... and arrives horizontally; xs has one more entry than ys. null: the router draws it. Omit a key to leave it as it is.
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
      points: w.points, bends: c.bends ?? null,
    };
  });
  return { grid: GRID, portGap: PORT_GAP, blocks, wires };
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
  wires: Map<string, { tail?: EndPlan; head?: EndPlan; bends?: Bends | null }>;
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
      const entry: { tail?: EndPlan; head?: EndPlan; bends?: Bends | null } = {};
      for (const side of ['tail', 'head'] as const) {
        const e = w[side];
        if (e === undefined) continue;
        if (!isObj(e)) throw new DrawingError(`wire ${id} ${side} is not an object`);
        const now = c[side];
        if ('junction' in e) {
          if (now.on !== 'wire') throw new DrawingError(`wire ${id} ${side} is not on a wire: it cannot become a junction`);
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
      if (w.bends !== undefined) {
        if (w.bends === null) entry.bends = null;
        else {
          const b = w.bends;
          if (!isObj(b) || !Array.isArray(b.xs) || !Array.isArray(b.ys)) throw new DrawingError(`wire ${id} bends are not {xs, ys}`);
          const xs = b.xs.map((x, i) => snap(num(x, `wire ${id} bends xs[${i}]`))), ys = b.ys.map((y, i) => snap(num(y, `wire ${id} bends ys[${i}]`)));
          if (xs.length === 0 || xs.length !== ys.length + 1 || xs.length > 32) throw new DrawingError(`wire ${id} bends: xs must have one more entry than ys`);
          entry.bends = { xs, ys };
        }
      }
      plan.wires.set(id, entry);
    }
  }
  return plan;
}

/** How far along a drawn line a point lies, or null when it is not on it. */
export function distanceAlong(points: readonly Pt[], p: Pt): number | null {
  let d = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const [a, b] = [points[i]!, points[i + 1]!];
    const len = Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
    const on = (a[0] === b[0] && Math.abs(p[0] - a[0]) < 0.5 && p[1] >= Math.min(a[1], b[1]) - 0.5 && p[1] <= Math.max(a[1], b[1]) + 0.5)
      || (a[1] === b[1] && Math.abs(p[1] - a[1]) < 0.5 && p[0] >= Math.min(a[0], b[0]) - 0.5 && p[0] <= Math.max(a[0], b[0]) + 0.5);
    if (on) return d + Math.abs(p[0] - a[0]) + Math.abs(p[1] - a[1]);
    d += len;
  }
  return null;
}

/** The plan drawn over the draft: blocks moved, ends slid, bends set, then junctions placed on their hosts as drawn. */
export function applyPlan(edited: StudioDocument, draft: Draft, plan: DrawingPlan): Draft {
  let d = moveBlocks(draft, edited, plan.blocks);
  const placed = applyDraft(edited, d);
  let c: Circuit = circuitOf(edited, d);
  const junctions: { id: string; side: Side; host: string; at: Pt }[] = [];
  for (const [id, w] of plan.wires) {
    if (w.bends !== undefined) c = setBends(c, id, w.bends);
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
  if (junctions.length > 0) {
    const drawn = applyDraft(edited, d);
    for (const j of junctions) {
      const host = drawn.wires.find((w) => w.id === j.host);
      const at = host ? distanceAlong(host.points, j.at) : null;
      if (at === null) throw new DrawingError(`wire ${j.id} ${j.side}: (${j.at[0]}, ${j.at[1]}) is not on wire ${j.host} as drawn`);
      c = setEnd(c, j.id, j.side, { on: 'wire', host: j.host, at });
    }
    d = withCircuit(d, edited, c);
  }
  return d;
}

/** Every crossing between two drawn wires: perpendicular runs meeting strictly inside both. */
export function crossingsOf(wires: readonly { id: string; points: readonly Pt[] }[]): number {
  let n = 0;
  const inside = (v: number, a: number, b: number) => v > Math.min(a, b) && v < Math.max(a, b);
  for (let i = 0; i < wires.length; i++) for (let j = i + 1; j < wires.length; j++) {
    const A = wires[i]!.points, B = wires[j]!.points;
    for (let a = 0; a + 1 < A.length; a++) for (let b = 0; b + 1 < B.length; b++) {
      const [p, q, r, s] = [A[a]!, A[a + 1]!, B[b]!, B[b + 1]!];
      const ah = p[1] === q[1], bh = r[1] === s[1];
      if (ah === bh) continue;
      const [h0, h1, v0, v1] = ah ? [p, q, r, s] : [r, s, p, q];
      if (inside(v0[0], h0[0], h1[0]) && inside(h0[1], v0[1], v1[1])) n++;
    }
  }
  return n;
}

/** How many wires are in a short circuit (a junction across families, or a stretch shared with another net). */
export const shortedOf = (doc: StudioDocument): number => doc.wires.filter((w) => w.short || (w.shortWith?.length ?? 0) > 0).length;

/** The outcome of one drawing: the candidate draft and what to tell the user. */
export type DrawingOutcome =
  | { ok: true; draft: Draft; moved: number; reshaped: number; crossings: number; shorted: number }
  | { ok: false; reason: string };

/**
 * The model's answer judged (step 5 of the user's flow): parsed and applied to a candidate; refused unless the relations
 * are exactly the snapshot's and no short circuit is added. Never a partial drawing.
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
  if (after !== snapshot) return { ok: false, reason: `it would have changed the workflow: ${diffRelations(snapshot, after)}` };
  const before = applyDraft(edited, draft), shown = applyDraft(edited, candidate);
  if (shortedOf(shown) > shortedOf(before)) return { ok: false, reason: 'it would have added a short circuit' };
  return { ok: true, draft: candidate, moved: plan.blocks.size, reshaped: plan.wires.size, crossings: crossingsOf(shown.wires), shorted: shortedOf(shown) };
}

/** The first relation two snapshots disagree on, in words. */
function diffRelations(a: string, b: string): string {
  const A = JSON.parse(a) as { next: Record<string, string[]>; entries: string[]; caches: string[]; nets: unknown[] };
  const B = JSON.parse(b) as typeof A;
  for (const id of Object.keys(A.next)) if (JSON.stringify(A.next[id]) !== JSON.stringify(B.next[id])) return `${id.slice(0, 8)}… next steps ${JSON.stringify(A.next[id])} → ${JSON.stringify(B.next[id])}`;
  if (JSON.stringify(A.entries) !== JSON.stringify(B.entries)) return 'the entry steps';
  if (JSON.stringify(A.caches) !== JSON.stringify(B.caches)) return 'the caches';
  return 'how the wires join (a junction moved to another net)';
}

/** The model the studio draws with, and how hard it thinks (the analyst's convention: low | high | max). */
export const AI_MODEL = 'kimi-k3';
const AI_EFFORT = 'high';
/** How long a drawing may take before it is given up. */
export const AI_TIMEOUT_MS = 180_000;

/** Asks the model through the studio's own route; the text of its answer, or a DrawingError saying why not. */
export async function requestDrawing(prompt: { system: string; user: string }, signal: AbortSignal, fetchFn: typeof fetch = fetch): Promise<string> {
  let r: Response;
  try {
    r = await fetchFn('/ai/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({
        model: AI_MODEL, reasoning_effort: AI_EFFORT, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
      }),
    });
  } catch (e) {
    if (signal.aborted) throw new DrawingError('cancelled');
    throw new DrawingError(`the model could not be reached (${e instanceof Error ? e.message : 'network error'})`);
  }
  if (r.status === 503 || r.status === 404) throw new DrawingError('AI drawing is not configured: the studio has no model key (Secret skp-ai)');
  if (r.status === 401 || r.status === 403) throw new DrawingError(`AI drawing is not configured: the model refused the key (HTTP ${r.status})`);
  if (!r.ok) throw new DrawingError(`the model answered HTTP ${r.status}`);
  let body: unknown;
  try { body = await r.json(); } catch { throw new DrawingError('the model\'s reply is not JSON'); }
  const content = isObj(body) && Array.isArray(body.choices) && isObj(body.choices[0]) && isObj(body.choices[0].message) ? body.choices[0].message.content : undefined;
  if (typeof content !== 'string' || content.trim() === '') throw new DrawingError('the model gave no drawing');
  return content;
}
