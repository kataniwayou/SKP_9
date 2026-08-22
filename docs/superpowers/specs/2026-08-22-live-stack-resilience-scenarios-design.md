# Live-stack resilience scenarios

Date: 2026-08-22
Status: implemented
Scope: `src/tests/BaseApi.Tests/Live/Resilience`, `k8s/port-forward-realstack.ps1`

## 1. What this covers

Five timed orchestrations against the running `skp` cluster, each five minutes
long, each driven through the BaseApi `start`/`stop` endpoints, each verified
**from Elasticsearch log records alone**. Prometheus is read for corroboration
and for diagnosing a failure; no verdict depends on it.

The question every scenario asks is the same: **did the round trip lose a
step?** The four the request named, plus a fifth that the investigation below
forced out into the open:

| # | Scenario | Fault | Success |
| --- | --- | --- | --- |
| S1 | Happy path | none | every run complete |
| S2 | Redis unavailable | `CLIENT PAUSE … ALL` | zero unaccounted loss |
| S3 | RabbitMQ unavailable | `scale sts/rabbitmq --replicas=0` | zero unaccounted loss |
| S4 | Both unavailable | S2 + S3 over one window | zero unaccounted loss |
| S5 | Redis scale-to-0 (**L2 wipe**) | `scale sts/redis --replicas=0` | loss bounded and attributable |
| S6 | Processor unavailable | `scale deploy/processor-sample --replicas=0` | zero unaccounted loss |
| S7 | Orchestrator unavailable | `scale sts/orchestrator --replicas=0` | zero unaccounted loss, on the runs that started |

S5 exists because Redis here is ephemeral by design; §4.2 explains why that
makes it a different scenario rather than a variant of S2.

S6 and S7 remove a *worker* rather than a dependency, and they are not
symmetric with each other: a dead processor leaves the orchestrator firing into
a durable queue, while a dead orchestrator stops the fires happening at all.
§5.7 and §5.8 give each its own verdict for that reason.

Out of scope, deliberately: processor or orchestrator pod failure, Postgres
outage, collector or Elasticsearch outage, network partition between replicas,
and any assertion about business results. This design is about **transport and
step custody**, not about what the steps computed.

## 2. The system under test

The seeded workflow is `4cd8af45-1295-43db-ab2e-e955dd82b5c5`
(`v8-fanout-proof`), cron `*/30 * * * * *`, ten step assignments. Its graph:

```
A → B → C → { D1, D2 } → { E1, E2 } → { F1, F2 } → G
```

`G` is reached from both `F1` and `F2`, so it runs twice and the run has **two
terminals**. Eleven step executions per fire, from ten assignments.

### 2.1 The run id

`WorkflowFireJob.DispatchEntryStepsAsync` mints one `CorrelationId` per fire and
shares it across every entry step of that fire — a mint per dispatch would split
one run across as many runs as the workflow has entry steps. That id rides the
messages into the processor and back, and lands on every log record either side
writes. **`CorrelationId` is the join key for the entire oracle.** No other field
groups a run.

`ExecutionId` does not serve here: an entry dispatch opens no lineage and the
author mints one per branch, so it identifies a branch, not a run.

## 3. The oracle

### 3.1 Query keys

Logs reach Elasticsearch as OTLP records through the collector's
`elasticsearch` exporter, landing in the data stream `logs-generic.otel-default`.
The fields that matter:

| Field | Holds |
| --- | --- |
| `attributes.{OriginalFormat}` | the **message template**, parameters unsubstituted |
| `attributes.CorrelationId` | the run id, 32 lowercase hex, no dashes |
| `attributes.WorkflowId` / `StepId` / `ProcessorId` / `ExecutionId` / `EntryId` | ids, `"D"` form, absent rather than zeroed |
| `attributes.role` | `leader` / `follower`, orchestrator only |
| `resource.attributes.service.name` | `orchestrator` / the processor's own name |
| `resource.attributes.service.instance.id` | replica identity |
| `scope.name` | the logger category, i.e. the emitting class |
| `body.text` | the **rendered** message |
| `@timestamp` | mapped `date`; ISO-8601 range queries work |

**Count on `attributes.{OriginalFormat}`, never on `body.text`.** The template is
parameter-free and stable, so `the step returned after {ElapsedMs}ms` is one
bucket where the rendered text is one bucket per distinct duration. A verifier
written against rendered text would silently miscount the moment a step's timing
varied, which is always.

### 3.2 The ledger

A complete run is exactly 77 records, and the histogram does not vary:

| `{OriginalFormat}` | Emitter | Count |
| --- | --- | --- |
| `dispatched an entry step` | `WorkflowFireJob` | 1 |
| `dispatched in {ElapsedMs}ms` | `NextStepHandoffHandler` | 10 |
| `running the step` | `ProcessDispatchHandler` | 11 |
| `config gives label {Label} and number {Number}` | `SampleProcessor` (the author) | 11 |
| `the step returned after {ElapsedMs}ms` | `ProcessDispatchHandler` | 11 |
| `branch completed in {ElapsedMs}ms` | `ProcessedDataHandler` | 11 |
| `the entry step completed with {Result}` | `StepOutcomeHandler` | 1 |
| `handed off to {NextStepId} on {NextProcessorId} with {NextEntryId}` | `StepOutcomeHandler` | 10 |
| `advanced {SuccessorCount} successor(s) in {ElapsedMs}ms` | `StepOutcomeHandler` | 9 |
| `the terminal step completed with {Result} — no successor accepts it, the run ends here` | `StepOutcomeHandler` | 2 |

Nine advance events produce ten handoffs, because one of them advances two
successors — the `C → {D1, D2}` fan-out.

### 3.3 Eight invariants

Asserting "the run reached 77 records" would pass a run that lost a dispatch and
gained a redelivery. The verdict is therefore eight relations, each naming one hop:

| # | Invariant | What a breach means |
| --- | --- | --- |
| I1 | `running the step` == `dispatched an entry step` + `dispatched in` | a dispatch was sent and never picked up |
| I2 | `the step returned after` == `running the step` | a step started and never returned |
| I3 | `branch completed in` == `the step returned after` | a return was never persisted to L2 |
| I4 | `dispatched in` == `handed off to` | the orchestrator decided a handoff and never sent it |
| I5 | total dispatches == 11 **and** terminals == 2 | the graph was not walked whole |
| I6 | `config gives label` == `running the step` | **log delivery**, not step loss — see below |
| I7 | `advanced … successor(s)` + `the terminal step completed …` == `branch completed in` | a persisted branch's decision — advance or terminate — was never recorded |
| I8 | `the entry step completed with` == `dispatched an entry step` | an entry dispatch's outcome was never recorded |

**I6 is the discriminator that makes the whole design honest.** The framework's
`running the step` and the author's `config gives label …` are written
microseconds apart, in the same process, on the same logger pipeline. If one is
present and the other absent, no step was lost — a log record was. Without I6,
every OTLP drop reads as a lost step and the suite produces false failures under
exactly the conditions it exists to test.

A run satisfying I1–I8 is **complete**. A run breaching one is not merely failed:
the breached invariant names the hop that dropped it, which is the diagnostic
payoff over a boolean.

## 4. Fault levers

This section is the load-bearing one. Two obvious levers were validated against
the live cluster and **one of them does not work**.

### 4.1 NetworkPolicy is silently ignored — rejected

The cluster runs `kindest/kindnetd:v20251212-v0.29.0-alpha-105-g20ccfc88` with
no `--network-policy` argument. Probed empirically: a busybox pod reached
`redis:6379`, a `policyTypes: [Egress], egress: []` NetworkPolicy selecting that
pod was applied and accepted by the API server, and the pod **still reached
`redis:6379`**.

The object is accepted and enforced by nothing. A scenario built on it would
inject no fault at all, observe an uninterrupted happy path, and pass — the
worst possible failure mode for a resilience suite. This is the same family of
trap as the test runner's silently-ignored `--filter`.

**Consequence for the implementation:** never treat "the fault was applied"
as "the fault landed". §5.3 makes observed fault arrival a precondition of the
verdict.

### 4.2 Redis is ephemeral, so scale-to-0 is not an outage

`k8s/11-redis.yaml:49` runs `redis-server --save "" --appendonly no` and the
StatefulSet has no `volumeClaimTemplates` — persistence is off by design (D-12).

Scaling Redis to zero therefore does not make L2 *unavailable*, it **destroys
L2**: every in-flight step blob, the projected workflow, and every processor
liveness key. On recovery, a redelivered dispatch finds its entry gone and
`ProcessDispatchHandler` logs `entry absent — treating as a duplicate delivery`
and drops it. That is a genuinely lost step, and in the logs it is
indistinguishable from correct duplicate suppression.

So "no lost steps" is unachievable under scale-to-0 — not because the system is
broken, but because the fault destroyed the state recovery would have used. That
is a real property worth a test, so it becomes **S5** with its own verdict
(§5.5), rather than being folded into S2 where it would only ever fail.

RabbitMQ is the opposite case: `k8s/12-rabbitmq.yaml` provisions a 1Gi per-pod
PVC on the mnesia directory (D-11), so scaling it to zero is a true outage with
queues and durable messages intact. Scale-down is the right lever there.

### 4.3 The chosen levers

| Target | Lever | Validated |
| --- | --- | --- |
| Redis | `redis-cli CLIENT PAUSE <ms> ALL`, released by `CLIENT UNPAUSE` | `OK` / `OK` against redis 7.4.9 |
| RabbitMQ | `kubectl scale sts/rabbitmq --replicas=0`, then `--replicas=1` | PVC present; no liveness probe |
| Redis, S5 only | `kubectl scale sts/redis --replicas=0`, then `--replicas=1` | ephemeral by design, §4.2 |

`DEBUG SLEEP` was considered and is unavailable: the server answers `ERR DEBUG
command not allowed`. Patching the headless Service's selector to drop its
endpoints was considered and rejected — it blocks name resolution for *new*
connections while an already-established StackExchange.Redis multiplexer keeps
working, so the fault would be partial and timing-dependent.

**`CLIENT PAUSE` produces timeouts rather than connection refusals, and that is
correct.** `L2FaultClassifier.IsTransient` walks the exception chain for
`RedisConnectionException` **or `RedisTimeoutException`**, and
`DeliveryClassifier` maps a transient L2 fault to `RequeueAndTrip` — the message
returns to its queue and the gate closes. The pause exercises the same
disposition a connection failure would, through a branch the code names
explicitly.

Two further properties make the pause the better lever:

- **It auto-expires.** A crashed or killed test cannot leave Redis wedged; the
  pause lapses on its own deadline. Scale-down and NetworkPolicy both require an
  explicit restore that a crash can skip.
- **Neither StatefulSet declares a liveness probe** (readiness only: `redis-cli
  ping` and `rabbitmq-diagnostics -q ping`). A paused Redis goes NotReady but is
  never restarted by the kubelet, so the fault persists for exactly its window
  and heals without a restart perturbing the measurement.

Because the pause expires, S2 and S4 must **re-issue it every 30 s** until the
scheduled restore. A single `CLIENT PAUSE 60000` would lapse early if the run
overshot, silently shortening the outage.

## 5. The scenarios

### 5.1 Common skeleton

```
        stop-if-running; drain-check: no `dispatched an entry step` for 40 s
t0      POST /api/v1/orchestration/start   body: "4cd8af45-…"   expect 202
t0+150s inject fault
t0+210s clear fault; wait for observed heal (§5.3); record t_heal
t0+300s POST /api/v1/orchestration/stop    expect 202
+60s    settle
        poll ES until the window's doc count is stable across two reads 10 s apart
        query [t0, t_stop+settle] filtered on WorkflowId; group by CorrelationId
        apply I1–I8 per run
```

At a 30-second cron a 300-second soak yields ten fires. The assertion is
`runs >= 9`, allowing one fire's slop for where `t0` falls relative to the cron
boundary. The fault window sits at 150–210 s so that roughly five runs precede
it cleanly, two straddle it, and three follow it cleanly — the last group is
what proves recovery.

The settle poll is a stability check, not a fixed sleep: OTLP export, collector
batching and Elasticsearch refresh together give a variable ingest lag, and a
fixed sleep either wastes time or reads a half-ingested window.

### 5.2 Restore is unconditional

Every lever is released in a `finally`, and the suite refuses to report a verdict
until the restore is confirmed. A resilience test that leaves Redis at zero
replicas has done more damage than the bug it was looking for.

### 5.3 Fault arrival and heal are observed, never assumed

§4.1 is the reason. Both edges are visible in the logs, so this precondition
needs no metrics:

| Edge | Record |
| --- | --- |
| Redis gone | `L2 gate closed — projection store unusable, consumers paused` · `projection store unreachable — returning message to {Queue}` |
| Redis healed | `L2 gate open — projection store healthy, consumers may run` |
| RabbitMQ gone | `channel shut down: {Reason} — will reopen` · `consumption no longer admitted or the projection store unhealthy — paused consuming {Queue}` |
| RabbitMQ healed | `connection recovered — delivery tags invalidated` · `consumption admitted and the projection store healthy — consuming {Queue}` |

**If the "gone" record is absent, the scenario fails as inconclusive rather than
passing.** `t_heal` is the timestamp of the observed heal record, not
`t0+210s` — RabbitMQ's pod start and topology re-declare take an unbounded time
that the schedule must not pretend to know.

### 5.4 Verdicts, S1–S4

- **S1** — every run complete under I1–I8. `runs >= 9`. Zero tolerance.
- **S2, S3, S4** — three obligations:
  1. **Outside the window**: every run beginning and ending clear of
     `[t_fault, t_heal]` is complete. Zero tolerance. A run that never met the
     fault has no excuse.
  2. **Straddling the window**: each run is complete, or **accounted**. The
     accounting vocabulary is closed, and splits into two tiers, because of
     where each record sits relative to the point a delivery's ids become
     readable:
     - **Run-scoped** — logged inside a handler, after the message is
       deserialized, where the run's own `CorrelationId` exists and lands on
       the record: `the entry-step dispatch failed to send; continuing`,
       `entry absent — treating as a duplicate delivery`, or a `{Result}` of
       `Failed` or `Cancelled` on an outcome record. Each of these names the
       specific run it excuses.
     - **Process-scoped** — logged by `GatedQueueConsumer`'s catch block,
       *above* the deserialization boundary, where the correlation, workflow,
       and step ids are still undecoded bytes and cannot be attached to the
       record: `projection store unreachable — returning message to
       {Queue}`, `refusing message of type {Type} — parking`, `send failed
       while handling {Type} — returning message to {Queue}`. None of these
       can name the run they interrupted, so instead of being read off a
       run's own records, they are read once for the whole
       `[t_fault, t_heal]` window: a straddling short run is accounted if any
       process-scoped excuse appears anywhere in that window, whether or not
       it names this run. That is weaker than a run-scoped attribution — it
       is the strongest claim these records can support, not a compromise
       chosen for convenience.

     **Unaccounted loss must be zero.**
  3. **Recovery**: the first fire beginning after `t_heal` is complete. The
     pipeline heals within one cron period.

`entry absent — treating as a duplicate delivery` is admitted to the run-scoped
tier for S2–S4 but is expected to be **unused** there, because the pause
preserves L2. Its appearance in S2 would mean a blob was lost without Redis
being restarted, which is worth knowing. In S5 it is the expected record.

### 5.5 Verdict, S5

S5 asserts a bounded and attributable blast radius, not zero loss:

1. Loss is **confined to runs in flight at `t_fault`**. A run that began after
   `t_heal` is complete.
2. The wipe is **visible**: `entry absent — treating as a duplicate delivery`
   appears, and the count of runs it truncates is reported.
3. **Recovery is total**: the first fire after `t_heal` is complete under
   I1–I8 — which additionally proves the processor re-established its liveness
   key and the orchestrator resumed dispatching to it.

A run may also be lost because the workflow's own L2 projection was destroyed.
Whether the orchestrator keeps firing from its L1 mirror against a workflow L2 no
longer holds is a real question this scenario will answer; the test reports what
it observes rather than asserting a predicted answer.

### 5.6 Ordering, S4

Pause Redis first, then scale RabbitMQ down; on restore, bring RabbitMQ up first
and only then `CLIENT UNPAUSE`. The consumer needs its channel back before the
gate reopens, or it re-opens the gate against a broker it cannot reach and the
heal records interleave in an order the verifier would have to special-case.

`CLIENT PAUSE` is re-issued on its 30-second keepalive throughout, so the Redis
fault spans RabbitMQ's whole outage including its pod-start time.

### 5.7 Verdict, S6 — processor unavailable

`kubectl scale deploy/processor-sample --replicas=0`, restored to 2.

**Nothing suppresses the dispatch.** `ProcessorLivenessValidator` lives in
`BaseApi.Service` and runs at `POST /start`, not in the orchestrator's dispatch
path, so the orchestrator keeps firing and keeps sending `process-dispatch` to
`ProcessorQueues.Work(processorId)` throughout the outage. Those messages sit in
a durable queue on a broker with a PVC and are drained when the processor
returns. The processor's liveness key expires from L2 meanwhile and is rewritten
on its first beat back.

So S6 is held to the same three obligations as S2-S4 (§5.4), unchanged, with the
same `runs >= 9` floor: the orchestrator never stopped firing, so every fire of
the soak still happened.

**Witnessing S6 needs a service filter, and that is the one new mechanism here.**
The processor's arrival edge is `Application is shutting down...`, which is a
`Microsoft.Hosting.Lifetime` template every service in the deployment emits — so
matching it alone would witness the wrong process. The window query is therefore
additionally filtered on `resource.attributes.service.name`. The heal edge,
`processor healthy; startup loops retired`, is processor-unique and needs no
filter, but takes the same one for symmetry.

The processor's `service.name` comes from its own database row and is currently
`sample-proc-v9`. It is configuration (`SKP_PROCESSOR_SERVICE`), never a
constant: a rebuilt processor changes it, and a hardcoded name would witness
nothing and fail the scenario as inconclusive.

### 5.8 Verdict, S7 — orchestrator unavailable

`kubectl scale sts/orchestrator --replicas=0`, restored to 3.

**This does not violate the "never scale down" invariant, and the reason is
worth stating.** The orchestrator's design forbids reducing its replica count
because each replica owns a durable per-replica queue that would accumulate
forever once its owner was gone. Scaling 3 → 0 → 3 restores the same ordinals —
`orchestrator-0`, `-1`, `-2` — and therefore the same queue names, so no queue is
orphaned. A scenario that restored to a *smaller* count would breach the
invariant; this one does not.

**A fire that never happened is not a lost step.** With no scheduler running, the
cron does not fire for the duration of the outage, so a 60-second window costs
roughly two fires outright. Those runs do not exist to be judged — the ledger
only reasons about runs that started. S7 therefore keeps obligations 1-3 of §5.4
unchanged but **lowers the run-count floor to 7**, because asserting `>= 9`
would fail on the scenario working exactly as intended.

In-flight `step-outcome` messages accumulate in the durable per-replica queues
while the orchestrator is gone. On return, all three replicas rebuild L1 from L2,
re-arm the cron, re-settle the Kubernetes Lease that fences the leader, and drain
their queues.

Both edges are orchestrator-unique, so S7 needs no service filter:
`Scheduler {0} shutting down.` is emitted by Quartz, which only the orchestrator
hosts, and `hydrated {WorkflowCount} workflows from L2; admitting the consumer`
is the hydration record no other role writes.

### 5.9 What S6 and S7 deliberately do not cover

Neither scenario kills a *single* replica to test partial capacity — both take
the whole role away. Rolling-restart behaviour, leader failover with the other
replicas still up, and partial-capacity degradation are all separate questions,
and answering them with a scenario shaped for total outage would answer them
badly.

## 6. Metrics, as corroboration only

Read from Prometheus, reported alongside every verdict, never asserted on:

| Series | Corroborates |
| --- | --- |
| `pipeline_gate_trips_total`, `pipeline_gate_open_ratio` | the L2 gate tripped and reopened |
| `pipeline_consumer_channel_resets_total` | the broker really went away |
| `pipeline_consumer_consuming_ratio` | consumers re-attached per queue |
| `pipeline_messages_produced_total{outcome="transient"}` | sends that failed during the window |
| `pipeline_messages_consumed_total{disposition=…}` | requeues and parks |
| `pipeline_consumer_inflight` | work outstanding at the fault edge |

**These are the exported names, not the instrument names**, and the two differ.
Every gauge declares unit `1`, for which the OpenTelemetry Prometheus exporter
appends `_ratio` — so the code creates `pipeline.gate.open` and Prometheus
serves `pipeline_gate_open_ratio`. Counters take `_total` and are otherwise
unsuffixed; `pipeline.consumer.inflight` is an `UpDownCounter` in `{message}`
and so takes neither. The list above was read back from the live Prometheus
rather than derived, for the reason §7.1 of the pipeline-metrics spec records:
an earlier draft there queried the unsuffixed names and would have matched
nothing.

`pipeline_gate_trips_total` does not currently exist as a series, because the
gate has never tripped in this deployment and a counter with no observations is
absent rather than zero. **Its appearance is therefore itself the evidence**, and
a query for it must treat "no such series" as "never tripped" rather than as an
error.

Metrics carry no `CorrelationId` by design — §2.1 of the pipeline-metrics spec
forbids unbounded ids on instruments — so they cannot attribute loss to a run.
That is precisely why the verdict is log-only and this table is evidence.

## 7. Harness

`src/tests/BaseApi.Tests/Live/Resilience/`:

| Unit | Responsibility |
| --- | --- |
| `RunLedger` | I1–I8 over a run's template histogram. Pure; no I/O. |
| `RunClassifier` | complete / accounted / unaccounted, given a ledger and the window |
| `ElasticLogReader` | one windowed, `WorkflowId`-filtered, paged search → records grouped by `CorrelationId` |
| `StabilityWaiter` | the settle poll of §5.1 |
| `ClusterControl` | `CLIENT PAUSE` keepalive, `kubectl scale`, `rollout status`; `finally`-restore |
| `FaultWitness` | the §5.3 arrival and heal records, and `t_heal` |
| `PromReader` | §6 instant queries |
| `OrchestrationSoak` | the §5.1 skeleton, parameterised by a fault schedule |
| `S1…S5` | five test classes, one scenario each |

`RunLedger` and `RunClassifier` take no dependency on Elasticsearch or the
cluster, so the oracle itself gets **hermetic** unit coverage against captured
JSON fixtures. An oracle that can only be exercised by a five-minute live run is
an oracle nobody will trust.

`ClusterControl` shells to `kubectl`. That is a dependency the existing Live
tests do not have, and it is unavoidable: the fault has to reach pods inside the
cluster, and `TcpForwarder` — the existing lever, used by
`RedisReconnectLiveTests` — can only interpose on the test process's own
connections, never on the pods'.

### 7.1 Gating

These tests run behind **two** environment variables:

```
SKP_REALSTACK=1     the existing Live gate — forwards are open
SKP_CHAOS=1         this suite only
```

`SKP_REALSTACK=1` alone must never scale down cluster infrastructure or pause
Redis. Someone running the existing seven Live tests is asking to talk to the
stack, not to break it. Both gates are read inside the test, for the reason
`RealStack` already documents: a filter-only guard is silently ignored by this
runner.

### 7.2 Configuration

`RealStack` gains, in its existing offset-port style:

| Variable | Default |
| --- | --- |
| `SKP_ES_URL` | `http://localhost:19200` |
| `SKP_PROM_URL` | `http://localhost:19090` |
| `SKP_WORKFLOW_ID` | `4cd8af45-1295-43db-ab2e-e955dd82b5c5` |
| `SKP_K8S_NAMESPACE` | `skp` |

`k8s/port-forward-realstack.ps1` gains `elasticsearch 19200:9200` and
`prometheus 19090:9090`.

## 8. Known traps

1. **Forwards die when their pod restarts.** S3 and S5 restart pods by design.
   No forward targets Redis or RabbitMQ directly, so the ones this suite needs —
   baseapi, elasticsearch, prometheus — are unaffected; but the suite must not
   assume a forward that was up at `t0` is up at verification time, and should
   fail with that diagnosis rather than as a mysterious empty result set.
2. **A dead forward holds its port.** The socket stays bound and the port looks
   free in `netstat` while refusing connections. Preflight every endpoint with a
   real request, not a port check.
3. **Elasticsearch here is one shard holding 4.3 M documents** on a shared dev
   cluster. Every query is bounded by both `@timestamp` and
   `attributes.WorkflowId`; an unbounded aggregation will be slow enough to look
   like a hang.
4. **`sum_other_doc_count` must be zero** on every terms aggregation. A silently
   truncated bucket list is a miscount that reads as a lost step.
5. **The workflow is shared state.** A second person starting the same workflow
   during a soak injects runs the verifier will attribute to the scenario. The
   drain-check at `t0` catches a run already in progress; it cannot catch one
   started at `t0+90s`. This suite assumes exclusive use of the cluster and says
   so rather than pretending to detect it.
6. **`ExecutionId` and `EntryId` are omitted, not zeroed**, when they do not
   apply — an entry dispatch has no execution id, a source step no entry id. The
   verifier must be written for an absent field; treating `Guid.Empty` as a
   sentinel will misgroup entry records.
7. **`role` is orchestrator-only.** It is not a general partition of the records
   and must not be used as one.

## 9. What this suite does not prove

It shows that steps are not lost across a dependency outage. It does not show
that they were executed *once* — a redelivery that re-ran a step and produced a
second, identical branch satisfies I1–I8 as long as the counts move together.
Exactly-once is a separate property needing `ExecutionId` lineage rather than
the run histogram, and it is not in scope here.
