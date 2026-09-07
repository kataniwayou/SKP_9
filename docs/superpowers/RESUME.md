# Resume — SK_P9

Written 2026-09-07. Replaces the 2026-09-01 version; this is the current one. That file's toolkit and
observability detail is in git history and is still accurate — what it said about the *system* has not
been re-measured since, and the open items it listed are carried forward below rather than left to be
found. This session did not touch the toolkit, the boards or the orchestrator.

The durable write-ups remain `docs/superpowers/HANDOVER-2026-08-30-skp-toolkit.md` and
`grafana/README.md`. The PathImporter's own design is
`docs/superpowers/specs/2026-09-06-path-importer-design.md`, and §8 of it was rewritten today.

## Where things stand

Branch `feature/path-importer`, **72 commits ahead of `main`, 26 of them today**, clean tree apart
from an untracked `src/BaseApi.Service/Properties/launchSettings.json` that Visual Studio generates
and nobody has committed. **Unpushed, no git remote configured.**

| Gate | Result, measured today |
| --- | --- |
| `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj` | **0 failed, 812 passed, 21 skipped**, exit 0 |
| `kubectl kustomize k8s/` | renders, 26 documents |
| Live one-step workflow, end to end | ran repeatedly; see below |
| `Live/PathImporterLiveTests` with `SKP_REALSTACK=1` | 1 passed |

The 21 skips are every test under `Live/`, and nothing else: there is no `Skip =` attribute and no
`Assert.Skip*` call outside that folder. The count only grows — read the shape, never a remembered
number.

**Not re-measured today, and therefore unknown:** `skp verify`, `skp doctor`,
`grafana/check-expressions.py`, `audit-instruments.py`. They were 141/141, 12/12, 96-returning and
16-of-16 on 2026-09-01, but a **second processor now exists in the namespace**, which those checks
have never seen. Assume nothing about them until they are run.

## The live setup, and every identifier in it

Cluster is **kind**, node `desktop-control-plane`, despite the kubectl context saying `docker-desktop`.
Namespace `skp`. Fourteen pods, all Running, and the new one is `processor-pathimporter` at one
replica.

```
processor row   9d0fb8a6-1d57-4a2b-9394-cf0a9568c48a  path-importer 1.3.0
SourceHash      32e1a3aa841a13c288270668d8952e69354cd1dab15735eef768ae57692efd1d
step            86e5038f-f6e4-45cc-b52e-12aeb31b7755  step-path-importer, nextStepIds []
assignment      2f67881a-5ec6-4392-ac1a-301ea66b1fc3
workflow        a5498df6-1522-4098-ad65-f4aff4998988  cron */30 * * * * *, STOPPED
```

`nextStepIds` is empty **on purpose** — decided today. The branches terminate at the importer. It is
the first slice, not a pipeline, and the complex workflow of the next milestone fills that field in
without moving anything else.

The step payload is the whole Kafka configuration, and no Kafka address appears anywhere in `k8s/`:

```json
{"brokerList":"skp-kafka:9092","topic":"skp-paths","consumerGroup":"skp-pathimporter",
 "messageCount":5,"idleTimeoutSeconds":10}
```

**The broker is a plain docker container, deliberately not in the cluster**, because in production it
is org infrastructure that nothing here stands up. `tools/kafka-dev-broker.ps1 -Up|-Down|-Status|-Reset`
runs Apache Kafka 3.9.1 in KRaft on the **`kind` docker network**, and `tools/kafka-produce-paths.py`
seeds it. Topic `skp-paths`, one partition, at offset 22 with group `skp-pathimporter` fully committed
and lag 0.

**Two addresses, and that is the whole design.** A Kafka client bootstraps, is told which address to
use, and then talks to *that* — so one advertised listener can only ever serve one side, and the
wrong one fails as a hang rather than an error.

```
host      localhost:19092     what the tests and the producer use
in-pod    skp-kafka:9092      what the step payload names; pod DNS resolves the container name
```

Port-forwards are on offset ports via `k8s/port-forward-realstack.ps1` (baseapi 18080, prometheus
19090, elasticsearch 19200, grafana 13000, rabbitmq 5673, redis 6380, otel 14317/18889).

The API's controllers are **plural**: `/api/v1/Processors`, `/Steps`, `/Assignments`, `/Workflows`,
and `/api/v1/Orchestration/start|stop` with a bare quoted GUID as the body. `/api/v1/Processor`
singular is a 404, and so is `/api/v1.0/...`.

## What this session did

**Put a real broker behind the PathImporter and ran the first live workflow through it.** Until today
nothing had ever executed `KafkaPathConsumer`, the Confluent client, or the orchestrator's dispatch
into this processor — the hermetic suite drives the loop through `FakePathConsumer`, which is what
keeps it broker-free and also what left the adapter with nothing above it. First live run: 5 records
consumed 5/5 `Completed`, five distinct execution ids, five branches completed, committed offset 5 and
lag 0; the next fire returned 0/5 `Drained` after exactly 10001ms of a 10s idle timeout.

**Replaced fault classification with a split by position, at the user's direction.** `KafkaFaultClassifier`
is deleted. Part one is getting a subscribed consumer with a partition under it — rent or create,
subscribe, wait for assignment — and *any* failure there fails the step. Part two is the loop, and
*nothing* in it fails the step: null is `Drained`, a throw from `Consume` or `Commit` is `Faulted`,
both keep what was already sent and committed. A permanent fault surfaces in part one on the next
dispatch, where it does fail. This removed the need to predict which error codes recur — a prediction
already shown wrong once, when `25c9ed5` removed a code Confluent does not define.

**Closed the window where an outage looked like an empty topic.** Three measurements, same procedure
each time (warm the consumer with a successful dispatch, `docker stop skp-kafka`, watch):

| | ambiguous dispatches | time to the failed step |
| --- | --- | --- |
| `session.timeout.ms` at its ~45s default | 2 reported `Drained` | third dispatch |
| lowered to 10s | 1 reported `Drained` | ~59s, second dispatch |
| `WaitForAssignment` verifies the assignment | **0** | **3s, the very next dispatch** |

**Wrote the first test that executes `KafkaPathConsumer`.** `Live/PathImporterLiveTests` stops and
starts the broker container to reach the state that matters, gated by `SKP_REALSTACK` like everything
else under `Live/`. `RealStack` grew `KafkaBrokers`, `KafkaTopic` and `KafkaContainer`.

## The findings that matter

**1. A Kafka assignment is local state, and local state outlives the broker.** `_inner.Assignment`
stays populated after the broker vanishes, until librdkafka revokes it — which needs coordinator
contact or a session timeout. Returning true on that alone sent the dispatch into a loop that read
nothing and reported a healthy `Drained`. **`Drained` and "I cannot reach the broker" were the same
line**, and on a source step nothing downstream can tell them apart, because no branches arriving is
what an empty topic looks like too. The fix is a `QueryWatermarkOffsets` round trip to the partition
leader: milliseconds when the broker is there, a throw when it is not.

**2. I proved this backwards first, and the wrong proof was convincing.** The initial outage test
showed `Faulted` in 87ms and I reported the ambiguity closed. It was a consumer that had *already*
lost its assignment. A genuinely warm one behaves entirely differently, and only a second run with
different timing showed it. **One live observation of a timing-dependent behaviour is an anecdote.**

**3. A test can pass for the wrong reason and look identical to a passing test.** The first version of
the live test called `WaitForAssignment` twice with no consume between, so the second call answered
from the record the first had buffered in `_pending` rather than from the assignment — exercising the
branch that was already correct. It only surfaced because the fix appeared not to work. Causality was
then confirmed by disabling the single new line and re-running.

**4. librdkafka resolves `skp-kafka` to the kind network's IPv6 address first and cannot route it**,
failing over to IPv4 in ~7ms. Harmless in time; it logs a `FAIL`/`ERROR` pair per fresh connection,
which reads exactly like a broker outage to anyone reading logs later. Not fixed: pinning
`broker.address.family=v4` would encode a local network artifact into a processor whose broker is
org-owned.

**5. MSYS path mangling reached the DATA, not just a command.** `--prefix /mnt/incoming/smoke` typed
in Git Bash arrived at Python as `C:/Program Files/Git/mnt/incoming/smoke`, and the processor imported
five records carrying that without complaint, because a path is opaque to it. The producer's header
now says to run it from PowerShell.

**6. `processor-sample`'s SourceHash is `32b3284a…`, not the `c9ab4a65…` the last handoff recorded.**
Something inside the hash fold moved. The registered row agrees with a fresh build, so the deployed
sample is current — but any document naming a hash is stale by default. Read it from the pod.

## Open, in the order I would take them

**New today**

- **Nothing asserts the loop against a live broker** beyond the single assignment test. Commit
  durability across a restart, the real error codes, and `Drained` on a genuinely empty topic are all
  observed-once and untested.
- **A leader election now fails the step** where it previously passed unnoticed. That follows from the
  part-one rule rather than from the probe, but the probe makes it reachable. On a one-partition,
  one-broker dev cluster it is rare; on the org's replicated cluster it will not be.
- **`pwsh tools/ship-delta.ps1` has not been run** since the Kafka packages, the two new tools, the
  manifest and the Dockerfile landed. The offline drop does not carry them yet.
- **`skp verify` / `doctor` / the board checks have not been run against a two-processor namespace.**
  The 141/141 predates it.
- **`tools/kafka-dev-broker.ps1 -Up`, `-Down` and `-Reset` have never executed.** The container was
  started by hand and the script written after; only `-Status` has run. Reset once before relying on it.

**Carried forward from 2026-09-01, still open**

- **Nothing consumes the alerts.** No Alertmanager, `/api/v1/alertmanagers` is empty. Deliberately
  deferred, still the largest gap.
- **No alert on `pipeline_deadletter_depth`**; adding one means editing `prometheus.yml`, which means
  a restart that discards the TSDB.
- **No backlog/lag and no end-to-end latency.** The hop gap cannot tell a queued message from a lost one.
- **Degradation cannot be injected at all** since `755b020` removed toxiproxy. Every scenario is binary.
- **A true wedged replica cannot be produced**, and **a wipe reads identically to a pause**.
- **51 catalog entries name a verb that does not exist**, listed in `skp/commands.py` `PLANNED`.
- **Toolkit phases 4 and 5 are unbuilt.** `.claude/skills/skp*` does not exist.
- **The four `GatedQueueConsumer`-family types are still duplicated**, held safe by `ConsumerTwinParityTests`
  rather than reconciled.
- **The 141/141 expires around 2026-09-17** as injected Elasticsearch records age out to 138/141.

## Traps, each of which cost time

**New**

- **`MSYS_NO_PATHCONV=1` is needed for `docker exec` too**, not just `kubectl exec`. Without it
  `/opt/kafka/bin/kafka-topics.sh` becomes `C:/Program Files/Git/opt/kafka/...`. It also mangles
  ordinary script arguments that look like unix paths — see finding 5.
- **The port-forwards were ALL DOWN at session start**, with restart counts in the tens. The
  supervisor does not outlive the session that started it. Run `-Status` before believing any
  local port, and never conclude a service is broken from a failed curl alone.
- **`--filter-method "*Name*"` works on the test EXECUTABLE** (`BaseApi.Tests.exe`) and is how to run
  one test. `dotnet test` still cannot filter, still does not name a failing test, and still points at
  a log file that does not contain it.
- **`dotnet test` reports exit 0 on a failed run** when its output is piped through `grep`. Read the
  `Failed!` line, not the exit code, when a pipeline is involved.
- **The docker image build emits an attestation manifest**, but `kind load docker-image` accepts it
  for a locally built image. The `ctr: content digest not found` trap is specific to pulled ghcr images.
- **Every processor rebuild needs the SourceHash repointed** with a `PUT /api/v1/Processors/{id}`, and
  it changed three times today. The pod waits Running/NotReady with 0 restarts until the row matches —
  by design, not a failure.

**Carried forward and still true**

- **Restarting Prometheus discards the entire TSDB.** Batch config edits.
- **`kind load` cannot install ghcr images carrying attestation manifests.** Use `docker pull` → tag →
  save → `ctr images import`.
- **`powershell.exe` cannot load a .NET 8 assembly.** Use `pwsh`.
- **`/tmp` is not one place**: Git Bash maps it into AppData, Windows Python reads `C:\tmp`.
- **Elasticsearch `body.text` is not analysed**, and ES lags the pod log under load — a zero can mean
  "not indexed yet". Cross-check `kubectl logs`.
- **OpenTelemetry unit `"1"` appends `_ratio`**, and a unit suffix lands before the type suffix.
- **`LogDebug` is below the level shipped to the log store.**
- **A background task reported as killed may still be running.** Verify the process tree.
- **Never scale Redis** except via `RedisWipeScenarioTests`.
- **PromQL label matchers are fully anchored**, and `service_instance_id` is the pod name — on a
  Deployment every restart mints a new series, so `changes()`/`increase()` read 0 forever.
- **`BaseProcessor.Core` is inside the SourceHash fold and `Messaging.Contracts` is not**, so a shared
  edit moves the hash for every processor at once and a contracts edit moves none.

## The lesson worth carrying

The 2026-09-01 lesson was *the catalog is an instrument too*. Today's is narrower and sharper: **a
component behind a seam is not covered by the tests that pass above it, and the gap is invisible
precisely because everything is green.** 827 hermetic tests passed against a `KafkaPathConsumer` that
had never run, and the first hour of pointing it at a real broker produced four findings — an outage
that reported healthy, an IPv6 misfire, corrupted seed data, and a test that passed for the wrong
reason. None were reachable from the fake, and none were subtle once the broker was there.

The corollary is about proof rather than code. I reported the outage ambiguity closed after one
observation, and it was not closed; the observation had caught a consumer in a state I had not
noticed. **A single live run of timing-dependent behaviour is an anecdote, and the way to tell them
apart is to make the behaviour happen twice from different starting states.**

---

## The prompt

```
Continue SK_P9. Read docs/superpowers/RESUME.md first — it has the state, the
open gaps, and the traps that have each cost time.

REPO:   C:\Users\UserL\source\repos\SK_P9
BRANCH: feature/path-importer (unpushed, clean, no remote)

The PathImporter is built, deployed and proven live: one step, one assignment,
one workflow (a5498df6, STOPPED), reading a real Kafka through a dev container
on the kind network. 0 failed, 812 passed, 21 skipped.

Bring the live setup up first — the port-forward supervisor does not survive a
session:
  ./k8s/port-forward-realstack.ps1
  ./tools/kafka-dev-broker.ps1 -Up      # never actually run; -Status has
  python tools/kafka-produce-paths.py --count 12    # FROM POWERSHELL, not bash

Pick one:

- Cover the adapter properly. Live/PathImporterLiveTests is the seam and holds
  exactly one test. Commit durability across a consumer restart, the real error
  codes behind an unknown topic and a bad grant, and Drained on a genuinely
  empty topic are all observed-once and unasserted.
- Run the checks a second processor has invalidated: skp verify, skp doctor,
  grafana/check-expressions.py, audit-instruments.py. The 141/141 predates
  processor-pathimporter existing.
- pwsh tools/ship-delta.ps1. The offline drop does not carry the Kafka
  packages, the two new tools, the manifest or the Dockerfile.
- The next milestone's complex workflow. The entry step is already the one to
  wire in: fill step 86e5038f's nextStepIds, and nothing else moves.

Three things to carry in:

- A component behind a seam is not covered by the tests above it. The hermetic
  suite drives IPathConsumer through a fake; KafkaPathConsumer itself has one
  test and everything else about it is assumption.
- One live observation of timing-dependent behaviour is an anecdote. Make it
  happen twice, from different starting states, before reporting it closed.
- Read the SourceHash from the pod, never from a document — including this one.
  Every rebuild needs a PUT to repoint the processor row.
```
