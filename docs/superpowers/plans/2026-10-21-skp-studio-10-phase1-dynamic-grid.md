# SKP Studio plan 10, phase 1: the dynamic grid (alignment and equal gaps) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dragging any component (step, workflow hub, cache), on the canvas or in from the Toolbox, snaps to alignment
**and to equal gaps** the way Visio's dynamic grid does. The reach is in screen pixels, and the guides look like Visio's
(green dashed lines, green dimension arrows).

**Architecture:** `src/design/guides.ts` stays the single pure engine. `snapToGuides` gains a reach argument (flow px)
and an equal-gap pass, and returns gap marks beside the guide lines. The block drag (`useBlockDrag.ts`) and the Toolbox
drag (`toolDrag.ts`) each turn 12 screen px into flow px at the current zoom and call it. `DesignOverlay.tsx` draws the
lines and arrows in screen-constant sizes.

**Tech Stack:** TypeScript, React 19, @xyflow/react, Vitest (jsdom), Playwright (`npm run e2e`-style runs against the
Vite dev server on 5179, which proxies BaseApi on localhost:18080).

**Spec:** `docs/superpowers/specs/2026-10-21-skp-studio-10-visio-authority-design.md` §4.1, §4.1.1, §9. The evidence
is in `docs/superpowers/specs/visio-reference/` (`shots/ui5-align-held-6px.png`, `shots/ui5-gap-held-6px.png`,
`mouse-findings.txt`).

## Global Constraints

- **Components:** every component (steps, the workflow hub `wf`, caches) is both a guide source and a guide target, on
  the canvas and for Toolbox drops. Caches are never wired, but they get the guide lines (the user's ruling,
  2026-10-21).
- **Reach:** `SNAP_REACH_PX = 12` **screen** pixels, the same at every zoom (flow reach = 12 / zoom). Visio snapped at
  3, 6 and 10 px off, and not at 16.
- **Alignment targets:** edges, centres, and a step's processor middle (`PMID` = 96 below its top), all kept.
- **Equal gaps:** per §4.1.1. Gaps come from adjacent pairs in the dragged block's row (vertical spans overlap) or
  column (horizontal spans overlap). The block snaps so its gap to its nearest neighbour equals one of them.
- **Precedence:** on one axis, when alignment and an equal gap would move the block differently, **the smaller move
  wins** (spec §8, my call). Both may apply on different axes.
- **No centring snap:** none between two blocks (Visio has none).
- **Guide look (Visio):**
  - colour `#5BC85B` (sampled from Visio's screenshot);
  - lines 1 screen px, dashed 4 on 3 off;
  - each line drawn from the dragged block to the **nearest** block it matches only, overshooting 8 screen px at both
    ends.
- **Gap look (Visio):**
  - a horizontal gap gets a 1 px `#5BC85B` line with an arrowhead at both ends;
  - ticks run from 10 px above to 10 px below the line;
  - the line is 18 screen px below the lower bottom edge of the pair;
  - a vertical gap gets the same, 18 px right of the farther right edge;
  - one mark under every gap of the snapped size in that row or column, the dragged block's own included.
- **Unchanged:** the 8 px grid stays (snapping never takes a block off the grid when the others are on it), and a
  block drag is still one history step; Escape cancels. The faded-copy drag model is phase 4: do not change how a block
  moves while held.
- **Studio rules:** run npm/npx from PowerShell (Git Bash prints nothing). After `npx tsc -b`, delete
  `tsconfig.*.tsbuildinfo`. Playwright starts its own Vite on 5179, and nothing may be listening there.
- **Commits:** `wip(studio): …`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Don't push.
  Don't commit `k8s/*.yaml`, `kibana/*`, `.wf-restore.json`, `e2e/gestures.spec.ts`, `tsconfig.tsbuildinfo`,
  `tools/simulate-*`, `.playwright-mcp/`.

## Review Focus

1. **A group drag** (several picked blocks): only the grabbed block is matched. Every moving block is left out of the
   references, so nothing snaps to itself. Test in Task 3 (unit, through `snapToGuides` with the moving ids filtered),
   and the e2e in Task 5.
2. **Touching or overlapping blocks** (gap ≤ 0) never count as a gap and never get a mark. Test in Task 2.
3. **Zoomed far out** (25%: reach = 48 flow px): with several candidates in reach, the nearest wins and the block never
   jumps past a nearer one. Test in Task 2.
4. **Escape mid-drag, or a drag back to the start:** no lines or marks are left on screen, and no history step. Test in
   Task 5 (e2e).
5. **The hub (a circle) as a reference:** its square bounding box gives its edges, centre and gaps; it has no
   processor middle. Test in Task 2.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/WorkflowStudio/src/design/guides.ts` (modify) | the pure engine: alignment (reach-based, nearest-only lines), equal gaps, precedence; types `GapMark`, `Guides`, `NO_GUIDES`, `SNAP_REACH_PX` |
| `src/WorkflowStudio/src/design/guides.test.ts` (modify) | unit tests of the engine |
| `src/WorkflowStudio/src/design/useBlockDrag.ts` (modify) | zoom-based reach; publishes `Guides` (lines and gaps) |
| `src/WorkflowStudio/src/canvas/WorkflowCanvas.tsx` (modify) | `Guides` state; passes the zoom getter; merges block-drag and Toolbox guides into the overlay |
| `src/WorkflowStudio/src/design/DesignOverlay.tsx` (modify) | draws lines (overshoot) and gap marks (arrows, ticks) at screen-constant sizes |
| `src/WorkflowStudio/src/canvas/canvas.css` (modify) | `.design-guide`, `.design-gap` in Visio's green |
| `src/WorkflowStudio/src/design/DesignOverlay.test.tsx` (create) | render test of lines and gap marks |
| `src/WorkflowStudio/src/design/toolDrag.ts` (modify) | Toolbox block drops snap with the same engine; `over.guides` |
| `src/WorkflowStudio/src/design/toolDrag.test.ts` (modify) | Toolbox snapping tests |
| `src/WorkflowStudio/e2e/guides.spec.ts` (create) | real-mouse tests on the circuit throwaway |

---

### Task 1: Alignment with a reach and nearest-only lines

**Files:**
- Modify: `src/WorkflowStudio/src/design/guides.ts`
- Test: `src/WorkflowStudio/src/design/guides.test.ts`

**Interfaces:**
- Produces:
  - `export const SNAP_REACH_PX = 12;`
  - `export interface GapMark { axis: 'x' | 'y'; from: number; to: number; at: number }`: axis `'x'` is a horizontal gap
    from x `from` to x `to`, drawn below y `at` (the lower bottom edge of the pair); axis `'y'` is a vertical gap from
    y `from` to y `to`, drawn right of x `at` (the farther right edge of the pair).
  - `export interface Guides { lines: GuideLine[]; gaps: GapMark[] }` and `export const NO_GUIDES: Guides = { lines: [], gaps: [] };`
  - `export function snapToGuides(moving: GuideBox, others: readonly GuideBox[], reach: number): { dx: number; dy: number; hit: { x: boolean; y: boolean } } & Guides`.
    `reach` is in flow px. `moving` is the block's **unrounded** position. `hit.x` / `hit.y` say whether a guide caught
    that axis (an exact match counts, with `dx` / `dy` 0). Callers take the guided coordinate on a hit axis, and grid
    rounding (`snap`) on the others. `gaps` is `[]` until Task 2.

- [ ] **Step 1: Rewrite the alignment tests for the new signature** (`step(id, x, y)` = 224 × 160 with `mid: y + 96`, as
  today):
  - `snaps an edge 8 and 12 px off within a 12 px reach`: `snapToGuides(step('a', 8, 400), [step('b', 0, 0)], 12)` gives
    `dx -8`; `step('a', 12, 400)` gives `dx -12`.
  - `does nothing 16 px off with a 12 px reach`: `snapToGuides(step('a', 16, 400), [step('b', 0, 0)], 12)` equals
    `{ dx: 0, dy: 0, hit: { x: false, y: false }, lines: [], gaps: [] }`.
  - `matches an unrounded position`: `snapToGuides(step('a', 5, 400), [step('b', 0, 0)], 6)` gives `dx -5`,
    `hit.x true` (5 flow px is 10 screen px at 200%).
  - `lines up processor middles` (as today, with `12`): `dy -8`; the line contains `{ x1: 0, y1: 96, x2: 624, y2: 96 }`.
  - `draws one line per matching coordinate, to the nearest matching block only`: `others = [step('far', 0, 0), step('near', 600, 0)]`,
    `moving = step('m', 1000, 4)`. Then `dy` is `-4` and the top line is exactly `{ x1: 600, y1: 0, x2: 1224, y2: 0 }`, not
    a line from `far`.
  - The `guideBoxes` test is unchanged.
- [ ] **Step 2: Run, and see the new tests fail.** Run `npx vitest run src/design/guides.test.ts` in
  `src/WorkflowStudio`. Expected: FAIL (the third argument is ignored, the nearest-only line is wrong, `gaps` is
  missing).
- [ ] **Step 3: Implement.** `best()` takes `reach` instead of `GRID`. Lines: for each coordinate of the moved box that
  exactly matches one or more other boxes, draw one line spanning the moved box and the **nearest** of those boxes
  (nearest by distance along the line), de-duplicated as today. Return `gaps: []`. Update the call in `useBlockDrag.ts`
  to pass `GRID` for now, so the build stays green (Task 3 replaces it).
- [ ] **Step 4: Run, and see the tests pass.** Run the same command. Expected: PASS. Also run `npx tsc -b` with no
  errors, then delete `tsconfig.*.tsbuildinfo`.
- [ ] **Step 5: Commit.** `wip(studio): alignment guides snap within a given reach and draw each line to the nearest matching block only (plan 10 phase 1)`.

### Task 2: Equal gaps

**Files:**
- Modify: `src/WorkflowStudio/src/design/guides.ts`
- Test: `src/WorkflowStudio/src/design/guides.test.ts`

**Interfaces:**
- Consumes: Task 1's `snapToGuides`, `GapMark`.
- Produces: `snapToGuides` now also snaps to equal gaps and fills `gaps`. Its signature is unchanged.

- [ ] **Step 1: Write the failing tests** (`describe('equal gaps (Visio dynamic grid)')`), with A = `step('A', 0, 0)`
  and B = `step('B', 288, 0)` (gap 64; B's right edge 512):
  - `snaps to repeat a row gap 10 px off`: `snapToGuides(step('D', 586, 0), [A, B], 12)` gives `dx -10`, `dy 0`. `gaps`
    equals the two marks `{ axis: 'x', from: 224, to: 288, at: 160 }` and `{ axis: 'x', from: 512, to: 576, at: 160 }`
    (in any order).
  - `does not snap 16 px off`: `step('D', 592, 0)` gives `dx 0`, `gaps []`.
  - `snaps from the right neighbour too`: `others = [A, B, step('C', 900, 0)]`, `moving = step('D', 600, 0)`. D's gap to C
    is 76, B–C isn't adjacent to D's side, A–B is 64. So `dx 12` (gap to C becomes 64), and the marks include A–B and D–C.
  - `snaps in a column`: A2 = `step('A2', 0, 0)`, B2 = `step('B2', 0, 224)` (gap 64; B2's bottom 384).
    `snapToGuides(step('D', 0, 456), [A2, B2], 12)` gives `dy -8`. The marks include
    `{ axis: 'y', from: 160, to: 224, at: 224 }` and `{ axis: 'y', from: 384, to: 448, at: 224 }`.
  - `takes gaps only from pairs in the dragged block's row`: `others = [step('A', 0, 0), step('B', 288, 0)]`,
    `moving = step('D', 586, 600)` (no vertical overlap). Then `dx 0`, `gaps []`.
  - `smaller move wins between alignment and an equal gap on one axis`: `others = [A, B, step('E', 580, 400)]`,
    `moving = step('D', 586, 0)`. The left-edge alignment with E is 6 and the gap snap is 10, so `dx -6`. The gap marks
    are absent (the gap is now 68).
  - `ignores touching or overlapping blocks as gaps`: `others = [step('A', 0, 0), step('B', 224, 0)]` (gap 0),
    `moving = step('D', 450, 0)` (gap to B 2). Then `dx 0`, `gaps []`.
  - `the nearest candidate wins at a wide reach (25% zoom = 48 flow px)`: `others = [A, B]`, `moving = step('D', 600, 0)`,
    reach 48. Then `dx -24` (gap to B becomes 64), not a jump to any other gap.
  - `the hub's square box counts`: `others = [{ id: 'wf', x: 0, y: 0, w: 192, h: 192 }, step('S', 256, 16)]` (gap 64),
    `moving = step('T', 548, 16)`. Then `dx -4`, and a mark `{ axis: 'x', from: 192, to: 256, at: 192 }`.
- [ ] **Step 2: Run, and see them fail.** `npx vitest run src/design/guides.test.ts`. Expected: FAIL on every
  equal-gap test.
- [ ] **Step 3: Implement.** Gaps, snap and marks:
  - **Row:** the boxes whose vertical span overlaps the moving box's (strict overlap, more than 0).
  - **Gap set:** each pair (p, q) in the row with q directly right of p and no other row box between them, with gap
    `q.x − (p.x + p.w) > 0`.
  - **Snap:**
    - the left neighbour is the row box with the largest right edge ≤ the moving box's centre x, and the right
      neighbour likewise from the other side;
    - the candidates are `dx = g − gapL` and `dx = (R.x − g − w) − m.x` for each gap g;
    - the smallest |dx| within reach is taken, ties to the smaller move, then the left side;
    - columns work the same way on y.
  - **Per axis,** compare with the alignment offset from Task 1 and keep the smaller |move|. A zero alignment offset
    counts as no candidate.
  - **Marks:** at the **final** position, every adjacent row pair (moving box included) whose gap exactly equals the
    moving box's gap to the neighbour it snapped to, and likewise in the column. No marks when no equal gap holds
    exactly.
  - **Lines:** still computed at the final position.
- [ ] **Step 4: Run, and see them pass.** Same command; all guides tests PASS.
- [ ] **Step 5: Commit.** `wip(studio): equal gaps — a dragged block snaps to repeat a gap of its row or column and gets Visio's gap marks; the smaller move wins over alignment (plan 10 phase 1)`.

### Task 3: The block drag uses screen pixels, and the overlay draws Visio's guides

**Files:**
- Modify: `src/WorkflowStudio/src/design/useBlockDrag.ts`, `src/WorkflowStudio/src/canvas/WorkflowCanvas.tsx`,
  `src/WorkflowStudio/src/design/DesignOverlay.tsx`, `src/WorkflowStudio/src/canvas/canvas.css`
- Create: `src/WorkflowStudio/src/design/DesignOverlay.test.tsx`

**Interfaces:**
- Consumes: `snapToGuides`, `Guides`, `NO_GUIDES`, `SNAP_REACH_PX`, `GapMark`.
- Produces:
  - `useBlockDrag(saved, shown, design, setPreview, setGuides: (g: Guides) => void, onSelect, suppressNodeClick, zoom: () => number)`.
    `zoom` returns screen px per flow px.
  - `DesignOverlayProps.guides: Guides` (was `GuideLine[]`).

- [ ] **Step 1: Write the failing render test** (`DesignOverlay.test.tsx`; render inside `ReactFlowProvider` with a
  1.0 zoom, as other overlay users do; mock nothing else):
  - `draws each guide line dashed, overshooting 8 screen px at both ends`: guides
    `{ lines: [{ x1: 0, y1: 50, x2: 400, y2: 50 }], gaps: [] }` produce one `line.design-guide` with `x1 = -8`,
    `x2 = 408`, `y1 = y2 = 50`, and a `stroke-dasharray` of `4 3`.
  - `draws a gap mark as an arrowed line with two ticks 18 px below`: gaps `[{ axis: 'x', from: 224, to: 288, at: 160 }]`
    produce one `g.design-gap`, containing a line from (224, 178) to (288, 178), two tick lines at x 224 and 288 from
    y 168 to 188, and arrowheads at both ends (`marker-start` and `marker-end`, or two `path` heads).
- [ ] **Step 2: Run, and see it fail.** `npx vitest run src/design/DesignOverlay.test.tsx`. Expected: FAIL (the prop is
  `GuideLine[]`, and there are no gap marks).
- [ ] **Step 3: Implement:**
  - **`useBlockDrag`:** gains the `zoom` parameter. Flow reach = `SNAP_REACH_PX / zoom()`. `snapToGuides` gets the
    grabbed block at React Flow's **unrounded** position (`change.position`). On an axis where `hit` is true the block
    takes the guided coordinate; on the other axes `snap()` rounds to the 8 px grid, as today. Then
    `setGuides({ lines, gaps })`. Every `setGuides([])` becomes `setGuides(NO_GUIDES)`. The references stay
    `guideBoxes(shown.current)` minus every moving id.
  - **`WorkflowCanvas`:** `useState<Guides>(NO_GUIDES)`. Pass `() => flowStore.getState().transform[2]` as `zoom`, and
    `guides` into `DesignOverlay`.
  - **`DesignOverlay`:**
    - lines are drawn as now, with the 8 screen px (`8 * k`) overshoot along their own axis and
      `strokeDasharray={`${4 * k} ${3 * k}`}`;
    - each `GapMark` is a `g.design-gap` holding the main line offset `18 * k` past `at`, ticks of ±`10 * k`, and an
      arrowhead about 6 screen px long at each end;
    - all strokes are `1 * k`.
  - **`canvas.css`:** `.design-guide { stroke: #5BC85B; }` (drop the white and glow), and
    `.design-gap line, .design-gap path { stroke: #5BC85B; fill: #5BC85B; }`.
- [ ] **Step 4: Run the overlay test and the related suites.**
  `npx vitest run src/design/DesignOverlay.test.tsx src/design/guides.test.ts src/canvas` must PASS. `npx tsc -b`
  must report no errors; delete `tsconfig.*.tsbuildinfo` afterwards.
- [ ] **Step 5: Commit.** `wip(studio): block drags snap within 12 screen px at any zoom; guides drawn in Visio's green, dashed, nearest-only with overshoot; equal-gap marks with arrows and ticks (plan 10 phase 1)`.

### Task 4: Toolbox drops snap with the same engine

**Files:**
- Modify: `src/WorkflowStudio/src/design/toolDrag.ts`, `src/WorkflowStudio/src/canvas/WorkflowCanvas.tsx`
- Test: `src/WorkflowStudio/src/design/toolDrag.test.ts`

**Interfaces:**
- Consumes: `snapToGuides`, `guideBoxes`, `Guides`, `NO_GUIDES`, `SNAP_REACH_PX` (guides.ts); `landingBox(item, p)`
  (toolDrop.ts).
- Produces: `ToolDragState['over']` gains `guides: Guides`. For a block item (`step`, `newCache`, `cache`) whose
  verdict is `place`, `over.flow` is the pointer flow point **shifted by the snap**, so that
  `landingBox(item, over.flow)` is the snapped box. `end()` returns that shifted point as `at`, so the drop lands
  exactly where the preview showed.

- [ ] **Step 1: Write the failing tests** (in `toolDrag.test.ts`, reusing its fake canvas, `three()` fixture,
  `registerDropTarget`). Add a `holdBlock(item, flowPoint, k)` helper beside `hold`, which moves the pointer to
  `flowPoint × k` with `toFlow = c / k`.
  - `an empty step held 10 screen px off level with s1's top snaps level and shows the line`: s1 is at (288, 256).
    Pointer flow point `{ x: 1000 + 112, y: 256 + 80 + 10 }` at `k = 1`. Then `landingBox({ kind: 'step' }, over.flow).y`
    is `256` and `over.guides.lines.length > 0`.
  - `the same 10 screen px at zoom 2 (5 flow px) still snaps`: the same point with the offset `5`, `k = 2`, gives
    `y 256`.
  - `16 screen px off does not snap`: offset `16`, `k = 1`, gives `y 272` (`snap(256 + 16)`), and `over.guides.lines`
    is `[]`.
  - `a processor tile gets no guides`: the processor item over s1 gives `over.guides` equal to `NO_GUIDES`.
  - `a cache tile snaps like a step`: `{ kind: 'newCache' }` held 8 flow px off level with s1's top snaps level.
- [ ] **Step 2: Run, and see them fail.** `npx vitest run src/design/toolDrag.test.ts`. Expected: FAIL (`guides`
  missing, no snap).
- [ ] **Step 3: Implement:**
  - **`toolDrag.move`:** after the verdict, for a block item with `verdict.kind === 'place'`:
    - take the **unrounded** landing box: the block's size centred on `flow`, without `snap`;
    - `g = snapToGuides({ id: '', ...raw }, guideBoxes(target.shown()), SNAP_REACH_PX × flowPerScreenPx)`. The px →
      flow factor is the one already computed for `reach`.
    - on a hit axis, shift `over.flow` by that axis's offset; on the others leave it, so `landingBox` rounds to the grid
      as today;
    - `over.guides = { lines: g.lines, gaps: g.gaps }`.
    - Otherwise `over.guides = NO_GUIDES`.
  - **`WorkflowCanvas`:** pass `toolOver?.guides ?? guides` to the overlay. A Toolbox drag and a block drag never run
    together.
- [ ] **Step 4: Run, and see them pass.** `npx vitest run src/design/toolDrag.test.ts src/panels/Toolbox.test.tsx src/design/toolDrop.test.ts`
  gives PASS.
- [ ] **Step 5: Commit.** `wip(studio): blocks dropped from the Toolbox snap to alignment and equal gaps and show the guides while held (plan 10 phase 1)`.

### Task 5: Real-mouse verification, full suites

**Files:**
- Create: `src/WorkflowStudio/e2e/guides.spec.ts`

**Interfaces:**
- Consumes: `e2e/studio.ts` (`openWorkflow`, `documentPanel`, `node`, `box`, `flowToPage`, `zoomOf`, `test`, `expect`)
  and `e2e/throwaway.ts` (`createCircuitThrowaway`, `removeThrowaway`): steps a, b, c, d, one cache, the hub `wf`. Read
  only; nothing is saved.

- [ ] **Step 1: Write the tests.** They follow `feedback.spec.ts`'s setup: serial, a fresh page, storage cleared. Each
  drag uses the real mouse, presses on a block's caption strip, and moves in steps. Positions are read back from the
  node's `transform`, as `flowAt` does in `feedback.spec.ts`.
  - **Equal gap:** drag step d so its gap to its row neighbour is 10 screen px off a gap that already exists in that
    row. Find the row and gap from the block boxes. While held, `.design-gap` count ≥ 2 and every `.design-guide` is
    `#5BC85B` (computed `stroke`). Released, d's gap equals that gap exactly.
  - **Alignment reach at two zooms:** at 100%, release d 10 screen px below level with a's top, and it lands level.
    Again 16 px off, and it doesn't. Zoom to 200% (the toolbar `+` until `zoomOf` is 2), and repeat the 10 px case: it
    still lands level.
  - **The cache:** drag the cache 6 screen px off level with a step's top, and it lands level, with a `.design-guide`
    while held. Also drag a step 6 px off level with the cache's top, and it lands level.
  - **The hub as a reference:** drag a step 6 screen px off level with the hub's centre, and it lands level.
  - **A Toolbox empty step:** dropped 8 screen px off level with a step's top, it lands level, and guides show while
    held.
  - **Escape and drag-back:** hold d near an equal gap, then press Escape. No `.design-guide` or `.design-gap` is left,
    and "● design draft" is absent. Then drag d out and back to its start: no draft appears.
- [ ] **Step 2: Run the new spec.** `npx playwright test e2e/guides.spec.ts` (from PowerShell in `src/WorkflowStudio`,
  with BaseApi forwarded on 18080). Expected: all pass. Fix the product, not the test, when a rule is broken.
- [ ] **Step 3: Run the neighbouring suites and the unit suite.**
  `npx playwright test e2e/feedback.spec.ts e2e/toolbox.spec.ts e2e/designer.spec.ts` must all pass. `npx vitest run`
  must pass, except known timing flakes, which must pass when re-run alone.
- [ ] **Step 4: Side-by-side check.** On the dev server, screenshot an equal-gap drag held. Put it beside
  `docs/superpowers/specs/visio-reference/shots/ui5-gap-held-6px.png`, and compare the colour, dashes, arrow position
  and ticks.
- [ ] **Step 5: Commit.** `wip(studio): real-mouse tests of the dynamic grid — equal gaps, 12 px reach at two zooms, cache and hub references, Toolbox drops, Escape (plan 10 phase 1)`.
