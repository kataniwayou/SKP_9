# Handover: SKP Studio, execute plan 1b, then plan 2 (2026-10-05)

**Start here in a fresh session.** Run plan 1b with the `superpowers:subagent-driven-development` skill. Then run plan 2 the same way. The user chose subagent-driven for plan 2, and the controller recommended running plan 1b back to back with it.

**Before you dispatch anything:** the user has not yet confirmed plan 1b. Ask them to confirm it in one line, then go.

```
/superpowers:subagent-driven-development docs/superpowers/plans/2026-10-05-skp-studio-01b-validate-live-liveness.md
```

Plan 2 comes afterwards: `docs/superpowers/plans/2026-10-05-skp-studio-02-read-only-canvas.md`.

## Where things stand

| Item | State |
|---|---|
| Branch | `feature/path-importer`. No worktree. The user chose to keep the branch as is, with no merge or PR. It is 631+ commits ahead of `main` because it carries the earlier path-importer work. |
| Plan 1 (backend `Layout`, `GET`/`PUT /layout`, `GET`/`PUT /graph`) | **Done**, commits `3c48245..6ad235a`. Hermetic suite 1950/0. Live Postgres tests 6/6. Deployed to the dev cluster. |
| Plan 1b (validate, live, liveness) | **Written**, commit `15d4eb3`. 6 tasks. Not started. |
| Plan 2 (read-only canvas, new `src/WorkflowStudio`) | **Written** in `b400d3c`, revised in `22f19b5` and `15d4eb3`. 9 tasks. **Depends on plan 1b being deployed.** |
| Spec | `docs/superpowers/specs/2026-10-05-skp-studio-design.md`. Approved and amended three times on 2026-10-05. §4.4 (validate and status reads) is new. |
| Mockup | **v49, approved**: `.superpowers/brainstorm/385-1791189446/content/skp-studio-dock-v49.html` (gitignored). Source and `build.py` are in `../source/`; `.v46/.v47/.v48.bak.html` backups are beside it. |

## Decisions made in the last session (all already in the spec)

- **No start rule is re-implemented in the frontend.** Cycles, missing steps, schema edges, payloads and processor liveness come from BaseApi's `POST /workflows/{id}/validate`. Plan 1b gives the gates a collect mode; the dry run applies the draft with the real saver inside a transaction that is always rolled back.
- **The browser never reaches Redis or Postgres.** The studio is static files served by nginx, which only passes `/api/` through to BaseApi. BaseApi is the only coupling. The UI polls `GET /orchestration/live` for workflow status and reads `GET /processors/liveness`.
- **Mockup v49 changes:**
  - Grid: the bright dashed 32 px line is gone.
  - Inspector: read-only text is shortened with a tooltip, and a "show all" toggle reveals Id and the created/updated fields.
  - Toolbox: **+ New** step, processor and cache, and **✕** delete, which shows the 422 with the list of referencing rows. A new step's processor is picked by `Messaging.Contracts.EntityNames.Format`: `{name}_{version}-{last two id groups}`. The new-processor form has **no** schema pickers; the user rolled those back.
- **Plan 2 font:** IBM Plex Sans Condensed, as in the mockup. **Plan 2 assignment badge:** a key count. Junctions wait for plan 7.

## Things the executor must know

- **Test runner:** build with `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo`, then run `src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "<FQN>"`.
  - Use **fully-qualified** names. A bare name matches 0 tests and exits 0.
  - Never use `dotnet test`.
  - Full hermetic suite: `--filter-not-trait "Category=RealStack" --filter-not-namespace "BaseApi.Tests.Live*"`.
  - Warnings are errors.
- **The kind cluster is named `desktop`.** Load images with `kind load docker-image baseapi-service:local --name desktop`. The README's bare `kind load` fails with "no nodes found".
- **Deploy (plan 1b Task 6, plan 2 Task 9).** Ask the user first, because it restarts or changes the shared dev cluster.
  - Then: `docker build -f src/BaseApi.Service/Dockerfile -t baseapi-service:local .`, `kind load … --name desktop`, `kubectl -n skp rollout restart deploy/baseapi-service`, `kubectl -n skp rollout status deploy/baseapi-service`.
  - The pod applies migrations on startup.
- **Port-forwards:** `k8s/port-forward-realstack.ps1` is supervised and reconnects after a pod restart. Check it with `./k8s/port-forward-realstack.ps1 -Status`. The user asked the controller to run it rather than doing it themselves. Live tests run with `SKP_REALSTACK=1`; BaseApi answers on `localhost:18080` and Redis on `6380`.
- **Machine quirks:**
  - Bash heredocs containing apostrophes or backticks fail, so write files with the Write tool.
  - The Playwright MCP blocks `file:` URLs. To test the mockup, serve the content folder with `python -m http.server`.
- **Do not touch these untracked files:** `.wf-restore.json`, `tools/simulate-approved-feed.py`, `tools/simulate-unapproved-feed.py`, `.playwright-mcp/`, `docs/HANDOVER-*.md`. Stage only the files a task names.
- **Commit trailer:** end commit messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Some subagents wrote "Sonnet"; that was ruled cosmetic.
- **Skills:** `react-flow-skill` is installed, for plan 2. `tanstack-table` is not; the user must type its two `/plugin` commands, and it is needed only for plan 4.

## Follow-ups parked for later plans (they live only here and in memory)

- **Plan 3:**
  - send `updatedAt` strings back exactly as received, never through a JS `Date`;
  - parked steps are not in the save response, so refresh their stamps after a save;
  - a 409 can come from a layout or diagram save, not only a graph edit.
- **Before plan 4:** a schema patch bump can duplicate a name and version across processors that share a schema. Bump from the highest existing version.
- **Still open:**
  - request list sizes are not capped;
  - a request that is both stale and invalid gets 409 before 400;
  - a `\u0000` in a layout causes a database error instead of a 400.

## How the user works

- They answer in their own words rather than picking from options.
- "**confirm**" means verify against the code or the running thing.
- They want honest reports: what was built, what was tested, and what was not.
- They approve visual work by trying it. Open a mockup or page for them with `Start-Process`.
