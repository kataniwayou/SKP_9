# Processor liveness — design deltas

Scope: the deltas between the reference processor design (`references/src/BaseProcessor.Core/`) and
what `/src` needs when the processor host is built. Written after confirming the current design
against the code; the confirmed-correct invariants are listed in the last section so they are not
"fixed" by accident.

**Status:** Deltas 1–4 are implemented, along with the processor host's discovery and liveness
loops. Gate A and the dispatch endpoint are still outstanding — see *Not built yet* below.

**Status of `/src` before that work:**

- `src/BaseProcessor.Core` is six files — options, `IProcessorContext` / `ProcessorContext` /
  `ProcessorIdentity`, `ISourceHashProvider` / `AssemblyMetadataSourceHashProvider`, and
  `ProcessorLivenessWriter`.
  Nothing in `/src` consumes any of them except tests. There is no processor host, no Loop A, no
  Loop B, no Gate A, no liveness loop, and no `Observability/` folder.
- `src/BaseConsole.Core` is nine files — `Health/` (2), `Loop/` (3), `Messaging/` (4). There is no
  `DependencyInjection/` folder, no `Observability/` folder, no Redis registration and no correlation
  filters, so none of the layering rules below are yet enforced by code that exists.

The deltas and the layering rules apply when those are written. The one live exception is the
`L2Gate` / `LoopLivenessHealthCheck` work in `BaseApi.Core` and `BaseConsole.Core`, marked **Done**
below.

---

## Delta 1 — Per-loop heartbeat holders with a retirement state — **DONE**

### The gap

`ILoopHeartbeat` is registered as a single unkeyed singleton
(`src/BaseApi.Core/DependencyInjection/MessagingServiceCollectionExtensions.cs:74`), and every
`LoopLivenessHealthCheck` resolves that one instance. In the reference the only caller of `Beat()` is
`ProcessorLivenessHeartbeat`; `L2GateProbe` is the only caller in `/src`. Each assumes it is the sole
beater — `src/BaseApi.Core/Gating/L2GateProbe.cs:9-15` calls itself "the only evidence this process
is still capable of recovering from an outage."

That assumption breaks the moment a processor runs more than one loop. Planned loops per processor:

1. the liveness loop (L2 writes, 10s fixed cadence),
2. the startup orchestrator (Loop A then Loop B, exponential backoff),
3. a future gate-L2 probe, mirroring `L2GateProbe`.

With one shared holder, the fastest loop's beat refreshes the stamp for all of them, so a dead loop
is invisible for as long as any sibling still ticks. Concretely: a wedged Loop A is undetectable
today, because the 10s liveness loop keeps the stamp fresh. The pod stays `/health/live` green,
`/health/ready` red, and **a failing readiness probe does not restart a container** — so it lives
indefinitely and never serves.

### The change

**Keyed holders, one per loop.** .NET 8 keyed DI is available (`net8.0` per `Directory.Build.props`):

```csharp
services.AddKeyedSingleton<ILoopHeartbeat, LoopHeartbeat>("liveness");
services.AddKeyedSingleton<ILoopHeartbeat, LoopHeartbeat>("startup");
services.AddKeyedSingleton<ILoopHeartbeat, LoopHeartbeat>("gate-l2");
```

**One health check registration per loop**, each with its own name and window, rather than one
aggregate check — so the failing check name identifies which loop died.

**A third heartbeat state: retired.** `ILoopHeartbeat` today has two states — `Last == null` (never
started) and a timestamp (running). A startup loop legitimately stops beating when Loop B completes;
without a terminal state its check reports stale one window later and kills a healthy processor. This
is the mechanism behind the "the role of the loops is finished" concern.

```csharp
public interface ILoopHeartbeat
{
    DateTimeOffset? Last { get; }
    bool IsRetired { get; }   // NEW: terminal, one-way
    void Beat();
    void Retire();            // NEW: idempotent latch
}
```

`Retire()` is a one-way latch on the `StartupGate` idiom — `Interlocked.Exchange` write,
`Volatile.Read` read (`src/BaseConsole.Core/Health/IStartupGate.cs:29-37`), since `Interlocked` has
no bool overload in .NET 8.

Check order, which must be exactly this:

| State | Result |
|---|---|
| `IsRetired` | Healthy — "completed" (checked **first**, so a retired loop never reads stale) |
| `Last is null` | Unhealthy — "not started" |
| `now - Last >= window` | Unhealthy — "stale" |
| otherwise | Healthy — "running" |

Retire after the final beat. The race is benign: a check landing between the last beat and `Retire()`
still passes the window test.

### Who retires

- **Startup orchestrator** — `Retire()` on both terminal paths: after `MarkHealthy()` on the
  pass/skip path, and on the Gate-A clash path.
- **Gate-A clash refresh loop** — the clash path keeps re-stamping L2 forever
  (`ProcessorStartupOrchestrator.cs:242-257`). Decide one of: retire the startup heartbeat and let
  the refresh loop run unwatched, or keep beating it at the refresh cadence (`IntervalSeconds`, 10s)
  and leave it unretired. **Recommendation: keep beating.** The refresh loop is what holds the
  replica visible as `unhealthy` rather than letting it decay to `absent`, so a wedge there is worth
  detecting.
- **Liveness loop and gate-L2 loop** — never retire; they run for process life.

### Breaking change

Both existing checks bind their window to a specific options type —
`src/BaseApi.Core/Gating/LoopLivenessHealthCheck.cs:32` takes `IOptions<L2GateOptions>`,
`src/BaseConsole.Core/Health/LoopLivenessHealthCheck.cs:14` takes `IOptions<ConsoleLoopOptions>`.
Neither can express a per-loop window. Change both to take a plain `TimeSpan window` and a loop name,
and compute the window at the registration site.

The boundary split between the two copies is already settled: both now use `>= window`, so the
instant at exactly the window counts as stale. **Done.**

---

## Delta 2 — The startup-loop window derives from the backoff cap — **DONE**

The two loop families have different cadences, so they cannot share a staleness window.

| Loop | Cadence | Worst gap between beats | Window |
|---|---|---|---|
| Liveness | fixed 10s | 10s + write | `Interval × StaleFactor` = 10 × 3 = **30s** |
| Startup (A/B) | backoff 1→2→4→8→16→30s (capped) | cap 30s + `RequestTimeout` 8s = **38s** | `BackoffCap × StaleFactor` = 30 × 3 = **90s** |

Applying the liveness window (30s) to the startup loops reports a perfectly healthy backing-off loop
as dead at the cap. The 90s window leaves better than 2× margin over the 38s worst case.

Worst gap is `cap + RequestTimeout` because the beat is at the top of the iteration: beat → request
(up to `RequestTimeoutSeconds`) → backoff delay (up to cap) → next beat.

---

## Delta 3 — Restore two config settings — **DONE**

`src/BaseProcessor.Core/Configuration/ProcessorLivenessOptions.cs` has three settings; the reference
has six. Two of the three dropped are prerequisites for the startup loops.

### `BackoffCap` (default 30)

Loop A and Loop B are unbounded retry loops with a doubling delay capped at this value
(`ProcessorStartupOrchestrator.cs:98,315`). There is no cap in `/src` at all, so the loops cannot be
written as designed, and Delta 2's window has nothing to derive from.

### `StartupInterval` (default 30)

The `interval` value recorded on the startup `unhealthy` entries, distinct from the heartbeat's
`IntervalSeconds`. It drives both the derived TTL and the reader's staleness math. The arithmetic is
why it cannot be dropped:

| Recorded interval | Derived TTL — `max(interval × 2, TtlSeconds)` | vs. 38s worst-case write cadence |
|---|---|---|
| `StartupInterval` 30 | `max(60, 30)` = **60s** | 60 > 38 ✅ |
| `IntervalSeconds` 10 | `max(20, 30)` = **30s** | 30 < 38 ❌ |

Without it, a replica backing off at the cap lets its own key expire between its own writes. It then
reads as **absent** rather than **unhealthy** — both block the 422, but the diagnostic counts in
`ProcessorLivenessValidator.cs:81-82` become wrong, and it contradicts the design intent that a
replica is never absent after identity resolves.

The same value keeps the reader consistent: `entry.Timestamp.AddSeconds(entry.Interval * 2)`
(`ProcessorLivenessValidator.cs:74`) gives a 60s freshness window from a recorded 30, matching the
TTL exactly.

`ExecutionDataTtl`, the third dropped setting, is unrelated to liveness — leave it out until the
execution-data path is built.

`ProcessorLivenessWriter.WriteAsync` needs no change: it already derives TTL from `entry.Interval`
(the *recorded* value) rather than live config
(`src/BaseProcessor.Core/Liveness/ProcessorLivenessWriter.cs:41`), so parameterising the recorded
interval is enough.

---

## Delta 4 — Transition logging — **DONE for what exists**

**Rule: log the edge, not the iteration.** Every loop here runs on a 10–30s cadence for process life;
anything logged per tick is unreadable within an hour and hides the transitions that matter. A value
written every tick gets logged only when it *changes*.

### Missing in `/src`

| Point | Level | Status |
|---|---|---|
| `L2Gate` open/close | Information / Warning | **Done** — logged inside `SetAsync`, after the transition guard |
| L2 liveness status change | Information | Outstanding — see the note below on where it belongs |

**Where the `L2Gate` log went, and why not where this doc first said.** The initial recommendation was
to log from the probe or a `StateChanged` subscriber rather than inside `SetAsync`, on the grounds
that `SetAsync` holds the mutex. That was wrong on both halves. The probe calls `ReportHealthyAsync`
and `TripAsync` on *every* tick and cannot tell a transition from a no-op, so a call-site log emits a
line per tick — exactly what the edge-not-iteration rule forbids. And `StateChanged` subscribers are
themselves invoked under the mutex (`L2Gate.cs:100`), so moving the log there buys nothing. `SetAsync`
after the `_isOpen == open` early return is the only place that knows a transition happened. The
mutex concern in the type contract is about I/O and broker round-trips in *subscribers*, not about an
in-memory `ILogger` call.

Closing logs at Warning (consumption pauses); opening at Information (that's the recovery).

**The liveness status-change log does not belong in `ProcessorLivenessWriter.`** Detecting an edge
needs previous-status state, and the writer is a stateless singleton called by two different loops
with different entries — tracking last-status inside it would conflate them and report false edges as
the two loops interleave. Each loop knows its own transitions; the log belongs in the callers.

### Missing in the reference, to add when porting

| Point | Level |
|---|---|
| First post-identity L2 unhealthy write | Information |
| Loop B complete / entering Gate A | Information |
| Gate A pass | Information |
| Entering the Gate-A clash refresh loop | Warning |
| Liveness loop first beat + `MarkReady` | Information |
| Any loop `Retire()` (Delta 1) | Information |

Each refresh-loop write stays unlogged — it is a tick, not an edge.

### Already logged in the reference — keep

Identity resolved (`:122`); identity not-found / timeout / transient-fault retries (`:135,140,147`);
definition resolved (`:185`); schema retries (`:189,194,201`); Gate A clash as Error (`:221`);
endpoints bound + reached Healthy + gate ready (`:293`); liveness write failure as Warning
(`ProcessorLivenessHeartbeat.cs:131`).

---

## Blocked: `ReplyQueueConsumer` broker paths cannot be unit tested

`ReplyQueueConsumer` takes the **sealed** concrete `RabbitMqConnection`
(`src/Messaging.Transport/RabbitMqConnection.cs:31`), which cannot be substituted, and
`EnsureStartedAsync` calls `GetAsync` — a real broker connect. `SafeAckAsync` is private and reachable
only through the private `OnReceivedAsync` event handler. So the self-healing rebind and the ack
race, both fixed in `ba57468`, have no unit-test route. `RpcQueueConsumer` has the identical shape and
the same absence of tests, so this is the codebase's existing posture rather than a regression.

Unblocking it needs one of:

1. **Extract `IRabbitMqConnection`** from the sealed class and depend on the interface. Touches
   `Messaging.Transport` plus every consumer. A production change made purely for testability, but it
   is the only route to unit-testing any broker path in this codebase.
2. **Cover it in the RealStack integration harness** instead, where a real broker can be stopped and
   restarted to exercise the rebind for real — which is the only way to test it honestly anyway.

Option 2 tests the behaviour that actually matters (a broker that really goes away); option 1 tests
the code shape. Prefer 2, and take 1 only if the harness cannot cycle a broker mid-run.

---

## Layering rules — which assembly owns what

Verified against the code. These decide where each delta's new code goes.

### The reference graph

```
Messaging.Contracts  ← shared by everything (log-attribute names live here)
        ↑
BaseConsole.Core  →  BaseProcessor.Core
        ↑
   (BaseApi.Core does NOT reference BaseConsole.Core — see the duplication note)
```

`src/BaseProcessor.Core.csproj` references `BaseConsole.Core`; `src/BaseApi.Core.csproj` references
only `Messaging.Contracts` and `Messaging.Transport`.

### BaseConsole.Core owns

| Concern | Where |
|---|---|
| Redis client | `ConsoleRedisServiceCollectionExtensions.AddBaseConsoleRedis` — one singleton `IConnectionMultiplexer`, lazy connect, no startup probe and no health check ("soft dependency") |
| OpenTelemetry | `BaseConsoleObservabilityExtensions.AddBaseConsoleObservability` — MEL log bridge, metrics, OTLP exporter, resource shape |
| Logger pipeline | same extension; it takes the *host builder* because `builder.Logging.AddOpenTelemetry` needs `ILoggingBuilder`, not `IServiceCollection` |
| Metric **tag names** | `Observability/ConsoleMetricTags` — `workflowId`, `processorId` |
| Correlation log scope | `Messaging/InboundCorrelationConsumeFilter` → `logger.BeginScope(CorrelationKeys.LogScope)` |

The `source` parameter on `AddBaseConsoleObservability` (`orchestrator` / `processor` / `webapi` /
`keeper`) is **required, not defaulted**, so a new console cannot ship without stamping who emitted a
record.

`src/BaseConsole.Core.csproj` already carries the `StackExchange.Redis` package reference with no
Redis code yet — the registration slot is reserved at the right layer.

### Log conventions are split across two assemblies, deliberately

- **camelCase metric tags** → `BaseConsole.Core.Observability.ConsoleMetricTags`
- **PascalCase log attributes** → `Messaging.Contracts.ExecutionLogScope`

They are held apart on purpose: log keys must equal their structured-parameter names so they surface
at `attributes.<Key>` in Elasticsearch, while metric tags follow OTel's camelCase convention. The
centralisation exists because `processor_spawn_dropped` once shipped tagged PascalCase `"ProcessorId"`
while every sibling counter used camelCase — nothing failed loudly, the counter simply fell out of
every PromQL join, and the drift survived until it was spotted in live label output.

So "BaseConsole.Core owns log conventions" is **BaseConsole.Core + Messaging.Contracts**.

### BaseProcessor.Core owns

| Concern | Where |
|---|---|
| Startup discovery flow | `Startup/ProcessorStartupOrchestrator` — Loop A, Loop B, Gate A |
| Liveness loops | `Liveness/ProcessorLivenessHeartbeat`, `ProcessorLivenessWriter`, `ProcessorLivenessState` |
| Processor-only metric label | `Observability/ProcessorMetrics.IdentityNameTag` = `identityName` |
| Processor-only log attributes | `Observability/ProcessorIdLogEnricher` — `ProcessorId`, `IdentityName` |

The boundary is asserted from both sides in code, which is what keeps it honest:

- `ConsoleMetricTags`: *"NOT here: `identityName`. It is processor-only… built from
  `IProcessorContext`, a type this assembly does not know."*
- `ProcessorMetrics`: *"the cross-service `workflowId`/`processorId` tags are NOT declared here — they
  are shared… via `BaseConsole.Core.Observability.ConsoleMetricTags`."*
- `ProcessorIdLogEnricher`: *"Registered ONLY on the processor's logger provider (NOT the shared
  BaseConsole.Core observability extension)."*

### Identity is post-discovery — but logs and metrics differ on how

This is the rule most likely to be implemented wrongly, because the two signals are **not**
symmetric.

| Signal | Before discovery | Why |
|---|---|---|
| Logs | attribute **absent** | `ProcessorIdLogEnricher.OnEnd` returns early on `context.Id is null`. A missing attribute is simply absent; never `Guid.Empty` |
| Metrics | label **present**, value `"unresolved"` | omitting a label mints a *second* time series with a different label set, so the tag is always emitted — `ProcessorMetrics.IdentityNameOf` |

In practice the metric fallback should never appear: the business counters can only fire
post-identity, because the dispatch queue binds after Loop A. If `identityName="unresolved"` shows up
in Prometheus, that is the visible signature of a WR-03 torn read of the unsynchronised
`Name`/`Version` properties, not a normal startup state. Both the enricher and `IdentityNameOf` guard
`Name`/`Version` **independently of `Id`** for that reason — a visible `Id` does not guarantee both
are visible.

Related: the processor keeps `service.name = unresolved_0.0.0` for its whole process life. There is
no MeterProvider swap on identity resolution — the resource is console-owned and fixed, and the DB
identity rides per-datapoint (`identityName`) and per-record (`ProcessorId` / `IdentityName`). That
is precisely what lets the console tier own observability without knowing anything about discovery.

### Where the deltas land

| Delta | Assembly |
|---|---|
| 1 — keyed heartbeat holders, retirement | `BaseConsole.Core.Loop` (the processor inherits it); `BaseApi.Core.Gating` separately, see below |
| 2 — per-loop staleness windows | registration sites: the processor host and `BaseApi.Core` |
| 3 — `BackoffCap`, `StartupInterval` | `BaseProcessor.Core.Configuration.ProcessorLivenessOptions` |
| 4 — transition logging | at each transition's own owner: `BaseApi.Core.Gating.L2Gate` (done); the liveness status edge in `BaseProcessor.Core`'s loops, **not** in the shared writer |

### Note: the heartbeat triplet is duplicated on purpose

`ILoopHeartbeat`, `LoopHeartbeat` and `LoopLivenessHealthCheck` exist twice in `/src` —
`BaseApi.Core/Gating/` and `BaseConsole.Core/Loop/` + `Health/`. That is structural, not an accident:
`BaseApi.Core` does not reference `BaseConsole.Core`, because the API tier is a web service with its
own observability wiring (AspNetCore and Http instrumentation packages the console tier deliberately
omits). **Do not "fix" it by making `BaseApi.Core` depend on `BaseConsole.Core`** — that would drag
the console's worker-shaped OTel and hosting model into the API. Delta 1 has to be applied to both
copies independently, and Delta 4's boundary reconciliation (`>=`) already was.

---

## Not built yet

The host discovers its identity and reports liveness. Two pieces of the reference design are
deliberately absent, and both have a defined insertion point:

- **Gate A** — the config-schema coverage check (schema ⊨ `TConfig`). Needs `IConfigTypeProvider` and
  `ConfigSchemaCoverageCheck`, neither of which exists in `/src`. It belongs in
  `ProcessorStartupOrchestrator.RunStartupAsync` between the end of Loop B and `MarkHealthy()`, and
  on a clash it must publish `configOutcome: Fail` explicitly, mark the startup gate ready, withhold
  `MarkHealthy`, and keep re-stamping the unhealthy entry rather than returning.
- **The dispatch endpoint bind** — needs the processing pipeline. It goes immediately before
  `MarkHealthy()`, marked with a comment at that line. Binding after the latch would advertise the
  processor as healthy while its queue does not exist.

Also outstanding: no processor executable. `AddBaseProcessor` wires the library; a `Processor.Sample`
host with its own appsettings, source-hash embed target and manifests is a separate piece.

### Orphaned by Delta 1

`BaseConsole.Core.Loop.ConsoleLoopOptions` is now referenced by nothing. `LoopLivenessHealthCheck`
took its `Interval`/`StaleFactor` before the window became a constructor argument, and `GracePeriod`
was never used — `IReplyEndpoint.EnsureStartedAsync` awaits the broker's own consume confirmation,
which is the guarantee the cushion was approximating. Delete it unless a future console tier claims
it.

### The two `ILoopHeartbeat` copies have diverged

`BaseConsole.Core.Loop.ILoopHeartbeat` now carries `IsRetired`/`Retire`; the `BaseApi.Core.Gating`
copy does not. That is deliberate — the API tier runs one loop that never finishes, so retirement
there would be an API with no caller. Revisit only if the API grows a second loop.

---

## Deferred — metrics configuration and labels

**Decision: not now.** Recorded so the analysis is not re-derived later.

### The finding

`identityName` is a redundant label on the business counters. All four increment sites
(`EntryStepDispatchConsumer:42`, `OutputTail:166`, `PostProcessConsumer:50`,
`ProcessorPipeline:317`) already carry `processorId` immediately above it, and `identityName` is
`{Name}_{Version}` from the DB row keyed by that same `processorId` — a 1:1 static mapping. The label
is denormalization, and `ProcessorMetrics.UnresolvedIdentity` (`"unresolved"`) exists only to stop a
denormalized label from splitting the series before identity resolves.

It reads as a leftover from the MLBL-03 migration: the MeterProvider swap was removed, `{Name}_{Version}`
moved from the resource onto the datapoint, and its overlap with `processorId` was not revisited.

### The proposed fix, when it is picked up

Defer the *one instrument that needs identity*, not the metrics pipeline. Drop `identityName` from the
four business counters and emit the mapping once as an info metric — an `ObservableGauge` whose
callback yields **zero measurements** until identity resolves, so the series does not exist before
then and no fallback value is ever needed. Dashboards join on
`* on(processorId) group_left(identityName) processor_identity_info`. This is the standard Prometheus
info-metric pattern (`kube_pod_info`, `node_uname_info`).

`UnresolvedIdentity` and `IdentityNameOf` are then both deletable. Logs are unaffected — the enricher
omits rather than falls back, which is already correct for logs.

**Do not** defer the whole MeterProvider to after identity. It also feeds
`AddRuntimeInstrumentation()` and the MassTransit meter, and startup is unbounded by design (Loop A
retries forever against boot-before-register), so that would blind the runtime and broker metrics for
exactly the window where a processor is stuck. Building a second provider later is the swap that was
already removed for splitting every metric family across two `service_name` values.

The cost of the info metric is that panels wanting the human-readable name need a `group_left` join.

### Not deferred: the WR-03 read in the consume path — context half **DONE**

Separable from the metrics work and worth treating on its own, because it is a correctness risk
rather than a labelling one.

`EntryStepDispatchConsumer:35-36` justifies its `context.Id!` with *"Consume runs ONLY
post-MarkHealthy (the runtime binds queue:{id:D} AFTER Healthy)"*. That is backwards. The orchestrator
binds the entry endpoint, awaits `handle.Ready`, binds the `-post` endpoint, awaits `postHandle.Ready`,
and only then calls `MarkHealthy()` (`ProcessorStartupOrchestrator.cs:268-291`). The entry consumer is
live for the whole second bind — a broker round-trip — and the dispatch queue is durable and a
competing consumer, so a restarting replica can pick up a backlog inside that window.

In that window a consumer thread reaches `context.Id!.Value` with no barrier having published it. A
null read there is an `InvalidOperationException` in the consume path, not a bad label.

**Done on the context side.** The nine plain auto-properties are replaced by a single immutable
`ProcessorIdentity` snapshot behind one field, published with `Volatile.Write` and read with
`Volatile.Read`. `Id`, `Name` and `Version` are non-nullable inside the snapshot, so there is no
state in which one is visible and another is not, and no call site can read them independently even
by mistake. `SetDefinition` before `SetIdentity` now throws rather than silently no-opping, which
previously would have left the config definition null — read by Gate A as "no config schema, skip",
letting a processor reach Healthy without validating its config.

Done now because nothing in `/src` consumes `IProcessorContext` yet except its own tests. The
consumers that would each have needed their own guard — the orchestrator, the heartbeat, the log
enricher and four increment sites — will be written against an API where the hazard cannot be
expressed.

**Residual:** the incorrect ordering claim in the reference's `EntryStepDispatchConsumer:35-36`
comment still needs correcting when that consumer is ported, and `ProcessorIdLogEnricher` /
`IdentityNameOf` shed their per-site `Name`/`Version` guards at the same time. The API no longer
permits the null-deref, but the stale comment would mislead the next reader.

---

## Confirmed correct — do not change

Verified against the code; these are load-bearing and easy to "fix" wrongly.

1. **The liveness probe measures loop iteration, not business outcome.** It reads only
   `_heartbeat.Last` against a window, never the gate, Redis, or the broker. A closed gate is the
   system working correctly; wiring outcome into liveness restarts the pod during the exact outage
   the gate exists to ride out (`src/BaseApi.Core/Gating/LoopLivenessHealthCheck.cs:8-23`).

2. **The processor starts unhealthy in memory, absent in L2.** `_isHealthy` defaults to 0
   (`ProcessorContext.cs:31,38`); no L2 key exists before identity resolves, because the write is
   guarded on `context.Id` being non-null (`ProcessorStartupOrchestrator.cs:358`). `absent` and
   `unhealthy` are distinct states to the reader (`ProcessorLivenessValidator.cs:58-73`).

3. **The liveness loop starts at host start; only its L2 write is gated.** A not-yet-healthy tick is
   a no-op write, not a wait (`ProcessorLivenessHeartbeat.cs:105`). A replica booting against a down
   bus must still stamp liveness or it is restarted mid-outage.

4. **`Beat()` is stamped first, before any I/O, unconditionally.** An iteration whose measurement
   timed out has still done its job (`L2GateProbe.cs:57-58`, `ProcessorLivenessHeartbeat.cs:91-100`).

5. **Bind before `MarkHealthy`.** Both receive endpoints are bound and `await handle.Ready` completes
   *before* `MarkHealthy()` (`ProcessorStartupOrchestrator.cs:268-291`). Because the heartbeat writes
   L2 only when `IsHealthy`, "Healthy" cannot land in L2 before the queue exists — so the
   orchestrator never sends to a non-existent queue.

6. **Gate A clash must pass `configOutcome: Fail` explicitly** (`:229`). By then all definitions are
   resolved, so the naive summary is all-Success and `ProcessorLivenessEntry.Create` would derive
   **Healthy** (`src/Messaging.Contracts/Projections/ProcessorLivenessEntry.cs:41-45`).

7. **Gate A clash marks ready but withholds healthy** — readiness green so K8s does not crash-loop,
   `MarkHealthy` withheld and no bind, terminal with no retry (`:219-259`).

8. **`ProcessorLivenessEntry.Create` is the only construction path**, and it derives status from the
   summary so no caller can publish a status contradicting its own outcomes.

9. **A Redis fault on a liveness write is logged and swallowed**
   (`ProcessorLivenessWriter.cs:51-54`). The caller is a loop whose next iteration writes again; a
   write failure must never end it.
