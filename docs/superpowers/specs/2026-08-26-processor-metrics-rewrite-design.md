# Processor metrics and dashboards, rewritten

Date: 2026-08-26
Status: approved, not yet implemented
Scope: `BaseConsole.Core`, `BaseProcessor.Core`, `Messaging.Transport`, `Processor.Sample`, `grafana/`
Supersedes: parts of `2026-08-22-pipeline-metrics-design.md`
Rollback point: tag `pre-metrics-rewrite`

## 1. Why

Two problems, and they are different in kind.

**The boards are wrong.** Panels are redundant and their order carries no
argument. That is a dashboard problem.

**The instrumentation is wrong.** Too much of it reports facts that cannot
change once the process has started, and several series ask the broker rather
than watching the service. That is an instrument problem, and it is the larger
one: a re-layout of the current series would produce a tidier board that still
could not answer where a boot is stuck or why a requeue happened.

So this is new series first, boards built on them second.

## 2. Constraints

| Constraint | Consequence |
| --- | --- |
| **No RabbitMQ HTTP management API.** The broker is org-owned and its owners monitor its performance. | Confirmed already met — a search of `src/` finds no `HttpClient` against the broker, no `:15672`, no `/api/queues`. |
| **`queue.declare` passive over AMQP is permitted.** | The three broker-side levels stay. See section 5. |
| The service reports what it does, not what the broker holds. | Everything else is instrumented from inside the process, on the paths the code takes. |

## 3. The two rules every instrument in this set obeys

**Rule 1 — it must be able to change while the pipeline runs.**

A series that latches once and freezes is not monitoring; it is boot forensics,
which the logs already do well with correlation ids at both ends. Applied to a
first draft of a startup ladder, this rule killed four of six rungs on sight:
`preflight_rabbitmq`, `preflight_redis`, `live_loops` and `schemas` are all
one-way latches. `StartupPreflightService.RunAsync` returns once both
dependencies go green and never re-checks; `StartupGate.MarkReady` and
`ProcessorContext.MarkHealthy` are both `Interlocked.Exchange` one-shots.

Worse than useless in one case: a `preflight_rabbitmq` gauge would sit at 1
while RabbitMQ was down, because the service that set it exited minutes
earlier. That is the confident-green failure this codebase has already been
bitten by more than once.

**Rule 2 — the series must exist from process start, in its pessimistic state.**

An absent series and a healthy one are the same picture from outside, and a
board renders the reassuring one. This is the same principle that makes `L2Gate`
construct *closed*: at startup nothing has been measured, so the honest posture
is the unhealthy one.

Concretely: counters are seeded with `Add(0)` so a loop that never started reads
a flat zero rather than no-data; `identity.ready` reports 0 before anything
resolves; the three broker-side gauges report 0 rather than going absent.

The payoff is on the alerting side. `pipeline_identity_ready_ratio == 0 for 5m`
fires for a replica stuck in boot only because the series exists while it is
stuck. `rate(pipeline_loop_iterations_total{loop="l2-gate"}[5m]) < 0.1` fires
for a loop that died *or never started* only because of the seed. Both are rules
that would look correct on review and quietly never fire without it.

**A corollary used repeatedly below: counters and levels are not substitutes.**
A gauge is sampled at export; an event that happens and reverses between two
reads leaves no trace. A counter accumulates and survives the gap. Conversely a
counter cannot say what is true *now* or for how long. Where both questions
matter, both instruments are kept — and where a level was proposed for
something measured faster than the scrape, the counter won.

## 4. The instrument set

Fourteen instruments, three of them new.

### 4.1 Loops and process

| # | Instrument | Type | Unit | Labels | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | `pipeline.loop.iterations` | Counter | `{iteration}` | `loop` | **new** |
| 2 | `pipeline.process.start.timestamp` | ObservableGauge | `s` | — | **new** |
| 3 | `pipeline.identity.ready` | ObservableGauge | `1` | — | kept |
| 4 | `pipeline.gate.open` | ObservableGauge | `1` | — | kept |
| 5 | `pipeline.gate.trips` | Counter | `1` | — | kept |
| 6 | `pipeline.gate.probe.duration` | Histogram | `s` | `outcome` | kept |

### 4.2 Broker-side levels — passive `queue.declare`

| # | Instrument | Type | Unit | Labels | Status |
| --- | --- | --- | --- | --- | --- |
| 7 | `pipeline.queue.depth` | ObservableGauge | `{message}` | `queue` | kept |
| 8 | `pipeline.queue.consumers` | ObservableGauge | `{consumer}` | `queue` | kept |
| 9 | `pipeline.deadletter.depth` | ObservableGauge | `{message}` | `queue` | kept, now event-driven |

### 4.3 Consumer paths

| # | Instrument | Type | Unit | Labels | Status |
| --- | --- | --- | --- | --- | --- |
| 10 | `pipeline.queue.wait` | Histogram | `s` | `queue` | kept, relabelled |
| 11 | `pipeline.messages.consumed` | Counter | `{message}` | `queue`, `type`, `disposition`, `reason` | kept, `landed` removed |
| 12 | `pipeline.consumer.duration` | Histogram | `s` | `queue`, `type`, `disposition` | **new** |

### 4.4 Egress

| # | Instrument | Type | Unit | Labels | Status |
| --- | --- | --- | --- | --- | --- |
| 13 | `pipeline.messages.produced` | Counter | `{message}` | `route`, `destination`, `type`, `outcome` | kept |
| 14 | `pipeline.produce.duration` | Histogram | `s` | same as 13 | kept |

### 4.5 Label values

| Label | Values |
| --- | --- |
| `loop` | `l2-gate` · `processor-liveness` · `queue-depth` |
| `outcome` (gate probe) | `healthy` · `timeout` · `failed` |
| `disposition` | `acked` · `requeued` · `parked` |
| `reason` | `handled` · `gate_closed` · `send_failed` · `store_unreachable` · `refused` · `escaped` |
| `queue`, `destination` | the queue name |
| `type` | `BasicProperties.Type` off the delivery |

### 4.6 Initial states

| Instrument | Value at process start |
| --- | --- |
| `pipeline.loop.iterations` | seeded `Add(0)` per `loop` value |
| `pipeline.identity.ready` | **0 — unhealthy** |
| `pipeline.gate.open` | **0 — closed** (the gate is constructed closed) |
| `pipeline.queue.depth` / `.consumers` / `pipeline.deadletter.depth` | 0 is a report, never an absence |
| `pipeline.process.start.timestamp` | set once at host build |

## 5. What each new or changed instrument is for

### 5.1 `pipeline.loop.iterations` — new

The rate *is* the liveness signal, and it is strictly better than the health
check it complements. Expected: `l2-gate` 0.2/s, `processor-liveness` 0.1/s,
`queue-depth` 0.1/s. A wedged loop reads 0. A *slow* loop reads 0.12 instead of
0.2, which a stale-window health check cannot express at all — it only fires
past 15s or 30s. That is the two-states problem closed for loops.

Incremented at the top of every iteration, before any I/O, unconditionally —
the same position and the same reasoning as `ILoopHeartbeat.Beat()`: an
iteration whose measurement timed out has still done its job and must count as
alive. Stamping after the I/O, or only on success, turns a dependency outage
into a restart of the process observing it.

**Wiring.** Not inside `LoopHeartbeat`. That type is one of the paired
API/console copies the codebase requires not to diverge — the same constraint
that forces `L2GateMetrics` to instrument the gate from outside. Instead a small
counting decorator around `ILoopHeartbeat`, applied in the DI factories that
already construct heartbeats by hand. No copy diverges, and a loop registered
without its counter is a visible omission at the registration site.

**`queue-depth` becomes a watched loop.** It currently has no heartbeat, no
health check and no metric, and `QueueStatsProbe` states outright that a failed
pass leaves the gauge *reporting the last value it saw*. `TelemetryStale` only
catches the whole export path stopping; one loop dying while the process happily
exports everything else looks perfect. So `QueueStatsProbe.ExecuteAsync` gains a
`Beat()` at the top of every pass and the registration gains a keyed
`ILoopHeartbeat` plus a `live`-tagged `LoopLivenessHealthCheck`.

`live` is right by the argument the gate loop already carries: nothing inside
the process can restart a loop that is gone, so an external restart is the only
repair available.

| Loop key | Cadence | Stale window | Expected rate |
| --- | --- | --- | --- |
| `l2-gate` | 5s | 15s (`Interval` × `StaleFactor` 3) | 0.2/s |
| `processor-liveness` | 10s | 30s (`Interval` × 3) | 0.1/s |
| `queue-depth` | 10s | 30s (`Interval` × 3) | 0.1/s |

The health check and the counter are complementary, not redundant: the check
restarts the pod and is invisible on any board; the rate is visible on a board
and shows slowness before death.

### 5.2 `pipeline.process.start.timestamp` — new

Unix seconds, set once at host build. Restarts over a window are
`changes(...[window])`.

Preferred over a counter incremented once per boot, which only reads as a
restart through `resets()`. **The idiom depends on `InstanceId.Resolve()`
returning `POD_NAME`**, which is stable across container restarts within a pod,
so a restart moves the value on an existing series instead of spawning a new
one. If it ever fell through to the GUID branch every restart would become a
fresh series and this would break silently. Written down here because nothing
else records the dependency.

### 5.3 `pipeline.consumer.duration` — new

Recorded in the `finally` that already moves the in-flight count, so every
terminal path is covered — including parks, which is the point of "regardless of
path".

Bucket ladder: reuse `IngressMetrics.ArrivalSecondsBoundaries()`. Its fine band
is 10ms–250ms with no rung wider than 1.5×, which is where handler time actually
sits, and its 10ms floor is the honest limit given cross-process timestamps.

This replaces `pipeline.process.duration`, which measured only the author's
transform. What is lost is the transform-versus-framework split; with prefetch
fixed at 1 and the framework path a fixed sequence of store reads and sends, the
transform dominates the variance anyway.

### 5.4 `pipeline.deadletter.depth` — now event-driven

The value changes on exactly two occasions: something is parked, or an operator
drains the queue by hand. A 30s poll spends nearly every pass re-reading a
number that cannot have moved.

So: read it **on the park event**, plus a slow safety poll at 5 minutes so a
manual drain is eventually noticed. Without the second half a drained queue
would report a stale non-zero forever, which is the failure this gauge exists to
prevent.

That 5-minute poll is deliberately **not** a watched loop — at that cadence a
`rate()` over a 60s window is noise, and a `live` check that can restart the pod
for a low-consequence poll is a bad trade. The heartbeat stays a per-registration
decision passed explicitly at the call site, with the reason written down: a
visible omission rather than a silent one.

### 5.5 `pipeline.queue.wait` — relabelled

Trimmed to `{queue}` for consistency with `pipeline.queue.depth`. Recorded once
per delivery at pickup, before the gate check — deliberately, so a delivery that
bounced off a shut gate still contributes its wait; dropping it would make the
queue look fastest exactly while the pipeline was stopped.

Two limits that must survive into the panels:

- **It only covers queues this process consumes.** Wait is measured at pickup,
  so no process can report it for a queue it does not read. Depth is different —
  a passive declare needs no consumer, so depth covers the work queue *plus*
  every queue this process has sent to. Fleet-wide the wait coverage closes,
  because each queue is consumed by someone.
- **It double-counts the publisher confirm.** The `SentHeader` is stamped before
  the publish, so roughly 12 of ~13ms is the sender's own confirm, which
  `pipeline.produce.duration` already measures. True broker wait is
  `queue.wait − produce.duration`.

It is also recorded **only if the header is present**, so a message from a build
without the instrument contributes nothing rather than a zero.

### 5.6 `pipeline.gate.trips` and `pipeline.gate.open` — both kept

Neither covers the other.

`gate.trips` counts **transitions** — one increment per open-to-closed edge,
falling edges only, because counting recoveries too would make it mean "changes"
rather than "outages". A 60s store outage is ~12 failed BITs but exactly one
trip, since `L2Gate.SetAsync` returns early when the state is unchanged.

`gate.open` says whether the gate is shut **right now, and for how long**, which
a counter cannot express — a stuck-closed gate stops incrementing it.

The counter earns its place on short trips. `consecutiveHealthy` in the probe
loop is not reset when a *consumer* trips the gate, so the next probe pass —
within 5s — already has two healthy verdicts and reopens it. A consumer-tripped
gate lives at most 5s against a 15s scrape and is almost always invisible to the
gauge. That case is the store failing a real read while the PING keeps
answering, which is precisely the degradation this system is documented as blind
to.

Trip cause is attributable across two panels: a trip coinciding with a
non-healthy BIT is probe-caused; a trip while every BIT reads healthy is
consumer-caused.

### 5.7 `reason` kept, `landed` dropped

`reason` is the why behind a disposition. Six real pairs exist:

| `disposition` | `reason` | What happened | Gate effect |
| --- | --- | --- | --- |
| `acked` | `handled` | the handler ran and returned | — |
| `requeued` | `gate_closed` | the gate was shut when the delivery arrived | already closed |
| `requeued` | `send_failed` | `TransientSendException` — a broker send inside the handler failed | stays **open** |
| `requeued` | `store_unreachable` | `L2FaultClassifier.IsTransient` — the projection store failed | **tripped closed** |
| `parked` | `refused` | unprocessable; no redelivery helps, so it goes to the DLX | — |
| `requeued` | `escaped` | threw outside the classified path; the broker was never told | — |

Without `reason` all four requeue causes collapse into one number, and
`gate_closed` dominates it: during any store outage every in-flight delivery
bounces off the shut gate. That benign flood would bury `send_failed` (a broker
fault inside a handler) and `escaped` (an unhandled path — a bug), leaving a
requeue spike you can see but not triage. Cardinality is six real pairs, not
3 × 6.

`landed` — whether the broker was ever told — is dropped. **Consequence on the
record:** a `parked` count now includes deliveries the broker never heard about,
which are **redelivered rather than dead-lettered**. `pipeline.deadletter.depth`
is the check: parks that do not appear there did not land.

## 6. Removals

| Instrument | Why |
| --- | --- |
| `pipeline.consumer.consuming` | The process asserting its own health, which is why every board wraps it in a liveness window. `pipeline.queue.consumers` is broker-side, reads 0 the instant a consumer detaches, needs no window, and survives the replica going away. |
| `pipeline.consumer.inflight` | Designed to be read against `PrefetchCount` for saturation. Prefetch is 1, so it is 0 or 1 and says nothing. |
| `pipeline.consumer.channel.resets` | Existed to explain `landed=false`, which is dropped. A lost ack now shows as an extra `consumed` increment. |
| `pipeline.process.duration` | Subsumed by `pipeline.consumer.duration` (5.3). Its `AddView` in `ProcessorHost.Create` goes with it. |
| `pipeline.step.elapsed` | Removed from the set by decision, with its cost on the table at the time. **Correction, 2026-08-26:** an earlier draft of this row said "out of scope for the processor board", which was factually wrong — it was never on the processor board. It lived on **SKP Flow**, so removing it takes the only door-to-door measure of what a workflow experiences off a board this rewrite does not otherwise touch. The removal stands; the reason given for it did not. See §10.4. |
| `pipeline.duplicate.suppressed` | That path returns normally and the delivery is ACKed, so it is counted there. **Consequence:** the acked count now mixes real transform runs with skipped duplicates, and the "entry absent" condition — which `ProcessDispatchHandler` documents as possibly a *silent loss* rather than a safe duplicate — has only its log line left. |

`ProcessorPipelineMetrics`' own two instruments are both removed; its `Meter`
survives because `pipeline.identity.ready` hangs off it.

## 7. Dashboard

| # | Panel | Query |
| --- | --- | --- |
| 1 | Loop rate | `rate(pipeline_loop_iterations_total[$__rate_interval])` by `(loop, instance)` |
| 2 | L2 BIT verdicts | `rate(pipeline_gate_probe_duration_seconds_count[...])` by `(outcome)` |
| 3 | L2 BIT duration | `rate(_sum{outcome="healthy"}) / rate(_count{outcome="healthy"})` |
| 4 | L2 gate | `pipeline_gate_open_ratio` by `(instance)`, with `increase(pipeline_gate_trips_total[1h])` |
| 5 | Identity ready | `pipeline_identity_ready_ratio` by `(instance)` |
| 6 | Restarts | `changes(pipeline_process_start_timestamp_seconds[1h])` by `(instance)` |
| 7 | Queue depth | `max by (queue) (pipeline_queue_depth)` |
| 8 | Consumers attached | `max by (queue) (pipeline_queue_consumers)` |
| 9 | Dead-letter depth | `max by (queue) (pipeline_deadletter_depth)` |
| 10 | Consumer paths | `rate(pipeline_messages_consumed_total[...])` by `(queue, disposition, reason)` |
| 11 | Queue wait | mean by `(queue)`, raw and net of produce — see below |
| 12 | Consumer duration | mean by `(queue, disposition)` |
| 13 | Produce duration | mean by `(destination)` |

Thirteen panels, one instrument family each. Nothing is bundled: an earlier
draft put queue wait, consumer duration and produce duration in a single
"Durations" row, which left `pipeline.queue.wait` without a panel of its own and
three unrelated questions sharing an axis.

### 7.1 The queue-wait panel

It carries **two series**, because the raw number is the one that is wrong and
the corrected one is the one that is approximate.

**Raw** — what the instrument records:

```promql
avg by (queue) (
  rate(pipeline_queue_wait_seconds_sum[$__rate_interval])
  / rate(pipeline_queue_wait_seconds_count[$__rate_interval])
)
```

**Net of the publisher confirm** — the double count from 5.5 removed:

```promql
avg by (queue) (
  rate(pipeline_queue_wait_seconds_sum[$__rate_interval])
  / rate(pipeline_queue_wait_seconds_count[$__rate_interval])
)
- on(queue) group_left
avg by (queue) (
  label_replace(
    rate(pipeline_produce_duration_seconds_sum[$__rate_interval])
    / rate(pipeline_produce_duration_seconds_count[$__rate_interval]),
    "queue", "$1", "destination", "(.*)")
)
```

> **Correction, 2026-08-26 — the expressions above are shown without a dashboard
> variable filter, and that omission was load-bearing.** An earlier draft
> interpolated the processor board's own worker filter into *both* halves. That
> makes the net series **permanently empty**: the produce term is emitted by the
> **sender**, a different service, which cannot match a filter naming the
> processor. In the generator the two halves take **separate** filters — the
> wait side the consuming host's, the produce side a `destination=~…` filter —
> the way `depth_panels` already does. Verified live once corrected: raw 23.2ms,
> net 12.1ms, which matches the documented ~12ms publisher-confirm double-count.

Four things about that expression are load-bearing and each fails silently if
got wrong. The filter split above is the fourth; these are the other three:

- **`label_replace` is required.** Wait is labelled `queue`; produce is labelled
  `destination`. They hold the same string and no vector match joins them
  without the rename.
- **`avg by (queue)` on both sides, before the subtraction.** The two halves are
  emitted by *different processes* — the sender publishes to a queue the
  consumer reads — so `instance` and `job` differ and an unaggregated match is
  many-to-many, which returns nothing rather than erroring.
- **The result is a difference of two means over different populations**, so it
  is directional rather than exact. At these latencies the correction is roughly
  12ms out of 13ms, so the net series is the one worth reading and the raw
  series is there to show how much of it was never broker wait at all.

A net value near zero is the normal, healthy reading. A net value that grows is
real queueing.

Standing rules for every panel in this set:

- **Means, not quantiles**, on every histogram. Quantiles off these ladders are
  interpolation between rung edges, and at the sample counts these boards see
  they flip between levels.
- **`max by (queue)`, never `sum`**, on the three broker-side levels. Every
  replica reports the same broker fact for a shared queue, so summing multiplies
  depth by the replica count.
- **Mind the `_ratio` suffix.** `pipeline.gate.open` and
  `pipeline.identity.ready` both carry `unit: "1"`, which makes the Prometheus
  exporter append `_ratio`. That is where `pipeline_gate_open_ratio` comes from.
  Either query the suffixed names as written above, or change the units to
  `{state}` — but not one without the other.

Boards are generated by `grafana/build-dashboards.py`. The JSON under
`grafana/dashboards/` is output and must not be hand-edited.

## 8. Cleanup of existing metrics and comments

The removals in section 6 leave dangling cross-references. This codebase's XML
comments carry the reasoning, so a stale one is a wrong explanation rather than a
cosmetic defect. The implementation reviews and cleans all of them; the known
ones are:

| Location | What goes stale |
| --- | --- |
| `QueueDepthMetrics` remarks | The "consumers is broker-side truth, which nothing else here is" paragraph compares against `pipeline.consumer.consuming`, which is removed. The comparison still holds; the named instrument no longer exists. |
| `L2GateMetrics` remarks | Cites `IngressMetrics`' consumer gauge as the duplicate-stream precedent. That gauge is removed; the hazard is unchanged and needs a surviving citation. |
| `IngressMetrics.RecordConsumed` remarks | Explain the `disposition` / `reason` / `landed` separation. `landed` is gone. |
| `IngressMetrics.ArrivalSecondsBoundaries` remarks | Largely tuning history for `pipeline.step.elapsed`, which is removed. The ladder survives and now serves `queue.wait` and `consumer.duration`, so the rationale must be re-pointed rather than deleted. |
| `ProcessorHost.Create` | The `AddView` targeting `ProcessDurationInstrument` and the paragraph explaining it. |
| `ProcessorPipelineMetrics` | Empties to a `Meter` plus `identity.ready`; the type remarks describe instruments that no longer exist. |
| `ProcessorStartupOrchestrator`, `QueueStatsProbe`, `DispatchedQueues` | Reviewed, expected to stand unchanged. |

A comment naming a removed instrument is treated as a defect on the same footing
as a broken reference.

## 9. Non-goals

| Not doing | Why |
| --- | --- |
| ACK split by step outcome (`Completed` / `Failed` / `Cancelled`) | Explicitly excluded. A failed step is still an ACKed delivery — the outcome leaves as a message, and the ACK only says the delivery was handled. |
| Instrumenting the pre-identity boot window | The OTel provider is built in Stage 2 and its resource freezes then; Stage 1 runs before any meter exists. Measuring it would need Stage 1 to hand a tally forward, which is a seam not worth adding. |
| A periodic reply-path check | `ReplyQueueConsumer` is dormant between boots. New machinery for a path that only runs at startup. |
| A liveness-write failure counter | Considered and cut. `ProcessorLivenessWriter` swallows Redis faults, so a processor whose L2 writes all fail beats at full rate while publishing nothing. Recorded here as a known blind spot. |
| Orchestrator and API observability | This design covers the processor. `BaseApi.Core`'s own gate and probe remain a separately recorded gap. |

## 10. Known gaps left open

1. **The liveness write is unwitnessed** (section 9). A processor invisible in L2
   is excluded from orchestration with nothing saying why.
2. **`GatedQueueConsumer` starts before Loop B finishes.** The consumer begins on
   the gate's opening edge and nothing consults `IProcessorContext.IsHealthy`
   first, so a dispatch can arrive while definitions are unresolved. Both
   handlers park such a dispatch. Already recorded in the execution-path plan;
   unchanged by this design.
3. **The 210s queue-wait cycle** remains open, with `QueueDepthProbe` accused and
   not convicted. Keeping the probe keeps the suspicion live.
4. **`pipeline.step.elapsed` leaves the flow board, not the processor board.**
   Recorded here because §6's original one-line justification for its removal
   was wrong, and a wrong reason outlives a right decision.

   The instrument was never on the processor board. It lived on **SKP Flow**,
   where it was the only measurement of what a *workflow* experiences
   door-to-door rather than what a component does — added because a chaos
   scenario showed nothing without it. Removing it from the set therefore takes
   a panel off a board this rewrite does not otherwise touch.

   The removal stands: it was decided with that cost explicitly on the table.
   What did not stand was calling it out of scope for a board it was never on.
   If the flow board's door-to-door question turns out to matter more than the
   leanness this set was trimmed for, the instrument is restorable — it is one
   histogram and one `RecordArrival` argument, both recoverable from the
   `pre-metrics-rewrite` tag.

---

## 11. Corrections to §7's panel table, found during implementation

**`by (instance)` is wrong wherever §7's table uses it — read `service_instance_id`.**

Three rows of the §7 table group by `instance`. In this deployment `instance` is
the **scrape target**, which every replica of a service shares; grouping by it
collapses all replicas into one series and makes a per-replica panel silently
useless — every legend renders the same label. The per-replica dimension is
`service_instance_id`, which is what the generator's own variable and its
existing panels use.

This surfaced when the loop-rate panel's legend was implemented from §7
literally and every replica's series came back with an identical label. The
generator is correct; the spec's table was not.

**§7 row 6 (Restarts) is implemented as an aggregate, not a per-replica
breakdown.** `max(changes(pipeline_process_start_timestamp_seconds{…}[1h])) or
vector(0)` answers "how many times did the worst-affected replica restart",
which is the question a verdict-tier stat should ask. A per-replica breakdown
remains available and is partly covered already by the pre-existing
`Process restarts` panel, which groups by `service_instance_id` — though via
runtime counter resets rather than this gauge. Recorded rather than changed: the
aggregate is the right shape for the tier it sits on, and the spec's `(instance)`
was wrong in any case.
