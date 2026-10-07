# Handover 2026-10-07: SKP Studio plan 4 (canvas designer trial)

Branch `feature/path-importer` (not pushed, not merged). Studio deployed to the dev cluster as
`workflow-studio:local` in ns `skp`; bundle `index-DqyGNXBe.js`. Port-forward studio `localhost:18081`,
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

## Built: end squares (`eff225c`, deployed)

A selected wire's ends are squares (`<rect class="design-handle end" data-end=…>`, accent fill) replacing the
green end dots; cursor `move`, kept while an end is dragged (`gesture-move`). Run squares unchanged. Awaiting the
user's trial verdict.

## Built: user trial round 2 (`b645a82`, deployed)

User: squares perfect; end cursor two-headed (now `ew-resize`, kept while dragged); dragging an end moves the
wire itself, right-angled from its fixed end to the pointer (`route()`), no sloped dashed ghost (option b,
re-attach on drop kept); a run dragged onto a step is pushed off it (`clearRun`) and every other run detours
around steps (`clearPath`, a small Dijkstra on the clearance lines, `layout/detour.ts`); the detour is saved
with the shape. A new wire's ghost is right-angled and solid too.

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
