# Handover: SKP Studio, finish plan 3a, then plans 3c and 3b (2026-10-06)

**Start here in a fresh session.** Plan 3a (dock chrome) is mid-execution under
`superpowers:subagent-driven-development`: **Tasks 1–11 are complete and reviewed; Task 12 (deploy)
is waiting for the user's approval.** Resume with:

```
/superpowers:subagent-driven-development docs/superpowers/plans/2026-10-06-skp-studio-03a-dock-chrome.md
```

The skill reads the ledger and resumes at Task 12. **Ask the user before deploying** (it restarts the
`workflow-studio` pod on the shared `desktop` cluster; BaseApi is not touched).

## Where things stand

| Item | State |
|---|---|
| Branch | `feature/path-importer`, no worktree, no merge/PR (user's choice). HEAD `32d7fd1`. |
| Plans 1, 1b, 2 | Done and deployed. BaseApi has validate / live / liveness; the studio (plan 2 page) runs at `localhost:18081`. |
| Plan 2 follow-up | Workflow picker shows the unique entity name `{name}_{version}-{last two id groups}` (`src/model/entityNames.ts`, commit `3934515`), deployed. |
| **Plan 3a** | `docs/superpowers/plans/2026-10-06-skp-studio-03a-dock-chrome.md` (12 tasks). Commits `ca48e74..32d7fd1` (16). Unit 351 pass, typecheck/build clean, e2e 13/13 against the live BaseApi. **Not deployed yet** (the cluster still runs the plan-2 page). |
| SDD ledger (3a) | `.superpowers/sdd/2026-10-06-skp-studio-03a-dock-chrome/progress.md` (git-ignored). Holds the pre-flight table, every ruling, every deferred minor. **Do not delete until 3a finishes.** Also there: `constraints.md`, `reviewer-instructions.md` (reusable reviewer prompt), briefs, reports, review packages. |
| Plan 3c (locked node art + live states) | **Not written.** Next after 3a. |
| Plan 3b (Inspector editing) | **Not written.** After 3c. |
| Spec | `docs/superpowers/specs/2026-10-05-skp-studio-design.md`, amended 2026-10-06 (§5.1 node art, §6.1, §7.1–7.3, §8, §9, §10). |

## Remaining steps for plan 3a

1. **Task 12 (ask first):** `docker build -f src/WorkflowStudio/Dockerfile -t workflow-studio:local .`,
   `kind load docker-image workflow-studio:local --name desktop`,
   `kubectl -n skp rollout restart deploy/workflow-studio`, rollout status. The port-forward on 18081
   reconnects by itself after a few seconds (a "connection refused" right after a restart is that gap).
2. **Visual check (owed since Task 10):** open `http://localhost:18081` in the browser (chrome-devtools
   MCP with an `isolatedContext` works; the Playwright MCP browser may be locked by another session),
   open two workflows, select entities, float/auto-hide a pane, compare with mockup v49/v50 chrome.
   Then open it for the user with `Start-Process`.
3. **Final whole-branch review** on the most capable model: package `67b5611..HEAD` with
   `scripts/review-package`, point it at the ledger's deferred minors and rulings. One fix wave, one
   scoped re-review, adjudicate residuals. Then list every `Ruling:` line to the user, delete the
   workspace, update memory.

## Rulings and notable fixes during 3a (full list in the ledger)

- Task 5 (dock logic): window actions are no-ops on closed panes; docking skips auto-hidden home groups
  (docks to a new visible group instead of un-hiding); split document groups are pruned on save; saved
  layouts are fully validated; a dockview `fromJSON` failure re-opens the documents (and Task 7 later
  disposes dockview's parked leftovers so canvases are not shown twice).
- Task 6: menus and rail tabs keyboard-accessible; AutoHide uses its own `ownerDocument`.
- Task 7: DockShell owns the Esc order (switcher → menu/picker → flyout → clear selection); overlays are
  mutually exclusive; keys in a pop-out act in that pop-out.
- Task 9: live poll only when the panel is visible and the document is loaded; resets to "checking" when
  hidden.
- Task 10: stable `api`; per-open token guards a stale load after close+reopen.
- Task 11: e2e covers the §9 32/8 px grid rule, real pop-out fonts, overlays above a floating group via
  `elementFromPoint`, and a read-only guard (no non-GET except the validate POST).
- Cosmetic: some commits carry a `Claude Sonnet 5.5` trailer instead of `Claude Opus 5.5`.

## Decisions made on 2026-10-06 (all in the spec)

- **Build order:** 3a dock → **3c node art** → 3b Inspector editing → 4 canvas editing → 5 richer editors
  → 6 toolbox → 7 junctions.
- **Inspector (§7.1):** edits each entity's DTO metadata only, never graph structure; GET/PUT per entity;
  drill-downs step → processor → schema and step → assignment; assignment add (POST + workflow PUT link)
  / edit / unlink from this workflow; Name and Version never empty; server is the validator (cron, semver,
  hashes, JSON); shared-entity effects are the operator's responsibility; last write wins; Start/Stop
  disabled for now.
- **One JSON Schema validator:** BaseApi's JsonSchema.Net 9.2.1, draft 2020-12, `$ref` fetching off. No
  Ajv in the browser. Its 400 says only "Definition is not a valid JSON Schema (draft 2020-12)." (the user
  was offered returning details; no answer yet).
- **Locked node art (§5.1):** `.superpowers/brainstorm/385-1791189446/content/skp-studio-node-art-final.html`
  + mockup `skp-studio-dock-v50.html`; the gallery wins where they differ. Exact v49→v50 diff with line
  refs: `content/v49-v50-diff.md` — **read it when writing plan 3c**. Only geometry change: cache
  160×160 at hub x−80, stacked 192 apart. Processor health from `/processors/liveness`
  (healthy/unhealthy/undetermined), workflow started + flowing pulses from `/orchestration/live`. The
  mockup's "Colours" switch does not ship. v50's dock chrome is identical to v49's.
- Plan 3a's planner decisions the user accepted: auto-hide hides a whole tab group; `proportionalLayout:
  false`; F5/Shift+F5 show a toast; `?workflow=` URL dropped; no "new document group" menu items; pop-outs
  not in saved layouts; layout saved only via Window › Save.

## Known gaps for later plans

- BaseApi's delete 422 names one FK column, not the referencing rows (spec §8); the toolbox slice needs
  a usages read.
- Plain `PUT` has no stale check (last write wins); per-entity `PUT /assignments/{id}` edits a shared row
  in place (no copy-on-write, unlike `PUT /graph`).
- Router: forward gaps of 8–23 px with `sy ≠ ty` route as a U through both blocks (only stored layouts
  produce them; dragging will). Fan-in > 8 spills below the step; fan-out ≥ 9 departs outside the
  processor (plan 7).
- `npm run gen:api` needs `dotnet tool restore --add-source https://api.nuget.org/v3/index.json` once on
  a clean machine (the swashbuckle CLI is not in the offline feed).

## Things the executor must know

- Run `npm run …` / `npm test` **in PowerShell** (in Git Bash they print nothing and exit 1); `npx` works
  anywhere. `src/WorkflowStudio/.npmrc` has `legacy-peer-deps=true` (npm 10.9.2 crash workaround); after
  dependency changes run `npm ls --all --legacy-peer-deps=false`.
- e2e: `npm run e2e` needs BaseApi on `localhost:18080`; check `./k8s/port-forward-realstack.ps1 -Status`.
- Backend tests: build `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo`, run
  the exe with fully qualified `--filter-class`; never `dotnet test`.
- Kind cluster is `desktop`. Bash heredocs with apostrophes/backticks fail: use the Write tool.
- Do not touch: `.wf-restore.json`, `tools/simulate-*.py`, `.playwright-mcp/`, `docs/HANDOVER-*.md`.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## How the user works

- Answers in their own words; "confirm" means verify against the code or the running thing.
- Wants honest reports: what was built, what was tested, what was not.
- Approves visual work by trying it (open pages with `Start-Process`).
- Asks before every deploy; approves each one explicitly.
