import type { StudioDocument } from '../app/document';
import type { End, Side } from '../circuit/circuit';
import { netsOf } from '../circuit/families';
import { applyDraft } from '../design/apply';
import { circuitOf, type Draft } from '../design/draft';
import { nodeBox } from '../design/hit';
import { writtenLists } from '../design/shortCircuits';
import { CACHE_NODE_PREFIX, SPHERE_NODE_ID } from '../layout/nodeIds';
import { GRID, PMID, STEP_H, STEP_W, TRACK } from '../layout/geometry';
import type { Pt } from '../layout/router';
import { CONDITIONS } from '../model/entryConditions';

/**
 * The drawing knowledge the chat's model is taught and judged by (2026-10-23, kept from the wand's when the wand was
 * removed): the drawing rules, the design as the model reads it, and what a drawing still breaks.
 */

/** How far above or below its centre a tail may leave the workflow circle's right side. */
const HUB_REACH = 64;

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
  // what shape_wire takes for each end: its place on what it is on, as stored (null: automatic)
  const shapeEnd = (e: End) => (e.on === 'step' ? { y: e.y } : e.on === 'hub' ? { angle: e.angle, dy: e.dy ?? null } : e.on === 'wire' ? { host: e.host, at: e.at } : { x: e.x, y: e.y });
  const wires = shown.wires.map((w) => {
    const c = circuit[w.id]!;
    return {
      id: w.id, family: conditionName(w.condition ?? undefined), tail: endOf(c.tail, w.points[0], 'tail'), head: endOf(c.head, w.points.at(-1), 'head'),
      points: w.points, shape: { tail: shapeEnd(c.tail), head: shapeEnd(c.head), bends: c.bends ?? null },
    };
  });
  return { grid: GRID, portGap: TRACK, blocks, wires };
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

/** Every step's layout issues (rules 5, 15, 16). */
function layoutIssuesOf(edited: StudioDocument, draft: Draft): string[] {
  const shown = applyDraft(edited, draft);
  const lists = writtenLists(edited, shown, draft);
  const path = mainPathOf(shown, lists.nextOf, lists.entries);
  const at = (id: string) => shown.placement.steps.get(id);
  const name = (id: string) => `step "${shown.graph.steps.get(id)?.name ?? id}"`;
  if (path.length < 2 || path.some((id) => !at(id))) return [];
  const out: string[] = [];
  const row = commonest(path.map((id) => at(id)!.y));
  const gaps = path.slice(1).map((id, i) => at(id)!.x - at(path[i]!)!.x).filter((g) => g > 0);
  const x0 = at(path[0]!)!.x, pitch = gaps.length ? commonest(gaps) : 0;
  for (const [i, id] of path.entries()) {
    const p = at(id)!;
    if (p.y !== row) out.push(`${name(id)} is on the main path, so it stays on the row: it is at y ${p.y}, the row is at y ${row} (rule 16)`);
    if (i > 0 && p.x <= at(path[i - 1]!)!.x) out.push(`${name(id)} is left of ${name(path[i - 1]!)}, the step before it on the main path (rule 15)`);
  }
  if (pitch <= 0) return out;
  for (const [id, p] of shown.placement.steps) {
    if ((p.x - x0) % pitch !== 0) out.push(`${name(id)} is off the columns: x ${p.x}, the columns are at x ${x0} + k × ${pitch} (rule 5)`);
  }
  return out;
}

/** The shortest a wire's segment may be (rule 14). */
const MIN_SEGMENT = 16;

/**
 * What is still wrong with a drawing (the user, 2026-10-12), in words, for the chat's real-model tests: every step's
 * layout (rules 5, 15, 16), each pair of crossing wires (rule 4), each bent main-path wire (rules 8, 16) and each wire
 * with a segment shorter than 16 px (rule 14). Empty when the drawing keeps them all.
 */
export function remainingProblemsOf(edited: StudioDocument, draft: Draft): string[] {
  const shown = applyDraft(edited, draft);
  const out = layoutIssuesOf(edited, draft);
  for (const c of crossingPairsOf(shown.wires)) out.push(`wires ${c.a} and ${c.b} cross${c.times > 1 ? ` ${c.times} times` : ''} (rule 4)`);
  const lists = writtenLists(edited, shown, draft);
  const path = mainPathOf(shown, lists.nextOf, lists.entries);
  for (let i = 0; i + 1 < path.length; i++) {
    // by what it connects, not its id: a wire drawn in the designer (w:…) is judged too (2026-10-25)
    const w = shown.wires.find((x) => x.source === path[i] && x.target === path[i + 1] && x.tailOn === 'terminal' && x.headOn === 'terminal');
    if (w && w.points.some((p) => p[1] !== w.points[0]![1])) out.push(`the main-path wire ${w.id} is bent: it should run straight along the row (rules 8 and 16)`);
  }
  for (const w of shown.wires) {
    const lens = w.points.slice(1).map((p, i) => Math.abs(p[0] - w.points[i]![0]) + Math.abs(p[1] - w.points[i]![1]));
    const short = lens.find((len) => len > 0 && len < MIN_SEGMENT);
    if (short !== undefined) out.push(`wire ${w.id} has a segment of ${short} px, shorter than ${MIN_SEGMENT} px (rule 14)`);
  }
  return out;
}

