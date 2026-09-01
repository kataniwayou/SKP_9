# Resume — SK_P9

Written 2026-09-01. Replaces the 2026-08-24 handoff; this is the current one. Where that file's
reasoning still holds it is carried forward below rather than left to be found.

The durable write-ups are `docs/superpowers/HANDOVER-2026-08-30-skp-toolkit.md` (the toolkit, and
the two orchestrator changes) and `grafana/README.md` (the boards, and the measurements behind
them). This file is state, gaps and traps.

## Where things stand

Branch `topology/advance-materialize-consistency`, clean tree, **unpushed, no git remote
configured**. 14 commits this session on top of `42c5779`.

Everything green, all measured today:

| Gate | Result |
| --- | --- |
| `dotnet test SK_P.sln` | 0 failed, 748 passed, 20 skipped, exit 0 |
| `python -m unittest discover -s tests -t .` (from `skp-toolkit/`) | 515 passed |
| `skp doctor` | 12/12 rows ok |
| `skp verify --probe-writes --probe-runs` | **141/141 (100%)**, no refutations |
| `grafana/check-expressions.py http://localhost:19090` | 96 returning, 1 empty (intentional), 0 invalid |
| `grafana/audit-instruments.py http://localhost:19090` | all 16 instruments have live series |

Cluster is **kind**, node `desktop-control-plane`, despite the kubectl context being named
`docker-desktop`. Namespace `skp`. 1 API, 3 orchestrator (StatefulSet), 2 processor (Deployment),
all Ready, 0 restarts. Port-forwards are supervised and on **offset** ports
(`k8s/port-forward-realstack.ps1`):

```
baseapi 18080   prometheus 19090   elasticsearch 19200   grafana 13000
rabbitmq 5673   redis 6380         otel 14317 / 18889
```

Processor `d033b408-8471-4c3d-8acf-3bee6164f01e`, `sample-proc-v9` 1.5.0, SourceHash
`c9ab4a65b0479195b3a2dfbf7f8c55babdb0fb3a153555f4e88a14e31b5c529b` — pod and registered row agree.
Three workflows: `4cd8af45` v8-fanout-proof, `4a77ba79` simple-abc, `cbe1c767` v8-fanout-proof-clone.
Broker holds 18 queues, 8 of them dead-lettering.

## What this session did

**Re-grounded the toolkit against a system that had moved under it.** Twenty commits had landed
since the toolkit was last verified; **two touched a file it tracks and eighteen did not**, so the
drift lock could see two. The rest had to be found by reading commits and by reading the running
system. Catalog 135 → 141, and `skp verify` is back at 100% against live.

**Catalogued a contract file nothing knew about.** `Messaging.Contracts/OrchestratorFanout.cs` was
not in `SOURCE_MAP`, so `orchestrator-fanout`, `orchestrator-fanout-dlx` and the three per-replica
`orchestrator-control.{instanceId}` pairs — **6 live queues and 2 exchanges** — had no catalog id.
The coverage check could not report it: it enumerates from the files `SOURCE_MAP` lists, so an
unlisted contract file is not an uncovered surface, it is not a surface at all.

**Fixed four verbs that were reading a two-queue processor.** `operate verify` parsed
`processor-<guid>-post.dead` into the id `<guid>-post`, matched no row, and skipped it — so a parked
branch fell through to `wedged` or `running`, a different remedy for the same condition.
`investigate parked` saw 3 of 8 dead-letter queues; `observe queues` saw 7 of 18.

**Corrected a catalog entry that was instructing the model to run a query that reads 0 forever**
(see the findings below), and added `skp doctor`'s `verb references` check with the registry that
lets it pass.

**Instrumented the API consumer's escape path**, and found the open item that sent me there was
stale: it claimed the consumer emitted nothing, which `7afa107` had already fixed. The real gap was
one arm — no outer catch, so an escaping delivery was timed and not counted.

**Decided the absent-key divergence and shipped both halves.** The orchestrator now ACKS an absent
execution blob instead of parking, and a **provenance guard** — the sibling of WR-02 — refuses an
outcome whose `ProcessorId` disagrees with the one L1 assigns to that step. Then the read moved
above the two log lines, so a duplicate stops announcing a completion it did not cause — which was
breaching `RunLedger`'s I8 (`EntryStepCompleted == EntryBranches`, exactly). Orchestrator rebuilt and
redeployed three times; all three proved live.

## The findings that matter

**1. `service_instance_id` is unique per replica per PROCESS LIFETIME, not per replica.** It is the
pod name. On a **Deployment** every restart mints a new one, so a restart arrives as a NEW series and
`changes()`/`resets()`/`increase()` read 0 forever. On the orchestrator **StatefulSet** the ordinal
is reclaimed and the series survives. Measured over 12h:

```
processor  (Deployment)    changes() = 0 across 23 series   truth: 21 starts
baseapi    (Deployment)    changes() = 0 across 10 series   truth:  9 starts
orchestrator (StatefulSet) changes() = 29 (11/9/9)          correct
instant read instead of max_over_time, processor:      2    truth: 21
```

**The workload kind decides the query and each form is silently wrong on the other.** To count
across a restart, group on a label that survives one — `processorId` on the processor, `source` on
the API — and use `max_over_time` over the range, never an instant read.

**2. The catalog was giving a confident wrong instruction, and nothing could catch it.** The
`pipeline.process.start.timestamp` annotation said *"changes() is the whole query"* and *"POD_NAME
identity is what keeps a restart on the same series"*. Both false on two of three workloads. No C#
changed, so no drift; the claim is prose, so `skp verify` never tested it; `verify` checks series
existence, not query semantics. **This is the failure the whole bundle exists to prevent, arriving
from the catalog rather than the model.**

**3. The one parked message was a migration artefact, not a defect.** `Result = Completed`, refused
at `ReadAsync` — the **L2 absent-key branch**, not the L1 one the 2026-08-24 investigation chased,
so `DescribeL1Miss` would never have fired on it. The run was in flight across two orchestrator
restart waves, which were *planned*: the topology migration's own scale-down. One entry dispatch
produced 3 entry-step completions, 20 hand-offs and **4 terminal completions**. The run did not lose
progress; it made the same progress four times. The parked delivery was the first message
`orchestrator-0` consumed after hydrating, 32ms in.

**4. The park's own justification was unreachable.** By the time `ReadAsync` runs the workflow and
step are in L1, `EntryId` is not the sentinel, the write happened (`ProcessedDataHandler` writes
before it sends, and sends `Guid.Empty` when it did not write), and nothing else deletes that key.
So an absent key means the outcome was already handled — and a parked one could not even be
replayed, since the replay re-reads the same absent key and parks again.

## Open, in the order I would take them

- **Nothing consumes the alerts.** No Alertmanager; `/api/v1/alertmanagers` is empty. Deliberately
  deferred by the user. Still the largest gap, and **now larger**: dead-letter depth used to be the
  de facto signal that outcomes were being redelivered after a restart, and it no longer is.
- **No alert on `pipeline_deadletter_depth`.** The instrument ships; the rule (`depth > 0 for 5m`)
  does not. Adding it means editing `prometheus.yml` — see the TSDB trap below.
- **No backlog/lag and no end-to-end latency.** The hop gap is a conservation check: a message in a
  queue and a message lost are identical to it.
- **Degradation cannot be injected at all any more.** `755b020` removed toxiproxy and both
  `SlowRedisScenarioTests`; every remaining scenario is binary, absent or present. The boards' known
  blind spot — a 685× slower dependency reads green — can now be reasoned about but not
  demonstrated or regression-tested.
- **A true wedged replica still cannot be produced**, and **a wipe still reads identically to a
  pause**.
- ~~**The API's consumer emits no metrics at all.**~~ **Stale when it was carried forward, and
  corrected 2026-09-01.** `7afa107` had already instrumented it; the live series prove it
  (`pipeline_messages_consumed_total{service_name="baseapi", queue="orchestrator-control"}`). The
  REAL gap was one arm: no outer catch, so a delivery escaping classification was timed by
  `pipeline.consumer.duration` and counted by nothing. Closed. **The residual gap is coverage, not
  instrumentation** — see below.
- **51 catalog entries name a verb that does not exist.** Declared in `skp/commands.py` `PLANNED`
  with a justification each and counted by `skp doctor`. `skp analyze` does not exist at all.
- **The two `GatedQueueConsumer` copies drift, and only one is tested.** Every consumer test in
  the suite targeted BaseConsole.Core's twin; the API's copy had none at all, which is how it came
  to be missing an arm the twin has. `ApiIngressMetricsTests` now covers the arms that bear on that,
  not the full matrix. The durable fix is the shape `HealthProbeLog` already uses — one test feeding
  both copies and comparing — but the two consumers differ by more than a render string, so it is
  real work.
- **Toolkit phases 4 and 5 are unbuilt** — the developer verbs, and the skills. `.claude/skills/skp*`
  does not exist.
- **The six parked step outcomes are unresolvable now.** The 2026-08-31 teardown deleted every queue
  at 0 messages, so the evidence is gone. Closed by loss of evidence, not by resolution.
- **Calibration constants are deployment-specific** and nothing enforces them: `LIVENESS` 40s, the
  `System flowing` band, the reference lines and the queue-depth threshold all describe *this*
  workload. Re-derive before trusting a green band elsewhere.
- **The 141/141 expires around 2026-09-17.** Three claims are Elasticsearch templates that exist only
  because a fault was injected to produce them; retention is ~17 days and the ratio falls back to
  138/141 on its own. Read the date, not the number. Recipe in the handover.

## Traps, each of which cost time

**Carried forward and still true**

- **Restarting Prometheus discards the entire TSDB.** No storage volume, and both config files are
  `subPath`-mounted so `apply` and `/-/reload` cannot see a change. Batch config edits.
- **`kind load` cannot install ghcr images** carrying attestation manifests (`ctr: content digest
  not found`). Use `docker pull --platform linux/amd64` → tag → save →
  `docker exec -i desktop-control-plane ctr -n k8s.io images import -`. Locally built images
  (`orchestrator:local`) load fine.
- **From Git Bash, prefix `kubectl exec ... -- /binary` with `MSYS_NO_PATHCONV=1`** or the leading
  slash becomes `C:/Program Files/Git/...`. Used constantly this session.
- **`powershell.exe` cannot load a .NET 8 assembly** (SourceHash reads). Use `pwsh`.
- **`/tmp` is not one place**: Git Bash maps it into AppData; Windows Python reads `C:\tmp`.
- **Elasticsearch `body.text` is not analysed** — `match`/`match_phrase` return 0 even for text that
  is there. Filter client-side, or prefix-match `attributes.{OriginalFormat}`. A 500-hit ascending
  query silently truncates; sort descending.
- **OpenTelemetry unit `"1"` appends `_ratio`**, and a unit suffix lands before the type suffix.
  `pipeline.leader` is `pipeline_leader_ratio`; `pipeline.process.start.timestamp` is
  `pipeline_process_start_timestamp_seconds`. Try the bare name and the suffixed one, never hardcode
  whichever works today — this is what once made 9 of 16 instruments read as absent.
- **`LogDebug` is below the level shipped to the log store.**
- **Elasticsearch lags the pod log under load, and a zero can mean "not indexed yet".** Measured
  today: three records visible in `kubectl logs` at 12:19:20–12:19:50 returned **0 hits** on a
  bounded ES query at 12:21 and 78 hits for the same template four minutes later. The workload is a
  burst rather than a stream, so an idle-looking window is doubly easy to get. Never conclude "the
  system is quiet" or "that never happened" from one bounded query — cross-check `kubectl logs`, or
  ask again after a minute.
- **A background task reported as killed may still be running.** Verify the process tree.
- **Never scale Redis** except via `RedisWipeScenarioTests`.
- The soak's drain check fails if the standing orchestration (`4cd8af45`) fired in the last 40s.

**Sharpened by this session**

- **"A shared-library change does not move the SourceHash" is only half true, and the half that is
  wrong bit twice this week.** `SourceHash.targets` hashes `BaseProcessor.Core/**/*.cs` **plus** the
  concrete project's. `BaseConsole.Core` and `Messaging.Contracts` are siblings and are **not**
  included. So a `Messaging.Contracts` edit does not move it and a **`BaseProcessor.Core` edit moves
  it for every processor in the fleet at once** — which is why the topology design's recorded
  `98de7130…` was already superseded by `c9ab4a65…` a day later.
- **Read the hash from the pod, never from a document or a build log.** `54f4ebb` now prints it as
  the processor's first log line in all three boot outcomes. A host incremental build could print a
  new hash while the assembly carried an old one (observed 2026-07-27, three versions stale); there
  is a guard target for it now, but the pod is still the only authority.
- **`orchestrator-result.dead` holds 2, and they are different things.** The first is the genuine
  2026-08-31 incident, kept as evidence. The second is synthetic —
  `deadbee5-0000-4000-8000-000000000005`, injected to validate the provenance guard, following the
  convention the old `deadbee5-…0001` marker used.

**New**

- **`--filter-class` is not a `dotnet test` argument.** It belongs to the test executable and
  `dotnet test` rejects it with `MSBUILD : error MSB1001: Unknown switch`. Run
  `src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe` directly, or run the whole suite.
  (`--filter` is separately, silently ignored.)
- **`dotnet test` does not print which test failed.** It names a log file that does not contain it
  either. Run the executable directly to get the assertion.
- **The Bash tool rewrites `\\n` inside heredocs.** A Python heredoc containing `"\\n"` arrives as a
  real newline, so string anchors silently stop matching. Use raw strings (`r'''…'''`) or write the
  content with the Write tool.
- **A script that fails partway can still produce a commit.** `git add -A && git commit` staged
  everything after a Python step aborted on a path error, and the change shipped without its
  documentation. Check the script exited 0 before staging.
- **`rabbitmqadmin` v2 sets the AMQP type header via `--properties '{"type":"step-outcome"}'`**;
  `publish message` takes `--routing-key` and `--payload`. Peek a parked message with
  `get messages --queue <q> --count 1 --ack-mode ack_requeue_true`, which requeues rather than
  consumes — but **increments `x-delivery-count`**, harmless only because `x-delivery-limit` is now
  `-1`. Before `ed0bae7` a peek spent one of twenty silent lives.
- **`target_info` renders identity under `exported_job`/`exported_instance`**, not
  `service_name`/`service_instance_id` — only the `pipeline_*` instruments carry those.
- **PromQL label matchers are fully anchored.** `queue=~"processor-$processorId"` excluded the
  `-post` queue entirely from the moment it existed. Same anchoring bug hid it from `skp verify`'s
  orphan check.
- **Probe outcomes never reach Elasticsearch.** The manifests set
  `Logging__OpenTelemetry__LogLevel__HealthProbe=None`, so the `HealthProbe` category is stdout-only.
  Verified both directions: 200 lines in a pod log, 0 records in ES over 24h. Reach for them with
  `kubectl logs`, not a query.

## The lesson worth carrying

The 2026-08-24 lesson was *measure the instrument, not the documentation about it*. This session is
the same lesson one level up: **the catalog is an instrument too, and it had gone wrong in the one
way it is built to prevent.** An entry told the model to run `changes()` on a gauge whose series is
reborn on every restart — confident, specific, and returning 0 forever. Nothing could catch it: no
C# changed so there was no drift, the claim was prose so no check tested it, and `skp verify` proves
series exist rather than that queries mean anything.

What actually found things this session: reading the broker and counting (18 queues against a
catalog that knew 12), running both forms of a query side by side over the same window, and
publishing a message to see what the system did with it. What found nothing: reading the source.

And one specific habit worth keeping — **when a check fires on your own change, read it before
fixing it**. The suite failed on `AnOutcomeNamingABlobTheStoreDoesNotHoldIsRefused`, a test that
existed precisely so the disposition could not be changed quietly. It was inverted, not deleted.

---

## The prompt

```
Continue SK_P9. Read docs/superpowers/RESUME.md first — it has the state, the
open gaps, and the traps that have each cost time.

REPO:   C:\Users\UserL\source\repos\SK_P9
BRANCH: topology/advance-materialize-consistency (unpushed, clean, no remote)

Everything is green: 741 .NET tests, 515 toolkit tests, skp verify 141/141
against the live cluster, skp doctor 12/12. The cluster is up with all seven
port-forwards. docs/superpowers/HANDOVER-2026-08-30-skp-toolkit.md is the
write-up for the toolkit and for the two orchestrator changes.

Pick one:

- Wire an Alertmanager, or at least add a dead-letter alert rule. Nothing
  consumes the five existing rules. This got MORE urgent: a redelivered
  outcome no longer dead-letters, so dead-letter depth is no longer the signal
  that outcomes are being replayed after a restart. Note a Prometheus config
  edit needs a restart that discards the TSDB.
- Build toolkit phase 4 (skp processor-build / processor-ship) or phase 5 (the
  skills themselves). Phase 5 needs 3 and 4 for its verb lists. 51 catalog
  entries name verbs that do not exist yet — they are listed in
  skp/commands.py PLANNED with a justification each.
- Close the GatedQueueConsumer twin drift. The two copies diverge and only
  BaseConsole.Core's was ever tested, which is how the API's lost an arm the
  twin has. HealthProbeLog's one-test-feeds-both-copies shape is the model.

Three things to carry in:

- The catalog is an instrument. Validate its CLAIMS against the running
  system, not just its coverage — an entry can be fully covered, internally
  consistent, and factually wrong about how to query the thing it describes.
- Read the SourceHash from the pod, never from a document. BaseProcessor.Core
  is inside the hash fold and Messaging.Contracts is not.
- Prometheus and RabbitMQ are ORG-OWNED in production. No scrape targets, no
  plugins, no broker-wide metrics. Anything new must be exported by the app
  through OTLP.
```
