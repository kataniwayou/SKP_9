# Handover: SKP Studio, execute plan 1 (2026-10-05)

**Start here in a fresh session.** Run plan 1 with the `superpowers:subagent-driven-development` skill. The user chose subagent-driven, and the plan has been written and reviewed by the user.

```
/superpowers:subagent-driven-development docs/superpowers/plans/2026-10-05-skp-studio-01-backend-graph-save.md
```

(The skill is `superpowers:subagent-driven-development`. GSD commands use hyphens, never colons; see memory.)

## What exists

| Artifact | Path | State |
|---|---|---|
| Spec | `docs/superpowers/specs/2026-10-05-skp-studio-design.md` | **Approved.** Commit `01de301`. §5 was amended in `7e0138b` (Visio connector editing, positioned junctions, lit two-tier grid, grid-aligned sizes) |
| Plan 1 | `docs/superpowers/plans/2026-10-05-skp-studio-01-backend-graph-save.md` | Written, commit `fcd5287`. Execution method: **subagent-driven** |
| Reference mockup | `.superpowers/brainstorm/385-1791189446/content/skp-studio-dock-v46.html` | Gitignored. Source: `../source/skp-studio-mockup.template.html`, rebuild with `python build.py vNN` |
| Old design handover | `docs/HANDOVER-2026-10-05-skp-studio-design.md` | Superseded, kept for history |

- **Branch:** `feature/path-importer`. Plan 1 builds on it; no worktree has been made.
- **Untracked files not to touch:** `.wf-restore.json`, `tools/simulate-approved-feed.py`, `tools/simulate-unapproved-feed.py`, `.playwright-mcp/`.

## Plan 1 in one paragraph

BaseApi only, no frontend. It adds:
- a nullable jsonb `Layout` column on workflows, with `GET`/`PUT /api/v1/workflows/{id}/layout`;
- `GET /workflows/{id}/graph`, which wraps the existing `WorkflowGraphLoader`;
- an atomic `PUT /workflows/{id}/graph` built from the existing validators and Mapperly mappers;
- a refactor that moves the junction sync into `StepJunctions` / `WorkflowJunctions` helpers, shared by the services and the saver.

Concurrency is checked by `updatedAt` and a stale entity gives a 409 that names it. Assignments resolve per (workflow, step): update in place, copy when shared, create, or unlink and delete the orphan. Schema edits insert a new version and re-point the slot. Everything commits in one `SaveChangesAsync`, and EF orders the writes by foreign key.

There are 9 tasks. Tasks 1–8 are hermetic (EF InMemory). **Task 9 needs the live cluster.**

## Things the executor must know (all in the plan's Global Constraints; repeated here because they bite)

- **Test runner:** build with `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo`, then run `src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "<FULLY.QUALIFIED.Name>"`.
  - A bare class name matches 0 tests and exits 0, which looks like a pass.
  - Do not use `dotnet test`.
  - Full hermetic suite: `--filter-not-trait "Category=RealStack" --filter-not-namespace "BaseApi.Tests.Live*"`.
- **The build treats warnings as errors.** Mapperly RMG codes are errors too, so the new `WorkflowEntity.Layout` needs ignore attributes on all three mapper methods. Private fields are named `_camelCase`.
- **`BaseApi.Core` is a NuGet package.** Plan 1 does not change it. If anything does, run `bash scripts/pack-all.sh` first.
- **Migration:** `dotnet ef migrations add AddWorkflowLayout --project src/BaseApi.Service/BaseApi.Service.csproj --output-dir Persistence/Migrations`. The `dotnet-ef` tool is in `~/.dotnet/tools`. The generated `Up` must contain only the one `AddColumn`.
- **Task 9 (live Postgres):**
  1. `docker build -f src/BaseApi.Service/Dockerfile -t baseapi-service:local .`
  2. `kind load docker-image baseapi-service:local`
  3. `kubectl -n skp rollout restart deploy/baseapi-service`
  4. The **user** must run `k8s/port-forward-realstack.ps1` in their own window.
  5. Then run the tests with `SKP_REALSTACK=1`.

  **Ask the user before deploying**: it restarts the shared dev BaseApi.
- **Shell quirk on this machine:** Bash heredocs that contain apostrophes or backticks have failed twice (`unexpected EOF`). Write scripts with the Write tool, then run them.

## How the user works

- They answer in prose rather than picking from options.
- "**confirm**" means *verify against the code or the running thing*, not "agree".
- They want honest reports: say what was not built or not tested, with the evidence.
- They approve visual work by trying the mockup. Open a version for them with `Start-Process "<path to .html>"` from PowerShell.

## After plan 1

- Plans 2–7 are one per slice: read-only canvas, editing (including §5.5 connector editing), inspectors, dock chrome, toolbox, then junctions and polish. Each is written with `superpowers:writing-plans` **after** the previous slice has landed. The roadmap is at the end of plan 1.
- **Before plan 2:** ask the user to approve installing the coding-reference skills `framara/react-flow-skill` (`npx skills add framara/react-flow-skill -g`) and `tanstack-table` (`/plugin marketplace add tanstack-skills/tanstack-skills`, then `/plugin install tanstack-table@tanstack-skills`). They have not approved this yet.
- **Deferred by decision:** the dockview-enterprise drag compass (we stay on dockview-core) and processor liveness in the editor.

## Background note

The brainstorm companion server was stopped by Claude Code when the machine ran low on memory. It is not needed: the mockups open directly as files. Do not restart it unless asked.
