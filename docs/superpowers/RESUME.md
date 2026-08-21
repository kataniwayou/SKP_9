# Resume prompt — SK_P9 orchestrator branch

Written 2026-08-21. Paste the fenced block below into a fresh session.

This is session scaffolding, not project documentation: it describes where the
work stood at `47ef56b` so a fresh session can pick it up without re-deriving
anything. It is committed so it survives `git clean`. Delete it once the branch
lands — a stale resume note is worse than none.

---

```
Continue work on the SK_P9 orchestrator branch.

REPO: C:\Users\UserL\source\repos\SK_P9
BRANCH: processor-sample-discovery (head 47ef56b, unpushed, ~119 commits ahead of main)

WHAT'S BUILT: src/Orchestrator — a .NET 8 console service, 3 replicas under a
StatefulSet, that mirrors workflow definitions from Redis ("L2") into an in-memory
L1 at startup, keeps a Quartz job per scheduled workflow, and has exactly one
replica (gated on a Kubernetes Lease) fire a workflow's entry steps on its cron.
A RabbitMQ fanout keeps running replicas in step. Design authority:
docs/superpowers/specs/2026-08-20-orchestrator-control-plane-design.md
Also added since: a startup infrastructure preflight in BaseConsole.Core, and
enforced AbortOnConnectFail=false in both the API and console Redis registrations.

TEST GATE: dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
Must be 0 failures, exactly 6 skips, exit 0, 0 build warnings.
Currently: Failed 0, Passed 399, Skipped 6, Total 405.

REPO GOTCHAS THAT WILL BITE YOU:
- --filter is SILENTLY IGNORED by this test runner. Run the whole project.
  --filter-method works for a single test.
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

OPEN ITEMS (all small, none blocking):
1. Nothing pins ITopologyDeclarer to ConnectionTopologyDeclarer — a no-op
   registered over it would leave the suite green while restoring a real bug.
   One line, idiom already at OrchestratorHostWiringTests.cs:243.
2. Spec §11 (Testing) doesn't list the tests added by the final fix wave,
   notably the self-rescheduling chain test — the only one proving a workflow
   fires more than once.
3. WorkflowScheduler.cs's "checked rather than asserted" paragraph overstates its
   evidence: ObjectAlreadyExistsException on the JOB proves the job's presence;
   the trigger's presence follows only by also observing the green run never took
   the re-create fallback.
4. StartupPreflightService: on the shutdown path the abandoned Redis ping's fault
   is no longer observed by a ContinueWith. Low; process is exiting anyway.
5. k8s/README.md's "Probes, and why they differ" table is written for the
   processor but reads as generic; its /health/ready row now describes only one
   of the two workloads.

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
