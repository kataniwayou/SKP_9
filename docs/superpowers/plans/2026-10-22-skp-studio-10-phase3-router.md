# SKP Studio plan 10, phase 3: the router (Visio's spacing) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** automatic wires are routed the way Visio routes point-glued connectors:
- 64 px stubs out of and into blocks;
- 64 px clearance round blocks, on the nearer side;
- tracks 32 apart;
- a shared fan-out trunk for wires of one net;
- landing slots 32 apart;
- arc jumps at crossings;
- a 128 px automatic layout gap;
- Visio's U-turn for a target behind its source.

**Architecture:**
- A new pure module `src/layout/search.ts` routes one block-to-block wire. It first tries Visio's base shape: straight,
  a Z with its upright at the source stub, or the U of spec §4.3. If the base shape hits a block or another net's track,
  it falls back to an orthogonal path search (Dijkstra over grid lines through inflated box edges, stub ends and
  tracks). The search has lexicographic costs and a bounded box that is widened if nothing is found.
- `circuitRoute.ts` calls it for every automatic wire whose two ends are on blocks. Wires with an end on a junction or
  open, and hand-shaped wires, keep today's code (`route()` + `clearPath`, `pointsOfShape`).
- Line jumps are a pure `jumpsOf(routes)` in `src/layout/jumps.ts`. `toFlow` passes them to `CableEdge`, which draws
  them with `pathWithJumps` (svgPath.ts).

**Spec:** `docs/superpowers/specs/2026-10-21-skp-studio-10-visio-authority-design.md` §4.2, §4.2.1, §4.3, §7. Visio's
measured paths are in `visio-reference/automation-findings.txt`. Visio's y axis points up there, and 1 mm = 8.96 px.

## Global Constraints

- **Lengths (flow px), in `geometry.ts`:**
  - `STUB = 64`, the stub and the clearance;
  - `HALF_CLEAR = 32`, the least clearance in a narrow gap;
  - `TRACK = 32`, the spacing between other nets' parallel runs, fan-out classes and landing slots;
  - `JUMP = 16`, the arc width;
  - `LAYOUT_GAP = 128`;
  - `COLUMN_PITCH = STEP_W + LAYOUT_GAP = 352`;
  - `FIRST_COLUMN_X = 352`, so the hub's right edge (224) is 128 from the first column.
- **Base shapes** (Visio, measured; checked first; taken when they cross no block and lie on and beside no other net's
  run):
  - Same height, target ahead and nothing between: straight.
  - Target ahead (`tx - sx >= 2 * STUB`): out of the source along `sy` to `sx + STUB`, the upright there, then along
    `ty` into the target. Visio "fan-out" and "overlaps and checks" S1/S2: the upright is at the source stub.
  - Target ahead but nearer (`2 * GRID <= tx - sx < 2 * STUB`): the upright mid-gap, at `snap((sx + tx) / 2)`.
  - Target behind (`tx - sx < 2 * GRID`): spec §4.3's U.
    1. Out to `sx + STUB`.
    2. Up or down to the level.
    3. Back along the level to `tx - STUB`.
    4. Up or down to `ty`, and in.

    The level depends on how the two blocks sit:
    - The blocks don't overlap in height: the level is on the target's side of the free band. That is `target.top -
      STUB` when the target is below, `target.bottom + STUB` when it is above. This holds only while that level keeps
      `HALF_CLEAR` off the source block; otherwise the next case applies.
    - Otherwise, over the top of both: `min(tops) - STUB`.
- **Search** (when the base shape is refused):
  - **Nodes:** the grid lines through:
    - `s' = (sx + stub, sy)` and `t' = (tx - stub, ty)`;
    - every near box's edges ± `STUB` and ± `HALF_CLEAR`;
    - every other-net track within the bound ± `TRACK`.
  - **Moves:** the four headings. No reversal. Leaving `s'` heading `-x` is not allowed, and neither is reaching `t'`
    heading `-x`.
  - **Hard rules:**
    - never strictly inside a block's box (own blocks included) or inside another block's box grown by `HALF_CLEAR`;
    - a run on another net's run costs `ON_COST = 1000` per px, so it is effectively hard, but a route always exists.
  - **Primary cost:** length + `BEND = 40` per bend + `NEAR = 2` per px inside a non-own box grown by `STUB` + `BESIDE
    = 4` per px parallel to another net's run closer than `TRACK` + `ON_COST`.
  - **Tie-breaks, in order:**
    1. Σ over upright runs of `|x - t'x| × length`, so detours hug the obstacle and come back at the target stub (Visio,
       "obstacle and crossing", "overtaking");
    2. the length of level runs below `sy`, so a tie goes up.
  - **Bound:** the box round `s'`, `t'` and both own boxes, grown by `3 × STUB`; if nothing is found, every box.
  - **Fallback:** no path at all gives today's `route()` result.
- **Fan-out:** the automatic tails of one source are grouped by `sharesNet`. One group leaves at the processor middle,
  and so shares the trunk. Groups leave `TRACK` apart round it, ordered by where they head.
- **Landing:** slots `TRACK` apart. The straight band and extent rules are kept.
- **Jumps:**
  - Every crossing of a level run and an upright run of two different wires gets an arc `JUMP` wide on the level run,
    bulging up.
  - No jump within `JUMP` of either run's ends, so none at junctions or wire ends.
  - No jump where the two wires share a net.
- **Kept:** hand-shaped wires, junction leads, hub ring leads, the rip-up loop, the `heights` loop, short-circuit
  marking, and `route()` for ends not on blocks.
- **Performance:** 30 steps and 40 wires route in under 50 ms. The unit test asserts under 150 ms in Node, to keep it
  from being flaky, and logs the time.
- **Commits and runs:**
  - commit as `wip(studio): … (plan 10 phase 3)` with the Co-Authored-By line;
  - run npm/npx from PowerShell, and delete `tsconfig.*.tsbuildinfo` afterwards;
  - don't push;
  - leave the same excluded files untouched as before.

## Task 1: constants and the 128 px layout gap
- `geometry.ts`:
  - add `STUB`, `HALF_CLEAR`, `TRACK`, `JUMP` and `LAYOUT_GAP`;
  - set `COLUMN_PITCH = 352`.
- `placement.ts`: set `FIRST_COLUMN_X = 352` and `GAP = LAYOUT_GAP`.
- Tests first: `placement.test.ts` expects columns 352 apart, the first step at x 352, and rows and the parked row 128
  below.
- Update existing unit expectations that encoded 288 / 64.
- Test: `npx vitest run src/layout`.

## Task 2: landing slots 32 apart
- `ports.ts`: the slots' spacing is `TRACK`, in place of `PORT_GAP`.
- Tests first in `ports.test.ts`:
  - two bent arrivals land 32 apart round the middle;
  - a fan-in of 4 fits in the extent;
  - a 6th spills.

## Task 3: `search.ts`, the router for one wire
- Signature: `routeBlocks(s: Pt, t: Pt, own: { src: Box | null; tgt: Box | null }, boxes: Box[], tracks: Tracks):
  Pt[]`.
- `Tracks` is a small index of other-net runs: `add(points)`, `cost(a, b)` and `lines(lo, hi, axis)`.
- Unit tests first, each a measured Visio scene carried to Studio px:
  - straight, same height;
  - Z: the upright at `sx + 64`;
  - near Z: the upright mid-gap;
  - U, same height: over the top, level `top - 64`, uprights at `sx + 64` and `tx - 64`;
  - U, target below: level `target.top - 64`;
  - U, overlapping heights: `min(tops) - 64`;
  - an obstacle between level blocks: the upright at `obstacle.left - 64`, the level on the nearer side `± 64`, back
    down at `tx - 64`;
  - a narrow gap of 80 px between two blocks: straight through;
  - a gap of 48 px: around;
  - another net's run lying on the base Z's upright: the route keeps 32 off it;
  - never inside any box (fuzzed over 200 random scenes);
  - every route right-angled and starting and ending at `s` and `t`.

## Task 4: circuitRoute uses it; fan-out trunk
- In `drawWith`: when `T.box` and `H.box` are both set and the wire has no shape, call `routeBlocks`, with the tracks
  of `taken` filtered to other nets. Skip the spread loop for those wires.
- `departY`: groups by `sharesNet`, `TRACK` apart.
- Tests first in `circuitRoute.test.ts`:
  - two same-net siblings share the trunk (identical first upright, same start y);
  - two different-net tails leave 32 apart;
  - a fan-in lands 32 apart;
  - the U of a step wired to a step behind it;
  - the perf test (30 steps, 40 wires).
- Fix the old expectations that encoded 24 / 16.

## Task 5: line jumps
- `jumps.ts`: `jumpsOf(routes, sameNet)` gives a `Map<id, Pt[]>`: the crossing points on each wire's level runs.
- `svgPath.ts`: `pathWithJumps(points, jumps)` draws each jump as `L x-8 y A 8 8 0 0 1 x+8 y`, walking left to right
  or right to left the way the run goes. The sweep is chosen so the arc bulges up.
- `toFlow` puts `jumps` into the edge data, and `CableEdgeView` draws the `w` path with them. The pulse, hit and
  overlaps stay plain.
- Tests first: `jumps.test.ts`, `svgPath` tests, and a `CableEdge.test` that checks the `A` in the path.

## Task 6: real-mouse scenes and the e2e suite
- New `e2e/routes.spec.ts`, on a throwaway workflow, read-only, as the other suites do. Blocks are placed by real
  drags, and routes are read from `g.wire path.w` `d` attributes:
  - U behind and below;
  - obstacle;
  - fan-out trunk shared;
  - fan-in 32 apart;
  - a crossing with an arc.
- Run the whole e2e suite and fix the expectations that encoded the old geometry. Product fixes are made only when a
  test shows a real defect.
- Take screenshots of the Studio scenes and put them side by side with Visio's (`11-overtaking.png`,
  `03-obstacle-and-crossing.png`, `16-jumps.png`) in the scratchpad for the report.

## Review Focus
- Routes through a block, when the base shape check and the search disagree about own boxes.
- Hub tails: the sphere's box as the source box, `s'` relative to the hub's right edge.
- Wires whose stub end `s'` lies inside another block (blocks packed closer than 64): the fallback.
- Performance when the search widens to every box.
- Jumps on wires of one net, and at a junction contact.
