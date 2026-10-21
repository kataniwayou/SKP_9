# SKP Studio plan 10, phase 2: wire looks and feedback (Visio's) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A picked wire, a dragged wire end, a dragged run and the cursors look and behave like Visio's connector:
- glued ends are green dots, open ends hollow circles;
- dots mark the runs and bends;
- glue targets show a green outline and a green landing square;
- the old wire stays put while a dashed preview shows the new route;
- a dragged run shows an alignment guide and snaps;
- crosshair while placing an end, move cursors for grabbing.

**Architecture:** the look is drawn by `DesignOverlay.tsx` (screen-constant sizes, as today) from `squaresOf` (cut.ts),
which gains bend points and end states. The previews move from "redraw the wire live" to "dashed ghost in the overlay,
draft unchanged until release" in `useWireGestures.ts`. Reach constants live in `drop.ts`. Cursors are CSS
(`canvas.css`), plus the `gesture-*` classes the canvas already sets.

**Tech Stack:** TypeScript, React 19, @xyflow/react, Vitest, Playwright (real mouse, circuit throwaway, read-only).

**Spec:** `docs/superpowers/specs/2026-10-21-skp-studio-10-visio-authority-design.md` §4.4 and §4.7. The evidence is
in `visio-reference/shots/` (`ui-sel-near-A.png`, `ui-free-end-zoom.png`, `ui-drawing-over-B-body.png`,
`ui-drawing-over-B-left-point.png`, `ui-end-dragged-in-open.png`, `ui2-segment-sideways-held.png`, `ui2-cursors.png`,
`ui4-cursors.png`).

## Global Constraints

- **Colours:** `#5BC85B` is Visio's green, for glued ends, glue outlines and landing squares. Refusals stay red
  `#F87171`. The open-end ring is grey `#8A97A8`.
- **Sizes, in screen px at any zoom:**
  - end circle 8 (glued: a green dot inside a 1.5 px ring; open: white fill, grey ring);
  - run dot 6;
  - bend dot 4, not pressable;
  - landing square 10 with a 2 px green frame;
  - glue outline 3 px, offset 4.
- **Reach, in screen px:** 10 for a step side and the hub ring (`DROP_REACH`), 12 for a wire's line (`LINE_REACH`,
  new).
- **Previews:** while an end, a body or a run is dragged, the committed drawing does not change. The dragged wire stays
  where it was, at 45% opacity, and its new route is drawn dashed (`design-ghost`, dash 6 on 4 screen px) in the
  overlay. On release the draft is committed, as today; Escape cancels, as today. Other wires are not rerouted while
  dragging (Visio reroutes on release).
- **Run drag guide:** a grey `#8A97A8` dashed line along the dragged run's axis, across the visible canvas, through the
  handle. The run snaps within 12 screen px to:
  - a block's edge or centre;
  - another wire's parallel run;
  - a step's input or output landing height (for the last or first run).
- **Cursors:**
  - `move` over blocks and wire bodies;
  - `move` while dragging a block or a wire body;
  - `crosshair` while placing an end (end square drag, a new wire from a port, the Wire tile over a canvas) and over a
    step's port in design mode;
  - run squares keep `ns-resize` / `ew-resize`;
  - pane panning keeps `grabbing`.
- **Kept rules:** Studio's own rules are unchanged:
  - refusal labels;
  - rule B (body drag reconnects);
  - cut and delete-wire on squares (rule E: run dots remain the cut targets; bend dots are not targets);
  - `clearOfEnds` (a run handle hidden where an end would cover it).
- **Commits and runs:** `wip(studio): … (plan 10 phase 2)` with the Co-Authored-By line; run npm/npx from PowerShell;
  delete `tsconfig.*.tsbuildinfo`; don't push; the same excluded files as phase 1.

## Review Focus

1. A junction end (on another wire) counts as glued: green, not hollow. Test in Task 1.
2. A direction-less wire (no step or hub end) has no arrow or ring today. Its ends still get handles, hollow ones. Test
   in Task 1.
3. Escape during a run drag or end drag: the ghost goes, the wire is back at full opacity, no draft. Test in Task 6.
4. The run snap must not pull a run onto another net's wire (rule G short circuit): a snap target on another net is
   skipped. Test in Task 4.
5. At 25% zoom the reach in flow px is 4× larger: the nearest snap wins and the landing square still sits on the real
   contact. Test in Task 2.

---

### Task 1: Ends and dots (the picked wire's handles)

**Files:** modify `src/design/cut.ts`, `src/design/DesignOverlay.tsx`, `src/canvas/canvas.css`; tests in
`src/design/cut.test.ts` (existing) and `src/design/DesignOverlay.test.tsx`.

**Interfaces:**
- `Square` end variant gains `glued: boolean` (true when that end is on a step, the hub or a wire).
- A new export, `bendsOf(w: WireRoute, bends: Bends): { x: number; y: number }[]`, gives the core's corner points
  (every interior point of `pointsOfShape(core.ends, bends)`).

- [ ] **Step 1: Failing tests:**
  - `cut.test.ts`: an end on a step side is `glued: true`, an open end is `glued: false`, an end on a junction is
    `glued: true`; `bendsOf` of a Z wire gives its two corners.
  - `DesignOverlay.test.tsx`:
    - a picked wire with one glued end and one open end draws `circle.design-handle.end.glued` and
      `circle.design-handle.end.open`, each of radius 4 at zoom 1;
    - run handles are `circle.design-handle.seg`, radius 3;
    - bends are `circle.design-bend`, radius 2, with `pointer-events: none` (class only; CSS asserted in e2e).
- [ ] **Step 2: Run them, and see them fail.** `npx vitest run src/design/cut.test.ts src/design/DesignOverlay.test.tsx`.
- [ ] **Step 3: Implement.** `squaresOf` sets `glued` from `w.tailOn` / `w.headOn` (`!== 'open'`). The overlay draws
  circles instead of rects, keeps `data-end`, `data-k` and the pointer handlers, and adds the bend dots under the
  handles. In CSS:
  - `.design-handle.end.glued { fill: #5BC85B; stroke: #fff; }`
  - `.design-handle.end.open { fill: #fff; stroke: #8A97A8; }`
  - `.design-handle.seg { fill: var(--accent); stroke: none; }`
  - `.design-bend { fill: var(--accent); pointer-events: none; }`
  - Update the e2e helpers that select `rect.design-handle…` (`e2e/studio.ts` `endSquare`, `runSquare`, `squareOn`)
    to drop the element name.
- [ ] **Step 4: Run them, and see them pass.** Run the same tests plus `npx vitest run src/design src/canvas` and
  `npx tsc -b`.
- [ ] **Step 5: Commit** `wip(studio): a picked wire's ends and dots drawn as Visio's — glued green, open hollow, dots on runs and bends (plan 10 phase 2)`.

### Task 2: Glue feedback and reach

**Files:** modify `src/design/drop.ts` (`DROP_REACH` 8 → 10, new `LINE_REACH = 12`), `src/design/useWireGestures.ts`
(`dropGesture` uses `LINE_REACH` for `wireAt`), `src/design/toolDrag.ts` (the Wire tile likewise), `DesignOverlay.tsx`,
`canvas.css`; tests in `src/design/drop.test.ts` and `DesignOverlay.test.tsx`.

**Interfaces:**
- `DropHint` gains `contact: Point | null`: where the end would land, i.e. `pointOfTarget(shown, target)` for a
  step, hub or wire target, and null when open.
- `DesignOverlayProps.tool` gains `contact?: Point | null` (the Wire tile's).

- [ ] **Step 1: Failing tests:**
  - `drop.test.ts`: an end 9 screen px outside a step side is over it (`blockAt` with `DROP_REACH / zoom`); a point
    11 px off a line counts with `LINE_REACH`, but not 13.
  - `DesignOverlay.test.tsx`: a hint with `contact {x: 100, y: 50}` and tone `ok` draws `rect.design-contact.ok` 10
    screen px square, centred there; tone `no` draws `.design-contact.no`.
- [ ] **Step 2: Run them, and see them fail.**
- [ ] **Step 3: Implement.**
  - **Overlay:** draws the landing square for every hint with a contact and for `tool.contact`.
  - **`canvas.css`:**
    - `.drop-ok` outline colour `#5BC85B`;
    - `.design-contact.ok { fill: none; stroke: #5BC85B; }`;
    - `.design-contact.no { fill: none; stroke: #F87171; }`.
  - **`WorkflowCanvas`:** passes the tile's contact from `toolOver.verdict.target` via `pointOfTarget`.
- [ ] **Step 4: Run them, and see them pass,** plus `npx vitest run src/design src/canvas`.
- [ ] **Step 5: Commit** `wip(studio): glue feedback as Visio's — green outline and a green landing square; reach 10 px on sides and the hub, 12 on lines (plan 10 phase 2)`.

### Task 3: Dashed previews; the dragged wire stays until release

**Files:** modify `src/design/useWireGestures.ts`, `src/canvas/WorkflowCanvas.tsx`, `DesignOverlay.tsx`, `canvas.css`;
tests in `src/design/useWireGestures.test.tsx` (existing) and `DesignOverlay.test.tsx`.

**Interfaces:**
- `WireGhost` gains `held: string | null`: the id of the wire being dragged, drawn faded at its old place.
- `ghost.points` is always the dashed preview, drawn in the overlay; the canvas never swaps the dragged wire's points.
- `startSegment` uses `setGhost`, not `setPreview`, while it runs.

- [ ] **Step 1: Failing tests** (`useWireGestures.test.tsx`):
  - during an end drag, `setPreview` is never called with a draft, and the ghost has `held = wire id` and the new
    route's points;
  - during a run drag, the same, and on release `onCommit` gets the shaped draft as today;
  - Escape: the ghost clears, no commit.
  - `DesignOverlay.test.tsx`: the ghost path has `stroke-dasharray` `6 4`.
- [ ] **Step 2: Run them, and see them fail.**
- [ ] **Step 3: Implement.**
  - **End drag and body drag:** keep `setGhost`, but give it `held`, and stop the canvas mapping that replaced the
    dragged edge's points. Instead the canvas adds `className: 'held'` to that edge (`.react-flow__edge.held { opacity: .45 }`).
  - **Run drag:** compute the shaped circuit as today. Route only that wire, with `routeCircuit(shapedCircuit(now), …)`,
    and take its points. `setGhost({ wire: null, held: wire.id, points })`, keep `latest`, and commit on release.
  - **Overlay:** draws `ghost.points` dashed `6*k 4*k`.
- [ ] **Step 4: Run them, and see them pass,** plus `npx vitest run src/design src/canvas`.
- [ ] **Step 5: Commit** `wip(studio): a dragged end, body or run shows a dashed preview and the wire stays put until release, as Visio's (plan 10 phase 2)`.

### Task 4: The run drag's guide and snap

**Files:** modify `src/design/useWireGestures.ts` and a new pure `src/design/runSnap.ts`; tests in
`src/design/runSnap.test.ts`.

**Interfaces:**
- `export function snapRun(v: number, axis: 'x' | 'y', shown: StudioDocument, own: string, reach: number, allowed: (wireId: string) => boolean): { v: number; at: number | null }`.
  - `v` is the run's coordinate across its own axis: x for a vertical run, y for a horizontal one.
  - The candidates are block edges and centres on that axis, step landing heights (top + 16 … top + 144 every 8, for
    the last or first run only: the caller filters), and parallel runs of other wires where `allowed(id)` is true.
  - Nearest within reach; `at` is the matched coordinate, or null.
- `DesignOverlayProps.runGuide: { axis: 'x' | 'y'; v: number } | null`, drawn as a full-length dashed grey line.

- [ ] **Step 1: Failing tests** (`runSnap.test.ts`):
  - a vertical run 10 flow px from a block's left edge (reach 12) snaps to it;
  - 14 px away doesn't;
  - a parallel run of an allowed wire 6 px away wins over a block edge 9 px away;
  - a run of a disallowed wire (another net: short circuit) is never a target;
  - nothing in reach gives `at: null`, `v` unchanged.
- [ ] **Step 2: Run them, and see them fail.**
- [ ] **Step 3: Implement** `snapRun`. In `startSegment`, apply it to the dragged run's coordinate before
  `dragSegment` (reach = 12 / zoom; `allowed` = the same-net test used by `overlapJudge`), and set `runGuide` through
  the hook's state.
- [ ] **Step 4: Run them, and see them pass,** plus the wire-gesture tests.
- [ ] **Step 5: Commit** `wip(studio): a dragged run shows Visio's alignment guide and snaps to block edges and centres, landing heights and same-net runs within 12 px (plan 10 phase 2)`.

### Task 5: Cursors

**Files:** modify `src/canvas/canvas.css`, `src/design/useWireGestures.ts` (the `resize` state gains `'cross'`),
`src/canvas/WorkflowCanvas.tsx` (class `gesture-cross`), `src/panels/Toolbox.tsx` (the Wire tile drag sets
`document.body.style.cursor = 'crosshair'` while over a canvas); tests in `e2e` (Task 6).

- [ ] **Step 1: Change the CSS:**
  - design-mode node and `.nx-hit.grab` → `move`;
  - `.react-flow__node.draggable.dragging` → `move`;
  - `.studio-canvas.gesture-cross, .studio-canvas.gesture-cross * { cursor: crosshair !important; }`;
  - `.nx-port` in design mode → `crosshair`.
- [ ] **Step 2: Set the gesture classes.** `startEnd`, and the new-wire drag from a port, set `resize` to `'cross'`.
  A body drag keeps `move`.
- [ ] **Step 3: Run** `npx vitest run src/design src/canvas` and `npx tsc -b`.
- [ ] **Step 4: Commit** `wip(studio): Visio's cursors — move for blocks and wires, crosshair while placing an end (plan 10 phase 2)`.

### Task 6: Real-mouse tests, suites, deploy check

**Files:** create `src/WorkflowStudio/e2e/wirelooks.spec.ts` (circuit throwaway, read-only, the same setup as
`guides.spec.ts`).

- [ ] **Step 1: Tests:**
  - a picked wire shows green ends (computed fill `rgb(91, 200, 91)`) and run dots; dragged open, its end is hollow
    (white fill);
  - an end held over a step side: `.drop-ok` outline green, `.design-contact.ok` at the landing point, the cursor
    `crosshair`;
  - an end 9 screen px outside a side is over it, and 12 px outside isn't;
  - while held, the dragged wire's edge has class `held`, its path unchanged, and a dashed `path.design-ghost`; Escape
    restores it, with no draft;
  - a run drag shows the guide line and snaps to a block edge 8 screen px away;
  - a block hover cursor is `move`.
- [ ] **Step 2: Run** `npx playwright test e2e/wirelooks.spec.ts`, then the neighbouring suites (`feedback`, `circuit`,
  `designer`, `toolbox`, `guides`), whose selectors may need the `rect` → circle update (Task 1). Fix the product when
  a rule breaks.
- [ ] **Step 3: Run** `npx vitest run` (all).
- [ ] **Step 4: Side-by-side screenshots** against the Visio shots named in the header.
- [ ] **Step 5: Commit** `wip(studio): real-mouse tests of the wire looks and feedback (plan 10 phase 2)`.
