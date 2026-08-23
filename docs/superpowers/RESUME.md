# Resume prompt — SK_P9 orchestrator branch

Written 2026-08-21. Paste the fenced block below into a fresh session.

This is session scaffolding, not project documentation: it describes where the
work stood at `bd82249` so a fresh session can pick it up without re-deriving
anything. It is committed so it survives `git clean`. Delete it once the branch
lands — a stale resume note is worse than none.

---

```
Continue work on the SK_P9 orchestrator branch.

REPO: C:\Users\UserL\source\repos\SK_P9
BRANCH: processor-sample-discovery (head bd82249, unpushed, ~125 commits ahead of main)

WHAT'S BUILT: src/Orchestrator — a .NET 8 console service, 3 replicas under a
StatefulSet, that mirrors workflow definitions from Redis ("L2") into an in-memory
L1 at startup, keeps a Quartz job per scheduled workflow, and has exactly one
replica (gated on a Kubernetes Lease) fire a workflow's entry steps on its cron.
A RabbitMQ fanout keeps running replicas in step. Design authority:
docs/superpowers/specs/2026-08-20-orchestrator-control-plane-design.md
Also added since: a startup infrastructure preflight in BaseConsole.Core, and
enforced AbortOnConnectFail=false in both the API and console Redis registrations.

TEST GATE: dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
Must be 0 failures, exactly 7 skips, exit 0, 0 build warnings.
Currently: Failed 0, Passed 400, Skipped 7, Total 407.
The 7 skips are Live/, gated on SKP_REALSTACK. Run them with the Redis forward up:
  kubectl -n skp port-forward svc/redis 6380:6379
  SKP_REALSTACK=1 ./src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe     --filter-method "*TheMultiplexerReconnectsAndHydration*"

KNOWN FLAKY (one sighting, 2026-08-23, not yet reproduced):
- A timing-sensitive test in the Console suite reported `failed: 1` on a hermetic
  run and passed on an immediate clean rerun with no code change in between. The
  run that saw it did not capture the test name, so it cannot be pinned yet.
  Recorded here because the only other trace of it is a gitignored task report.
  If you see `failed: 1` on a hermetic run, CAPTURE THE TEST NAME before rerunning
  -- that is the missing piece. Do not assume a single hermetic failure is a real
  regression, and do not assume it is this one either: check the port-forwards
  first (see below), then rerun once.

REPO GOTCHAS THAT WILL BITE YOU:
- --filter is SILENTLY IGNORED by this test runner. Run the whole project.
  --filter-method works for a single test, but only after a bare `--`:
  `dotnet test <csproj> -- --filter-method "*Name*"`. Without it MSBuild rejects
  the switch outright (MSB1001), which is at least loud.
- FakeTimeProvider needs an external pump here: time advances only when something
  reads it, so a loop test that waits on a delay HANGS rather than failing, and
  stalls the whole run. HydrationServiceTests.PumpTime is the worked example.
- Project root namespace `Orchestrator` collides with test namespace
  `BaseApi.Tests.Orchestrator`: a qualified reference inside the test namespace
  fails CS0234. Use global::Orchestrator.X. Usings before a file-scoped namespace
  are fine.
- TreatWarningsAsErrors=true, so an unresolvable <see cref="..."/> fails the build.

WORKING-TREE HAZARD — DO NOT TOUCH:
The repo owner has uncommitted work that must never be staged, committed, edited
or reverted:
  modified  src/BaseApi.Service/Features/Orchestration/OrchestrationServiceCollectionExtensions.cs
  untracked src/BaseApi.Service/Features/Orchestration/Projection/IL2InstanceIndexStore.cs
  untracked src/BaseApi.Service/Features/Orchestration/Projection/L2OrphanSweepService.cs
  untracked src/BaseApi.Service/Features/Orchestration/Projection/L2OrphanSweeper.cs
  untracked src/BaseApi.Service/Features/Orchestration/Projection/RedisL2InstanceIndexStore.cs
  untracked src/tests/BaseApi.Tests/Orchestration/L2OrphanSweeperTests.cs
Always `git add` explicit paths. NEVER `git add -A` or `git add .`.

OPEN ITEMS: none. The five that stood at 4725424 were closed at bd82249 — the
ITopologyDeclarer pin, the spec §11 test list, the WorkflowScheduler evidence
claim, the preflight ping's unobserved shutdown fault, and the k8s probe table.
What is left is the work the spec itself names as out of scope (§12): nothing
consumes `orchestrator-result`, the three reclaim duties are unowned, and
scale-down is undefended.

HOW I'VE BEEN WORKING: subagent-driven development — a fresh implementer per
piece of work, then an independent reviewer against the diff, then a scoped
re-review of any fix round. Controller never fixes code itself. Keep that going.
```

---

## Context a fresh session will not have

Everything below is already true in the code and its comments; this is only here
so the next session does not re-derive it.

### Recent history, newest first

| Commit | What |
|---|---|
| `bd82249` | k8s docs: split the probe table across the three workloads |
| `9642f92` | docs: list the fix wave's tests in spec §11 |
| `7a4f515` | docs: state what the chain test proves about the trigger, and how |
| `4c593e0` | fix: observe the abandoned Redis ping on the shutdown path too |
| `71d7a44` | test: pin ITopologyDeclarer to ConnectionTopologyDeclarer |
| `4725424` | docs: add a resume prompt for the orchestrator branch |
| `47ef56b` | docs: record what each orchestrator probe now means |
| `eed1ebb` | k8s: orchestrator readiness probe, startup budget 60 → 30 |
| `f461971` | feat: report orchestrator hydration through readiness |
| `5fef34c` | fix: claim startup readiness on the loop running, not on hydrating |
| `ba05f21` | fix: ApiRedisConnectionOptions internal, mirroring the console sibling |
| `1ba3009` | fix: force AbortOnConnectFail=false in AddBaseApiRedis |
| `c23038f` | fix: force AbortOnConnectFail=false in AddBaseConsoleRedis |
| `f6905e3` | fix: use the cancellation token, not exception type, to tell shutdown from failure |
| `ad9aefd` | feat: startup infrastructure preflight for RabbitMQ and Redis |
| `726cb8d..b9d3f14` | the orchestrator control plane plan — 10 tasks + a final fix wave |

### Three probe meanings, after the last change

(`k8s/README.md` now carries these per workload rather than only for the
orchestrator; this section is the orchestrator column of that table.)

- `/health/startup` — the process booted and its hydration loop is running. It is
  claimed on the loop's **first beat**, ahead of the topology declare and the L2
  read, so a dependency outage can never fail it. Mirrors the processor, which
  marks its gate ready on its liveness loop's first beat.
- `/health/ready` — this replica has hydrated (backed by `HydrationAdmission.IsOpen`).
  Readiness is where a "no restart will help" condition belongs; a readiness
  failure pulls nothing here, because no Service routes traffic to these pods.
- `/health/live` — `self` plus the two loop heartbeats. **No `live`-tagged check
  touches a dependency**, and that is a rule rather than an accident.

`podManagementPolicy: Parallel` and the readiness probe are load-bearing together:
under the default `OrderedReady`, a readiness-gated pod would block the next
replica's creation and a slow Redis would become a whole-service non-deploy.

### Invariants the whole design rests on

1. The orchestrator **never writes or deletes L2**. `grep -rnE
   "KeyDeleteAsync|StringSetAsync|SetAddAsync|SetRemoveAsync" src/Orchestrator/
   --include=*.cs` must print nothing.
2. **L2 is the source of truth.** L1 is a mirror, rebuilt from L2 on every start.
   Where a message and L2 disagree, L2 wins.
3. A fanout message is an **announcement, not a payload** — a workflow id and
   nothing else. The replica re-reads L2.
4. **No `ProjectReference` to any `BaseApi.*` project** from `src/Orchestrator`.
   `grep -n "ProjectReference.*BaseApi" src/Orchestrator/Orchestrator.csproj` must
   print nothing. (The `InternalsVisibleTo BaseApi.Tests` line is a visibility
   grant, not a reference, and is expected.)
5. The StatefulSet **never scales down** — per-replica queues are durable and a
   removed replica's queue would accumulate forever.

### Deliberately out of scope, not defects

Nothing consumes `orchestrator-result`. A workflow fires its entry steps and stops
there. The result path, the three reclaim duties, and scale-down defence are all
named as gaps in the spec.
