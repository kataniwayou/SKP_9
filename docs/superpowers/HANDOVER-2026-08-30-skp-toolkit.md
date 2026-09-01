# Handover: the SKP toolkit (phases 1–3 partial)

Date: 2026-08-30 (verification section and phase-3 status updated 2026-08-31;
catalog re-grounded against the post-split system 2026-09-01 -- see the last section)
Branch: `topology/advance-materialize-consistency`
Spec: `docs/superpowers/specs/2026-08-30-skp-skill-bundle-design.md`
Plan: `docs/superpowers/plans/2026-08-30-skp-toolkit-ground-and-compile.md`

## What this is

`skp-toolkit/` — a stdlib-only Python package that compiles this system's C#
into a capability catalog a **small offline model** queries instead of recalls.
Ships to an offline machine running Claude Code. Governing principle: **lookup,
not recall**, because a small model's characteristic failure is confabulation —
asked something it does not know, it invents a plausible answer and reports it
confidently.

**515 tests.** `python -m unittest discover -s tests -t .` from `skp-toolkit/`.

## Commands that exist

| Command | Does |
| --- | --- |
| `skp init` | Resolves givens, writes the memory folder, compiles the catalog, probes seven targets |
| `skp map` | Two-axis lookup: `--component`, `--intent`, `--answers` |
| `skp doctor` | Source drift / hand-edited generated files / reachability — each with its own remedy |
| `skp verify` | Takes the catalog's claims to the running system. `--component`, `--skips`, `--probe-writes`, `--probe-runs` |
| `skp observe` | Current state and windowed quantities |
| `skp investigate` | The nine-rung cut-point ladder + case files |
| `skp author` | `validate` (runs the system's own five gates) and `apply` (a spec file, in foreign-key order) |
| `skp operate` | `start`, `stop`, `freeze`, `verify` — each control command ending in a read-back |

**Phase 3 is complete** (2026-08-31). Not yet built: the developer verbs
(phase 4), the skills themselves (phase 5).

### The seven run verdicts

`skp operate verify` returns exactly one, and the rule is **one verdict per
distinct remedy** — the same ruling that keeps NOT_OBSERVED, REFUTED and
UNVERIFIABLE apart in `skp verify`. The resolution ORDER is load-bearing:
`frozen` is checked first because a frozen workflow is not dispatching, and
reporting that as `wedged` would send an operator to redeploy a healthy
processor.

`frozen` -> `parked-at-processor-{id}` -> `wedged-at-processor-{id}` ->
`failed-at-{stepId}` -> `completed` -> `running` -> `never-started`

Two of them name a **processor**, not a step, and that is deliberate: queues are
per-processor and `steps.processor_id` is many-to-one, so naming a step there
would invent precision the data does not have. `failed-at-{stepId}` really is a
step — it is read from the Elasticsearch `StepId` attribute.

A per-processor dead-letter queue is **shared**, so a `parked-at-processor-*`
message may belong to a different workflow using the same processor. The verdict
says so in its own evidence; confirm with
`skp investigate parked --processor <id>`.

## Running against the live cluster

Cluster is **kind**, node `desktop-control-plane`, despite the kubectl context
being named `docker-desktop`. Namespace `skp`. Port-forwards are supervised and
on **offset** ports (`k8s/port-forward-realstack.ps1`):

```
baseapi 18080   prometheus 19090   elasticsearch 19200   grafana 13000
rabbitmq 5673   redis 6380         otel 14317 / 18889
```

```bash
cd skp-toolkit
python -m skp init --home <TEMP OUTSIDE THE REPO> --source-root ../src --project skp \
  --endpoint baseapi=http://localhost:18080 \
  --endpoint prometheus=http://localhost:19090 \
  --endpoint elasticsearch=http://localhost:19200
python -m skp verify --home <same> --probe-writes --probe-runs
```

**Never write a memory folder inside the repo** — `.gitignore` does not cover it.

## Facts that cost real time to discover

- **Postgres tables are snake_case**, not the `DbSet` property names.
  `EFCore.NamingConventions` + `.UseSnakeCaseNamingConvention()`. The extractor
  detects the convention rather than assuming it.
- **The Elasticsearch data stream is `logs-generic.otel-default`** — a dot, not
  a hyphen. ~10M documents, 17 days retention. Bound every query.
- **`attributes.CorrelationId` renders "N"** (32 hex, no hyphens); every other id
  renders "D" (hyphenated). Same document, two formats. Get it wrong and queries
  silently return nothing.
- **`instance` is the scrape target, not the replica.** Per-replica needs
  `service_instance_id`.
- **OTel → Prometheus names** gain a *unit* suffix before the type suffix
  (`pipeline.queue.wait` → `pipeline_queue_wait_seconds_bucket`). Missing this
  made 9 of 16 instruments read as absent.
- **`role` = leader|follower** rides five instruments via
  `PipelineAmbientTag.AppendTo(ref tags)` — invisible to a literal tag scan.
- **A template's em dash arrives transformed** through the OTel pipeline; exact
  `term` matching finds zero. Use a prefix match (`investigate._original_format_filter`).
- **Liveness `interval` is whole seconds** on the wire, not milliseconds.
- **`PUT /api/v1.0/steps/{id}` is a FULL-REPLACE DTO.** A partial body
  `{"entryCondition": 5}` is rejected with HTTP 400 naming `Name` and `Version`
  as required. `skp operate freeze` therefore does GET -> change one field ->
  PUT the whole object back. This cost a live debugging cycle; the unit tests
  could not see it.
- **`Elastic.search()` already unwraps `_source`** (`clients/es.py`) — it
  returns `[hit.get("_source", {}) ...]`. Reading `hit["_source"]["attributes"]`
  yields `{}` on every hit and makes every Elasticsearch-derived observation
  silently empty.
- **There is no dry-run for workflow validation.** All five gates run before any
  side effect, so a rejection is free — but a graph that passes every gate is
  STARTED by the same call. That is why `skp author validate` needs
  `--confirm-start`, and it is a property of the API, not a toolkit choice.
- **`--home` must come BEFORE the subcommand** (`skp operate --home X verify`,
  not `skp operate verify --home X`). It is declared on each group's own parser;
  the wrong order exits 1 with "unrecognized arguments".

## Verification status: 141/141 (100%), no ceiling

`skp verify --probe-writes --probe-runs`, live. Was 135/135 on 2026-08-31; the six
surfaces added on 2026-09-01 are all confirmed against the running system. The verb
prints `no refutations — every checkable claim is confirmed or legitimately not
observed`, and the ceiling clause is gone because nothing is refuted and nothing
is permanently excluded.

**This 100% is perishable, and that is the most important sentence here.** Three
of the claims are Elasticsearch templates that only exist because a fault was
injected to produce them (recipe below). Elasticsearch retains ~17 days. Around
**2026-09-17** those records age out and the ratio falls back to 138/141 unless
the injection is repeated. A 100% that expires without anyone noticing is exactly
the kind of quiet lie this toolkit exists to prevent — so read the date, not just
the number.

How the previous three residuals were closed:

1. **The 2 REFUTED were a real system defect, and the system was fixed, not the
   catalog.** All 23 `steps` rows pointed at `d033b408`; nothing referenced the
   two accused processors, which were superseded registrations left behind by
   `uq_processor_source_hash` on each SourceHash repoint. Both were deregistered
   through `DELETE /api/v1/processors/{id}` (the product's own path, not SQL),
   and the 14 orphan queues — each verified empty with zero consumers first —
   were deleted. `processor-d033b408….dead` holds a parked message and has a
   matching row; it is not an orphan, leave it.
2. **`redis.KeeperProbe` was deleted, not excluded.** The dead C# method is gone
   from `L2ProjectionKeys`, and with it the annotation, the `_KEEPER_PROBE_ID`
   special case in `check_redis`, and its two tests. Its NOT_OBSERVED message had
   asserted "grepped across src/**/*.cs; only its own definition matches" — false
   the moment the definition went, so it had to go too. The generic
   `PERMANENT EXCLUSION` machinery in `render_report` stays and is still tested;
   no surface carries the marker today. Catalog was 135 there; it is 141 now.
3. **`redis.ExecutionData` was a fixable race, not an inherent one.** Measured on
   the cluster, the delay from `200 OK` on `orchestration/start` to the first
   `skp:data:*` key was **2.39s, 9.98s and 8.83s** — against a probe window of
   exactly `20 × 0.5s = 10s`. The worst case sat *on* the deadline, so the same
   command reported CONFIRMED or NOT_OBSERVED on an unchanged system. Now
   `1200 × 0.05s` = 60s, six times the measured worst case. Window was the bug;
   resolution was secondary.

### Reproducing the three Elasticsearch templates

The named chaos scenarios **do not** produce them, and it is worth knowing why
before spending a morning on it. `FaultWitness` matches heal templates with
"one of" semantics (`Expected one of: …`, `FirstOrDefault`), so `ConsumptionAdmitted`
alone satisfies the Rabbit heal and `ConnectionRecovered` never has to appear.
`RabbitUnavailable` and `RedisWipe` both pass green while all three templates
stay at zero. That is sound test design — either record proves the fault healed —
but it means a passing scenario is not evidence that every template in its list
was emitted.

What actually produces them, against a **drained** system:

- **`ConnectionRecovered`** — `rabbitmqctl close_all_connections` under load.
  Scaling the broker to zero does *not* work: the app rebuilds its own connection
  (`broker connection open as {ClientName}; topology declared`) instead of letting
  the client library recover it, so `RecoverySucceededAsync` never fires. The
  connection must be severed while the broker stays **up**.
- **`EntryAbsentDuplicate`** — the same connection severing. Killing the consumer
  channel mid-flight forces redelivery, and the redelivery finds the entry key
  already reclaimed.
- **`SendFailedReturning`** — the hard one. It needs a publish to fail *inside* a
  `GatedQueueConsumer` handler, which severing cannot do (it kills the consuming
  channel too, so the handler never reaches its send). The recipe: put a
  `max-length:1, overflow:reject-publish` policy on `orchestrator-result`, scale
  processors to 0 and let a backlog build in `processor-{id}`, scale the
  orchestrator to 0 so the result queue stops draining, then scale processors
  back up. They drain the backlog, every outcome publish is rejected, and the
  template fires in the hundreds. Clear the policy and restore both workloads
  afterwards.

**`skp verify --probe-runs` starts a workflow and never stops it.** The chaos
scenarios refuse to start on a firing system (`N entry dispatch(es) in the last
40s`), so a verify run will block the next chaos run until the workflow is
stopped and drained. Stop every workflow via `POST /api/v1.0/orchestration/stop`
and wait for a quiet 45s window first.

## How this build actually went — read this before trusting anything

Fifteen-odd defects shipped, and **every one had the same shape: something that
disappears, or reports success, without ever being able to fail.** Truncated
template text. Two queue ids collapsing into one. Annotation files overwriting
each other. A probe swallowing the message it existed to emit. A duplicated test
class name that silently disabled the guard for an already-fixed bug. A 404
classified by route shape rather than the server's answer.

Three of them were invisible to *every* source review, because the catalog was
internally consistent, fully covered, zero problems — and factually wrong about
the running system. `skp verify` exists because of those three.

**So: when reviewing work here, hunt for the check that cannot fail.** And prefer
running against the live cluster over reading code; source is not the system.

## Rulings that are load-bearing

- **Value domains only where const-declared.** `route={fanout|queue}` comes from
  consts; `outcome`/`disposition` are inline and got no extracted domain, only
  annotation prose. An incomplete domain presented as complete makes a model
  treat a valid value as invalid.
- **`cluster_url` is derived, asserted, and enforced in `ClusterClient`** — not
  in `doctor`, so every verb built on `build_clients` inherits the check.
  Normalised before comparing (trailing slash, default port, localhost/127.0.0.1).
- **`skp verify` is read-only by default.** `--probe-writes` is opt-in and sends
  deliberately invalid bodies with random guids; a 2xx is REFUTED-with-warning,
  never a pass. Row counts proven identical before/after.
- **NOT OBSERVED, REFUTED and UNVERIFIABLE are three different verdicts.**
  Collapsing them makes the verb cry wolf and be ignored.

---

## Re-grounding against the post-split system (2026-09-01)

Twenty commits landed between the phase-3 handover and this section. **Two touched
a file the toolkit tracks; eighteen did not**, and the drift lock can only see the
two. What the other eighteen changed had to be found by reading commits and by
reading the running system.

### What the completeness check caught by itself

The 2026-08-31 advance/materialize split added `ProcessorQueues.Post` and
`PostDead`, and `skp init` refused to compile until both were annotated. Working
as designed.

### What nothing caught

- **`Messaging.Contracts/OrchestratorFanout.cs` was not in `SOURCE_MAP`.** Six
  live queues and two exchanges — `orchestrator-fanout`, `orchestrator-fanout-dlx`
  and the three per-replica `orchestrator-control.{instanceId}` pairs — had no
  catalog id at all. The coverage check could not report this: it enumerates
  surfaces from the files `SOURCE_MAP` lists, so an unlisted contract file is not
  an uncovered surface, it is not a surface at all. Section 6.3 of the design names
  these queues explicitly, which is how far a promise gets without a reader. Found
  by running `rabbitmqctl list_queues` and counting.
- **`pipeline.process.start.timestamp` carried an instruction that is false.** The
  annotation said "changes() is the whole query" and "POD_NAME identity is what
  keeps a restart on the same series". Measured over 12h on 2026-09-01:
  `changes()` returns **0 across all 23 processor pod-name series while 21 starts
  had happened**, and 0 across 10 baseapi series against 9 starts. On a Deployment
  every restart mints a new pod name, so a restart arrives as a NEW series and
  neither `changes()` nor `resets()` can observe a series being born. The range
  form is equally wrong the other way: on the orchestrator StatefulSet it reads 6
  against `changes()`' true 29. **The workload kind decides the query**, and an
  instant read in place of `max_over_time` loses every replica that died inside
  the window (2 against 21, same data).
- **Four verbs silently under-read the new topology.** `operate verify` parsed
  `processor-<guid>-post.dead` into the id `<guid>-post`, matched no row, and
  skipped it — so a parked branch fell through to `wedged` or `running`, a
  different remedy for the same condition. `investigate parked` listed 3 of 8
  dead-letter queues. `observe queues` listed 7 of 18. `verify`'s orphan regex is
  fully anchored and never matched a `-post` lane, so a decommissioned processor
  left two orphans it could not report.
- **`skp verify` had no way to check either new kind of surface**, and said so
  loudly the first time it ran: `fanout.Exchange` ends in "Exchange" but not
  "DeadLetterExchange", so it was checked against `list_queues` where an exchange
  can never appear; and `{instanceId}` templates were filled with processor ids.
  Three REFUTED claims, all of them the checker's fault, not the catalog's.

### Facts worth carrying

- **The registered SourceHash is `c9ab4a65b0479195b3a2dfbf7f8c55babdb0fb3a153555f4e88a14e31b5c529b`.**
  The topology design records `98de7130…`; `ac23c1e` edited
  `BaseProcessor.Core/Processing/ProcessedDataHandler.cs`, which is inside the
  SourceHash fold, and moved it again. Read it from the pod — it is now the
  processor's first log line, in all three boot outcomes.
- **Probe outcomes never reach Elasticsearch.** The manifests set
  `Logging__OpenTelemetry__LogLevel__HealthProbe=None`, so the `HealthProbe`
  category stays on stdout. Verified both directions: 200 lines in the pod log,
  **0 records in Elasticsearch over 24h**. Reach for them with `cluster.logs`.
- **All 8 dead-lettering queues key on their LIVE queue's name.** Verified on the
  broker. That is what makes a redrive key derivable from the queue that refused
  the message; before `5f32c35` it was right on three queues and wrong on five.
- **The fan-out queues are non-exclusive**, so two replicas resolving one name
  raises no `RESOURCE_LOCKED` and logs nothing — the broadcast degrades into a
  competing-consumer load balance and two replicas of three run on a stale L1.
  `skp verify --component rabbitmq` now checks each live replica has its own
  queue, resolving the replica set from `pipeline.leader` rather than from the
  broker it is checking.
- **There is no way to inject slowness on this cluster any more.** `755b020`
  removed toxiproxy and both `SlowRedisScenarioTests`. Every remaining scenario is
  binary — absent or present.
- **`orchestrator-result.dead` holds 1**, and it is not the synthetic one: the
  2026-08-31 teardown deleted every queue at 0 messages, so this message parked
  after that date and nobody has looked at it.

### The live proof of the verdict fix

`operate verify` reporting the wrong remedy cannot be proved by a unit test alone,
so it was proved on the cluster. A `ProcessedData` carrying
`ProcessorId=deadbee5-0000-4000-8000-000000000002` was published to
`processor-{id}-post` with `type: processed-data`; the provenance guard refused it
verbatim in the pod log and parked it; `_queue_states` reported
`parked-at-processor-d033b408…` naming `-post.dead` and the guard as one of the two
causes; the queue was purged back to its baseline of 0. Under the previous code
that message was invisible.

### Gates, all green on 2026-09-01

| Gate | Result |
| --- | --- |
| `python -m unittest discover -s tests -t .` | 515 passed |
| `skp doctor` | every row ok, including the new `verb references` |
| `skp verify --probe-writes --probe-runs` | **141/141 (100%)**, no refutations |
| `dotnet test SK_P.sln` | 0 failed, 733 passed, 20 skipped, exit 0 |
| `grafana/check-expressions.py` | 96 returning, 1 empty (intentional), **0 invalid** |
| `grafana/audit-instruments.py` | all 16 instruments have live series |

### Still open

- **51 catalog entries name a verb that does not exist yet.** They are now declared
  in `skp/commands.py` `PLANNED` with a justification each, and `skp doctor` counts
  them in its `verb references` row rather than hiding them. `skp analyze` does not
  exist at all; `skp author` ships `validate` and `apply` and nothing else.
- **Phases 4 and 5 are still unbuilt** — the developer verbs, and the skills
  themselves. `.claude/skills/skp*` does not exist.
