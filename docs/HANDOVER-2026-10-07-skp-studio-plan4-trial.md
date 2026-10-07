# Handover 2026-10-07: SKP Studio plan 4 (canvas designer trial)

Branch `feature/path-importer` (not pushed, not merged). Studio deployed to the dev cluster as
`workflow-studio:local` in ns `skp`; bundle `index-B3m5deJC.js`. Port-forward studio `localhost:18081`,
BaseApi `localhost:18080` (restart after every redeploy: `kubectl port-forward -n skp svc/workflow-studio 18081:8080`).

## Where we are

- **Plan 4 = a no-save designer trial.** Spec `docs/superpowers/specs/2026-10-07-skp-studio-04-canvas-designer-design.md`,
  plan `docs/superpowers/plans/2026-10-07-skp-studio-04-canvas-designer.md`. Built subagent-driven, 10 tasks plus a
  final review fix wave: commits `ebf0e91..c282cdd`. Graph designing only: no BaseApi writes, no entity logic,
  no Toolbox. The design draft lives in the browser session; Discard design drops it.
- **Trial fixes after deploy** (user feedback):
  - `4ea898b` run squares show a double-arrow cursor (↕ horizontal run, ↔ vertical run), kept while dragging.
  - `7fce728` handles, drop outlines, ghost line and connection points keep a fixed on-screen size at any zoom; a
    label next to the pointer says why a drop is refused ("would make a loop", "already wired", "same step",
    "not a step") or what it does ("re-attach here", "connect here"); a run square an end dot would cover is not
    drawn. Root cause of the user's "I drag the green dot … nothing happens": at the fitted 28% zoom the red
    refusal outline was sub-pixel; the drop was refused (often a cycle), not broken.
  - `51d185d`, `4b09299` spec §5.2 records the user's junction rule (below).
- **Tests at HEAD:** `npx tsc -b` clean; Vitest 719/719; Playwright 46 passed + 2 expected `art.spec.ts` skips;
  `e2e/designer.spec.ts` 9/9 (read-only guard on every test).

## Confirmed with the user, NOT built yet (next step; ask "build it?" first, the user had not said yes)

Wire handles, shown only when a wire is **selected** (clicked), not on hover:
- a square in the middle of each run (as now; drag moves the run; cursor ↕ / ↔);
- a **square at each end** of the wire, **replacing the green end dots**; dragging an end square detaches that
  end (drop on a step, or the hub for the start, re-attaches; elsewhere it snaps back); cursor over an end square
  is the **four-way arrow** (`cursor: move`).
Where: `src/WorkflowStudio/src/design/DesignOverlay.tsx` (end `<circle>`s → `<rect>`s, keep classes
`design-handle end` and `data-end`, sizes in screen px via `k = 1/zoom`, keep the `clearOfDots` rule for run
squares), `src/canvas/canvas.css` (`.design-handle.end` fill/cursor), tests in
`src/design/useWireGestures.test.tsx` and `e2e/designer.spec.ts` (selectors use `.design-handle.end[data-end=…]`).

## Junctions (plan 7) — wait until the user approves the designer

User rule, recorded in main spec §5.2: wires of the **same colour (same entry condition)** may merge, or one may
end on another's body at a contact point, **regardless of origin or target step**. A wire's colour is its
target's entry condition (`layout/wires.ts:79`), so merged wires into different steps need the shared line to
branch again to each target. **End on a step → always an arrow head; end on a wire → always a circle point.**
A junction point gets the four-way-arrow cursor too.

## Open decisions for the user

- Branch: merge to main / push + PR / keep (asked; not answered).
- Trial verdict on option "a" (detach by dragging an end, snap back on empty canvas).
- After the trial: Save (PUT /layout for positions and shapes, PUT /graph for wiring), validate on the draft?

## Deferred (can wait; from the final review triage)

Shared dock `Menu` has no Escape-to-close (Escape with the Reset route menu open clears the selection); picks
are not pruned on a `refreshed` document; a lost pointerup could leave a gesture ref set and block canvas keys
until the next press; `dragSegment` allows crossed/backward bends; slid landings are unknown to
`computeLandings`; `sameList` is order-sensitive (re-attaching back leaves a non-empty draft); pop-out drag
headroom (56 fps, main thread 87% busy in production).

## Machine notes

Run npm scripts from PowerShell (Git Bash `npm run` prints nothing); `npx vitest run`, `npx tsc -b`,
`npx playwright test` work anywhere from `src/WorkflowStudio`; delete `tsconfig.tsbuildinfo` after `tsc -b`.
Deploy: `docker build -f src/WorkflowStudio/Dockerfile -t workflow-studio:local .` →
`kind load docker-image workflow-studio:local --name desktop` → `kubectl -n skp rollout restart deploy/workflow-studio`.
Stopping a background `npx vite` task leaves the node process running: kill it by its command line.
Untracked, not ours: `.playwright-mcp/`, `.wf-restore.json`, `tools/simulate-*.py`.
