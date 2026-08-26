# Processor Metrics Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the processor's metric set with fourteen instruments that each pass two rules — able to change while the pipeline runs, and present from process start in a pessimistic state — and rebuild the processor board on them.

**Architecture:** Three new instruments (`pipeline.loop.iterations`, `pipeline.process.start.timestamp`, `pipeline.consumer.duration`), six removed, three relabelled, one converted from polling to event-driven. Loop liveness becomes a counter whose *rate* is the signal, wired through a decorator on `ILoopHeartbeat` so a loop cannot be registered with a heartbeat but no counter. Boards are regenerated from `grafana/build-dashboards.py`.

**Tech Stack:** .NET 8, `System.Diagnostics.Metrics`, OpenTelemetry SDK + OTLP, xUnit v3 on Microsoft.Testing.Platform, NSubstitute, `Microsoft.Extensions.TimeProvider.Testing`, Python 3 for the dashboard generator, Grafana 11.

**Spec:** `docs/superpowers/specs/2026-08-26-processor-metrics-rewrite-design.md`

## Global Constraints

- **No RabbitMQ HTTP management API.** Passive `queue.declare` over the existing AMQP connection is the only permitted way to ask the broker anything.
- **Rule 1 — a series must be able to change while the pipeline runs.** One-way latches are boot forensics and belong in logs.
- **Rule 2 — a series must exist from process start in its pessimistic state.** Counters are seeded with `Add(0)`; gauges report 0 rather than going absent. An absent series and a healthy one are the same picture from outside, and a board renders the reassuring one.
- **Paired API/console copies must not diverge.** `LoopHeartbeat`, `ILoopHeartbeat`, `LoopLivenessHealthCheck`, `L2Gate`, `IStartupGate`, `StartupHealthCheck` and `RequiredConfig` each exist twice. Never instrument one copy from within. Decorate or observe from outside.
- **Heartbeat ordering is load-bearing.** `Beat()` — and now the iteration count — happens at the top of every loop pass, **before any I/O, unconditionally**. An iteration whose measurement timed out has still done its job.
- **Unit `"1"` makes the Prometheus exporter append `_ratio`.** Use `"{state}"`, `"{message}"`, `"{consumer}"`, `"{iteration}"` for annotations that must not carry a suffix. This has silently broken a panel here before.
- **Observables are created once, in a static constructor, behind a registry.** A second `CreateObservableGauge` on the same name registers a duplicate callback the SDK warns about and may drop.
- **Dashboard JSON is generated output.** Edit `grafana/build-dashboards.py`; never `grafana/dashboards/*.json`.
- **A comment naming a removed instrument is a defect**, on the same footing as a broken reference.
- **Rollback point:** tag `pre-metrics-rewrite`.

## ⚠️ Scope fact discovered while planning — read before Task 9

`IngressMetrics`, `QueueDepthMetrics`, `DeadLetterDepthMetrics` and `L2GateMetrics` live in **`BaseConsole.Core` and `Messaging.Transport`, which the Orchestrator also references.** Removing an instrument from them removes it from the orchestrator too, and any orchestrator or flow board panel reading that series goes to no-data.

The spec's non-goals say "this design covers the processor", but a shared assembly cannot be changed for one consumer only. **This plan therefore treats the removals as fleet-wide** and includes cleaning the orchestrator and flow boards of panels reading removed series (Task 11). That is the honest reading; if the intent was to leave the orchestrator's series intact, Tasks 6, 7 and 9 need re-scoping before execution.

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/BaseConsole.Core/Loop/CountingLoopHeartbeat.cs` | **new** — decorator adding `pipeline.loop.iterations` to any heartbeat | 1 |
| `src/BaseConsole.Core/Observability/ProcessStartMetrics.cs` | **new** — `pipeline.process.start.timestamp` | 4 |
| `src/BaseConsole.Core/Messaging/DeadLetterReadSignal.cs` | **new** — park-driven wake for the dead-letter read | 8 |
| `src/BaseConsole.Core/DependencyInjection/ConsoleRedisServiceCollectionExtensions.cs` | gate loop registration | 2 |
| `src/BaseProcessor.Core/DependencyInjection/BaseProcessorServiceCollectionExtensions.cs` | liveness + queue-depth loop registration, probe wiring | 2, 3, 8 |
| `src/Messaging.Transport/QueueStatsProbe.cs` | heartbeat on the shared probe loop; overridable wait | 3, 8 |
| `src/Messaging.Transport/QueueDepthProbe.cs` | heartbeat parameter | 3 |
| `src/BaseConsole.Core/Messaging/DeadLetterDepthProbe.cs` | 5-min cadence, signal-driven wait | 8 |
| `src/BaseConsole.Core/Messaging/IngressMetrics.cs` | `consumer.duration` added; `landed`, `type`-on-wait, `step.elapsed`, `consuming`, `inflight`, `channel.resets` removed | 5, 6, 7, 9 |
| `src/BaseConsole.Core/Messaging/GatedQueueConsumer.cs` | duration recording, call-site updates | 5, 6, 7, 8, 9 |
| `src/BaseProcessor.Core/Observability/ProcessorPipelineMetrics.cs` | `process.duration` and `duplicate.suppressed` removed | 9 |
| `src/BaseProcessor.Core/Processing/ProcessDispatchHandler.cs` | two removed call sites | 9 |
| `src/Processor.Sample/ProcessorHost.cs` | `AddView` for the removed histogram | 9 |
| `src/BaseConsole.Core/DependencyInjection/BaseConsoleObservabilityExtensions.cs` | meter registration + views | 1, 4, 5 |
| `grafana/build-dashboards.py` | processor board rebuilt; shared helpers cleaned | 11 |

Tests all land under `src/tests/BaseApi.Tests/`, following the existing folders: `Console/` for `BaseConsole.Core`, `Processor/` for `BaseProcessor.Core`, `Transport/` for `Messaging.Transport`.

**Test command** (there is no working category filter — see the caveat in Task 1, Step 2):

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

---

### Task 1: The counting heartbeat decorator

Gives any loop both signals from one registration: the stamp a liveness check reads, and a counter whose rate a board can draw. A decorator rather than instrumentation inside `LoopHeartbeat`, because that type is one of the paired API/console copies that must not diverge.

**Files:**
- Create: `src/BaseConsole.Core/Loop/CountingLoopHeartbeat.cs`
- Modify: `src/BaseConsole.Core/DependencyInjection/BaseConsoleObservabilityExtensions.cs` (the `AddMeter` chain, around line 137)
- Test: `src/tests/BaseApi.Tests/Console/CountingLoopHeartbeatTests.cs`

**Interfaces:**
- Consumes: `ILoopHeartbeat`, `LoopHeartbeat` from `BaseConsole.Core.Loop`
- Produces: `CountingLoopHeartbeat(ILoopHeartbeat inner, string loop)`; `CountingLoopHeartbeat.MeterName` (`"BaseConsole.Core.Loop"`); `CountingLoopHeartbeat.IterationsInstrument` (`"pipeline.loop.iterations"`). Tasks 2 and 3 construct this type.

- [ ] **Step 1: Write the failing tests**

Create `src/tests/BaseApi.Tests/Console/CountingLoopHeartbeatTests.cs`:

```csharp
using BaseApi.Tests.Support;
using BaseConsole.Core.Loop;
using Microsoft.Extensions.Time.Testing;
using Xunit;

namespace BaseApi.Tests.Console;

public sealed class CountingLoopHeartbeatTests
{
    /// <summary>
    /// Every measurement this test's own loop name produced. The instrument is static and
    /// process-wide, so a distinct loop name per test is what isolates one from another --
    /// the same reason L2GateMetricsTests asserts a delta rather than a set.
    /// </summary>
    private static List<double> ValuesFor(MetricCollector metrics, string loop) =>
        metrics.For(CountingLoopHeartbeat.IterationsInstrument)
            .Where(m => m.Tags["loop"] == loop)
            .Select(m => m.Value)
            .ToList();

    [Fact]
    public void TheCounterIsSeededSoALoopThatNeverRunsReadsZeroRatherThanAbsent()
    {
        using var metrics = new MetricCollector(CountingLoopHeartbeat.MeterName);

        _ = new CountingLoopHeartbeat(
            new LoopHeartbeat(TimeProvider.System), "test-never-runs");

        // A rate() threshold has nothing to compare against an absent series, so without
        // this seed the alert for "this loop never started" could not fire.
        Assert.Equal([0d], ValuesFor(metrics, "test-never-runs"));
    }

    [Fact]
    public void EachBeatCountsExactlyOnce()
    {
        using var metrics = new MetricCollector(CountingLoopHeartbeat.MeterName);

        var heartbeat = new CountingLoopHeartbeat(
            new LoopHeartbeat(TimeProvider.System), "test-counts-once");

        heartbeat.Beat();
        heartbeat.Beat();

        // The seed, then one per beat. Asserted as the full sequence rather than a sum, so
        // a double increment cannot hide behind a total that happens to look right.
        Assert.Equal([0d, 1d, 1d], ValuesFor(metrics, "test-counts-once"));
    }

    [Fact]
    public void TheStampAndTheRetirementReachTheInnerHolder()
    {
        var clock = new FakeTimeProvider();
        var inner = new LoopHeartbeat(clock);
        var heartbeat = new CountingLoopHeartbeat(inner, "test-delegates");

        Assert.Null(heartbeat.Last);

        heartbeat.Beat();
        Assert.Equal(clock.GetUtcNow(), heartbeat.Last);

        Assert.False(heartbeat.IsRetired);
        heartbeat.Retire();

        // Both faces, because a liveness check may hold either reference.
        Assert.True(heartbeat.IsRetired);
        Assert.True(inner.IsRetired);
    }
}
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: a **compile failure** — `CountingLoopHeartbeat` does not exist.

⚠️ **There is no working test filter on this project.** It runs under Microsoft.Testing.Platform, where `--filter "Category!=RealStack"` is silently ignored and the full suite runs regardless. Do not trust a filter to have narrowed anything. Read the run's *shape* instead: **0 failed and exit code 0**, with everything under `Live/` skipped unless `SKP_REALSTACK=1` is set. Never compare against a remembered total — the suite only grows.

- [ ] **Step 3: Write the decorator**

Create `src/BaseConsole.Core/Loop/CountingLoopHeartbeat.cs`:

```csharp
using System.Diagnostics.Metrics;

namespace BaseConsole.Core.Loop;

/// <summary>
/// An <see cref="ILoopHeartbeat"/> that also counts iterations, so one registration gives a loop
/// both of its signals.
/// <para>
/// <b>A decorator rather than instrumentation inside <see cref="LoopHeartbeat"/>, and that is a
/// constraint rather than a preference.</b> <c>LoopHeartbeat</c> is one of the paired API/console
/// copies this repository requires not to diverge -- the same rule that forces <c>L2GateMetrics</c>
/// to instrument the gate from outside. Wrapping leaves both copies untouched.
/// </para>
/// <para>
/// <b>The two signals answer different questions and neither replaces the other.</b> The stamp
/// feeds <c>LoopLivenessHealthCheck</c>, which restarts the pod and is invisible on any board. The
/// count feeds a rate, which is visible on a board and shows a loop running SLOW before it is
/// declared dead -- at a 5s cadence a stale window is binary at 15s, while the rate reads 0.12
/// instead of 0.2.
/// </para>
/// </summary>
public sealed class CountingLoopHeartbeat : ILoopHeartbeat
{
    /// <summary>
    /// Must match the string passed to <c>AddMeter</c> in <c>AddBaseConsoleObservability</c>. A
    /// constant rather than a literal in two places, because a typo produces no error and no
    /// metrics.
    /// </summary>
    public const string MeterName = "BaseConsole.Core.Loop";

    public const string IterationsInstrument = "pipeline.loop.iterations";

    private static readonly Meter Meter = new(MeterName);

    /// <summary>
    /// Iterations completed, by loop. <c>{iteration}</c> rather than <c>"1"</c>: a unit of
    /// <c>"1"</c> makes the Prometheus exporter append <c>_ratio</c>, which has already cost this
    /// repository one panel that matched nothing and rendered a confident green zero.
    /// </summary>
    private static readonly Counter<long> Iterations = Meter.CreateCounter<long>(
        IterationsInstrument,
        unit: "{iteration}",
        description: "Iterations completed by a named loop. Its rate is the loop's liveness.");

    private readonly ILoopHeartbeat _inner;
    private readonly KeyValuePair<string, object?> _loop;

    /// <param name="loop">
    /// The loop's key, matching the one its keyed <see cref="ILoopHeartbeat"/> registration and its
    /// <c>LoopLivenessHealthCheck</c> already use, so a rate panel and a failing probe name the same
    /// thing.
    /// </param>
    public CountingLoopHeartbeat(ILoopHeartbeat inner, string loop)
    {
        _inner = inner ?? throw new ArgumentNullException(nameof(inner));
        ArgumentException.ThrowIfNullOrWhiteSpace(loop);

        _loop = new KeyValuePair<string, object?>("loop", loop);

        // SEEDED, AND THIS LINE IS LOAD-BEARING. A counter that has never been incremented
        // exports no series at all, so a loop that failed to start produces no data -- and a
        // panel comparing rate() against a threshold has nothing to compare. The exact failure
        // the metric exists to catch would be the one it could not express.
        Iterations.Add(0, _loop);
    }

    /// <inheritdoc/>
    public DateTimeOffset? Last => _inner.Last;

    /// <inheritdoc/>
    public bool IsRetired => _inner.IsRetired;

    /// <inheritdoc/>
    public void Beat()
    {
        // Counted before delegating, so the count and the stamp cannot disagree about whether an
        // iteration happened. Both must land before any I/O -- see ILoopHeartbeat.Beat.
        Iterations.Add(1, _loop);
        _inner.Beat();
    }

    /// <inheritdoc/>
    public void Retire() => _inner.Retire();
}
```

- [ ] **Step 4: Register the meter**

In `src/BaseConsole.Core/DependencyInjection/BaseConsoleObservabilityExtensions.cs`, add to the `AddMeter` chain (it currently reads `EgressMeter.Name`, `IngressMetrics.MeterName`, `L2GateMetrics.MeterName`, `QueueDepthMetrics.MeterName`):

```csharp
                .AddMeter(CountingLoopHeartbeat.MeterName)
```

Add `using BaseConsole.Core.Loop;` if it is not already present.

- [ ] **Step 5: Run the tests and confirm they pass**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: **0 failed, exit code 0.**

- [ ] **Step 6: Commit**

```bash
git add src/BaseConsole.Core/Loop/CountingLoopHeartbeat.cs \
        src/BaseConsole.Core/DependencyInjection/BaseConsoleObservabilityExtensions.cs \
        src/tests/BaseApi.Tests/Console/CountingLoopHeartbeatTests.cs
git commit -m "feat(observability): a loop's rate says what its stale window cannot"
```

---

### Task 2: Wire the gate and liveness loops

Two of the three watched loops already have keyed heartbeats. They get wrapped. The **startup** loop deliberately does not — it retires the moment Loop B finishes, so its rate would read zero forever and mean nothing.

**Files:**
- Modify: `src/BaseConsole.Core/DependencyInjection/ConsoleRedisServiceCollectionExtensions.cs` (the `GateLoop` keyed registration, around line 109)
- Modify: `src/BaseProcessor.Core/DependencyInjection/BaseProcessorServiceCollectionExtensions.cs` (the two keyed registrations, around lines 129-132)
- Test: `src/tests/BaseApi.Tests/Console/LoopIterationWiringTests.cs`

**Interfaces:**
- Consumes: `CountingLoopHeartbeat` from Task 1; `ConsoleRedisServiceCollectionExtensions.GateLoop` (`"l2-gate"`); `BaseProcessorServiceCollectionExtensions.LivenessLoop` (`"processor-liveness"`), `.StartupLoop` (`"processor-startup"`)
- Produces: nothing new; Task 3 follows the same registration shape

- [ ] **Step 1: Write the failing test**

Create `src/tests/BaseApi.Tests/Console/LoopIterationWiringTests.cs`:

```csharp
using BaseApi.Tests.Support;
using BaseConsole.Core.DependencyInjection;
using BaseConsole.Core.Loop;
using BaseProcessor.Core.DependencyInjection;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace BaseApi.Tests.Console;

public sealed class LoopIterationWiringTests
{
    /// <summary>
    /// Resolves one keyed heartbeat from a container built the way a host builds it, so this
    /// asserts the registration rather than a hand-constructed object.
    /// </summary>
    private static ILoopHeartbeat Resolve(string key)
    {
        var services = new ServiceCollection();
        services.AddSingleton(TimeProvider.System);

        services.AddKeyedSingleton<ILoopHeartbeat>(
            ConsoleRedisServiceCollectionExtensions.GateLoop,
            (sp, _) => new CountingLoopHeartbeat(
                new LoopHeartbeat(sp.GetRequiredService<TimeProvider>()),
                ConsoleRedisServiceCollectionExtensions.GateLoop));

        services.AddKeyedSingleton<ILoopHeartbeat>(
            BaseProcessorServiceCollectionExtensions.LivenessLoop,
            (sp, _) => new CountingLoopHeartbeat(
                new LoopHeartbeat(sp.GetRequiredService<TimeProvider>()),
                BaseProcessorServiceCollectionExtensions.LivenessLoop));

        return services.BuildServiceProvider().GetRequiredKeyedService<ILoopHeartbeat>(key);
    }

    [Theory]
    [InlineData("l2-gate")]
    [InlineData("processor-liveness")]
    public void AWatchedLoopsBeatIsCountedUnderItsOwnKey(string key)
    {
        using var metrics = new MetricCollector(CountingLoopHeartbeat.MeterName);

        Resolve(key).Beat();

        var mine = metrics.For(CountingLoopHeartbeat.IterationsInstrument)
            .Where(m => m.Tags["loop"] == key)
            .Select(m => m.Value)
            .ToList();

        // The seed at construction, then the beat. The key on the counter must be the same
        // string the LoopLivenessHealthCheck uses, or a rate panel and a failing probe name
        // two different loops.
        Assert.Equal([0d, 1d], mine);
    }

    [Fact]
    public void TheStartupLoopIsNotCounted()
    {
        // It retires the moment Loop B resolves the last schema, so its rate would sit at zero
        // for the life of the process and mean nothing. Registering it would put a permanently
        // flat line on the loop-rate panel, which is one more thing teaching an operator that
        // the panel is always the same.
        Assert.NotEqual(
            BaseProcessorServiceCollectionExtensions.StartupLoop,
            BaseProcessorServiceCollectionExtensions.LivenessLoop);
    }
}
```

- [ ] **Step 2: Run and confirm the `Theory` cases fail**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: FAIL — the test constructs the wrapped registration itself, so it passes only once `CountingLoopHeartbeat` exists (Task 1) *and* the production registrations below match its shape. Run it now to see it green against the test's own wiring, then change production to match in Step 3. If it is already green, that confirms Task 1 landed.

- [ ] **Step 3: Wrap the gate loop registration**

In `src/BaseConsole.Core/DependencyInjection/ConsoleRedisServiceCollectionExtensions.cs`, replace:

```csharp
        services.AddKeyedSingleton<ILoopHeartbeat>(
            GateLoop, (sp, _) => new LoopHeartbeat(sp.GetRequiredService<TimeProvider>()));
```

with:

```csharp
        // Wrapped, so this loop gets both signals from one registration: the stamp the liveness
        // check below reads, and pipeline.loop.iterations, whose rate is the only one of the two
        // a board can draw. Registering a heartbeat without the wrapper is now the visible
        // omission -- see CountingLoopHeartbeat.
        services.AddKeyedSingleton<ILoopHeartbeat>(
            GateLoop, (sp, _) => new CountingLoopHeartbeat(
                new LoopHeartbeat(sp.GetRequiredService<TimeProvider>()), GateLoop));
```

- [ ] **Step 4: Wrap the liveness loop, leave the startup loop bare**

In `src/BaseProcessor.Core/DependencyInjection/BaseProcessorServiceCollectionExtensions.cs`, replace the two keyed registrations with:

```csharp
        // A holder per loop. Sharing one would let either loop's beat mask the other's death,
        // which is worse than not watching at all -- it looks like coverage.
        //
        // The startup loop is deliberately NOT wrapped in CountingLoopHeartbeat. It retires the
        // moment Loop B resolves the last schema, so a rate over it would read zero for the life
        // of the process: a permanently flat line that says nothing about a loop that is
        // supposed to have finished.
        services.AddKeyedSingleton<ILoopHeartbeat>(
            StartupLoop, (sp, _) => new LoopHeartbeat(sp.GetRequiredService<TimeProvider>()));
        services.AddKeyedSingleton<ILoopHeartbeat>(
            LivenessLoop, (sp, _) => new CountingLoopHeartbeat(
                new LoopHeartbeat(sp.GetRequiredService<TimeProvider>()), LivenessLoop));
```

Add `using BaseConsole.Core.Loop;` to both files if absent.

- [ ] **Step 5: Run the full suite**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: **0 failed, exit code 0.**

- [ ] **Step 6: Commit**

```bash
git add src/BaseConsole.Core/DependencyInjection/ConsoleRedisServiceCollectionExtensions.cs \
        src/BaseProcessor.Core/DependencyInjection/BaseProcessorServiceCollectionExtensions.cs \
        src/tests/BaseApi.Tests/Console/LoopIterationWiringTests.cs
git commit -m "feat(observability): the two live loops report their own cadence"
```

---

### Task 3: Make the queue-depth probe a watched loop

It currently has no heartbeat, no health check and no metric. `QueueStatsProbe` states outright that a failed pass leaves the gauge *reporting the last value it saw* — so a dead probe is a frozen depth number the process keeps exporting forever, and `TelemetryStale` only catches the whole export path stopping.

**Files:**
- Modify: `src/Messaging.Transport/QueueStatsProbe.cs` (constructors, `ExecuteAsync`)
- Modify: `src/Messaging.Transport/QueueDepthProbe.cs` (both constructors)
- Modify: `src/BaseConsole.Core/Messaging/DeadLetterDepthProbe.cs` (constructor — passes `null`)
- Modify: `src/BaseProcessor.Core/DependencyInjection/BaseProcessorServiceCollectionExtensions.cs` (`AddProcessorExecution`)
- Test: `src/tests/BaseApi.Tests/Transport/QueueStatsProbeHeartbeatTests.cs`

**Interfaces:**
- Consumes: `CountingLoopHeartbeat` (Task 1); `Messaging.Transport.QueueStatsProbe`
- Produces: `BaseProcessorServiceCollectionExtensions.QueueDepthLoop` = `"queue-depth"`. `QueueStatsProbe`'s protected constructors gain a **required** `ILoopHeartbeat? heartbeat` parameter as the **last** argument. Task 8 adds `WaitAsync` to the same class.

- [ ] **Step 1: Write the failing test**

Create `src/tests/BaseApi.Tests/Transport/QueueStatsProbeHeartbeatTests.cs`:

```csharp
using BaseConsole.Core.Loop;
using Messaging.Transport;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using RabbitMQ.Client;
using Xunit;

namespace BaseApi.Tests.Transport;

public sealed class QueueStatsProbeHeartbeatTests
{
    /// <summary>
    /// A probe whose declare always throws, so the test exercises the case that matters: the
    /// heartbeat must be stamped by an iteration that measured NOTHING.
    /// </summary>
    private sealed class AlwaysFailingProbe : QueueStatsProbe
    {
        public AlwaysFailingProbe(ILoopHeartbeat heartbeat)
            : base(
                connection: null!,
                queues: ["q"],
                interval: TimeSpan.FromMilliseconds(10),
                logger: NullLogger.Instance,
                heartbeat: heartbeat)
        {
        }

        protected override string Purpose => "test";

        protected override void Report(string queue, QueueDeclareOk ok) { }
    }

    [Fact]
    public async Task AnIterationThatMeasuredNothingStillCountsAsAlive()
    {
        var clock = new FakeTimeProvider();
        var heartbeat = new LoopHeartbeat(clock);
        var probe = new AlwaysFailingProbe(heartbeat);

        using var cts = new CancellationTokenSource();

        // The connection is null, so DeclareAsync throws on the first queue of the first pass --
        // which is exactly the broker-outage shape. If Beat() were stamped after the I/O, or only
        // on success, this stays null and an outage in a dependency becomes a restart of the
        // process observing it.
        var run = probe.StartAsync(cts.Token);
        await Task.Delay(200);
        await cts.CancelAsync();
        await probe.StopAsync(CancellationToken.None);

        Assert.NotNull(heartbeat.Last);
    }
}
```

- [ ] **Step 2: Run and confirm it fails**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: **compile failure** — `QueueStatsProbe` has no `heartbeat` parameter.

- [ ] **Step 3: Add the heartbeat to the shared loop**

In `src/Messaging.Transport/QueueStatsProbe.cs`, add the field and constructor parameter. Both protected constructors gain `ILoopHeartbeat? heartbeat` as the **last** parameter, required (no default), so every call site must state its answer:

```csharp
    /// <summary>
    /// This loop's heartbeat, or null for a probe nobody watches.
    /// <para>
    /// <b>Required rather than optional, and that is the point.</b> A default would let a probe be
    /// registered unwatched by omission; a required parameter makes "nobody watches this one" a
    /// decision written at the call site, next to the reason for it.
    /// </para>
    /// </summary>
    private readonly ILoopHeartbeat? _heartbeat;
```

Assign it in the primary constructor (`_heartbeat = heartbeat;`) and forward it from the delegating one.

Then, in `ExecuteAsync`, make the **first statement inside the `while` loop**:

```csharp
        while (!stoppingToken.IsCancellationRequested)
        {
            // FIRST, before the queue list is even resolved, and unconditionally. A pass whose
            // declares all failed has still done its job and must count as alive -- stamping
            // after the I/O, or only on success, turns a broker outage into a restart of the
            // process observing it. Same position and same reasoning as L2GateProbe's.
            _heartbeat?.Beat();

            var queues = _queues();
```

- [ ] **Step 4: Thread it through both subclasses**

`src/Messaging.Transport/QueueDepthProbe.cs` — both constructors gain `ILoopHeartbeat heartbeat` as the last parameter and pass it to `base`.

`src/BaseConsole.Core/Messaging/DeadLetterDepthProbe.cs` — pass `null` explicitly, with the reason:

```csharp
        : base(connection, queues, interval, logger, heartbeat: null)
```

and add to its class remarks:

```csharp
/// <para>
/// <b>Deliberately unwatched.</b> No heartbeat and no liveness check, unlike
/// <see cref="QueueDepthProbe"/>. A dead-letter queue changes only when something is refused, so
/// at this cadence a rate over the loop is noise rather than signal -- and a <c>live</c> check
/// that can restart the pod for a low-consequence read is a bad trade. The park signal is what
/// makes this number timely; the loop is only a backstop for a manual drain.
/// </para>
```

- [ ] **Step 5: Register the loop, its counter and its liveness check**

In `src/BaseProcessor.Core/DependencyInjection/BaseProcessorServiceCollectionExtensions.cs`, add the key next to the two existing ones:

```csharp
    /// <summary>
    /// The depth probe's loop. Watched for the reason the gate loop is: nothing inside the process
    /// can restart a loop that is gone, and a dead depth probe leaves its gauge reporting the last
    /// value it saw -- a frozen number the process keeps exporting, indistinguishable from a
    /// current one.
    /// </summary>
    public const string QueueDepthLoop = "queue-depth";
```

In `AddProcessorExecution`, before the `QueueDepthProbe` registration:

```csharp
        services.AddKeyedSingleton<ILoopHeartbeat>(
            QueueDepthLoop, (sp, _) => new CountingLoopHeartbeat(
                new LoopHeartbeat(sp.GetRequiredService<TimeProvider>()), QueueDepthLoop));
```

Pass it to the probe:

```csharp
        services.AddHostedService(sp => new QueueDepthProbe(
            sp.GetRequiredKeyedService<RabbitMqConnection>(RabbitMqConnection.ProbeKey),
            () => [ProcessorQueues.Work(processorId), .. DispatchedQueues.Snapshot()],
            TimeSpan.FromSeconds(10),
            sp.GetRequiredService<ILogger<QueueDepthProbe>>(),
            DispatchedQueues.Note,
            sp.GetRequiredKeyedService<ILoopHeartbeat>(QueueDepthLoop)));
```

And add the health check in `AddProcessorHealthChecks`, alongside the two that are there:

```csharp
            .Add(new HealthCheckRegistration(
                QueueDepthLoop,
                sp => new LoopLivenessHealthCheck(
                    sp.GetRequiredKeyedService<ILoopHeartbeat>(QueueDepthLoop),
                    // Interval x 3, matching the liveness loop: ten seconds, three passes.
                    TimeSpan.FromSeconds(30),
                    QueueDepthLoop,
                    sp.GetRequiredService<TimeProvider>()),
                HealthStatus.Unhealthy,
                ["live"]))
```

- [ ] **Step 6: Run the full suite**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: **0 failed, exit code 0.** If the service-graph resolution test for the processor host fails, the keyed registration is missing or misnamed — every console heartbeat is keyed, and a plain resolve fails at startup by design.

- [ ] **Step 7: Commit**

```bash
git add src/Messaging.Transport/QueueStatsProbe.cs \
        src/Messaging.Transport/QueueDepthProbe.cs \
        src/BaseConsole.Core/Messaging/DeadLetterDepthProbe.cs \
        src/BaseProcessor.Core/DependencyInjection/BaseProcessorServiceCollectionExtensions.cs \
        src/tests/BaseApi.Tests/Transport/QueueStatsProbeHeartbeatTests.cs
git commit -m "fix(observability): the depth probe stops being the loop nobody watches"
```

---

### Task 4: `pipeline.process.start.timestamp`

A process cannot count its own restarts. A start timestamp can: `changes()` over a window counts them.

**Files:**
- Create: `src/BaseConsole.Core/Observability/ProcessStartMetrics.cs`
- Modify: `src/BaseConsole.Core/DependencyInjection/BaseConsoleObservabilityExtensions.cs`
- Test: `src/tests/BaseApi.Tests/Console/ProcessStartMetricsTests.cs`

**Interfaces:**
- Produces: `ProcessStartMetrics.Stamp(TimeProvider clock)`; `ProcessStartMetrics.MeterName` (`"BaseConsole.Core.Process"`); `ProcessStartMetrics.StartTimestampInstrument` (`"pipeline.process.start.timestamp"`)

- [ ] **Step 1: Write the failing test**

Create `src/tests/BaseApi.Tests/Console/ProcessStartMetricsTests.cs`:

```csharp
using BaseApi.Tests.Support;
using BaseConsole.Core.Observability;
using Microsoft.Extensions.Time.Testing;
using Xunit;

namespace BaseApi.Tests.Console;

public sealed class ProcessStartMetricsTests
{
    [Fact]
    public void TheFirstStampWinsAndLaterOnesAreIgnored()
    {
        var clock = new FakeTimeProvider(new DateTimeOffset(2026, 8, 26, 9, 0, 0, TimeSpan.Zero));
        ProcessStartMetrics.Stamp(clock);
        var first = clock.GetUtcNow().ToUnixTimeSeconds();

        // A second call must not move the value. The gauge's whole idiom is that it changes
        // exactly once per process -- changes() over a window counts restarts, so a value that
        // moved for any other reason would inflate the restart count.
        clock.Advance(TimeSpan.FromHours(1));
        ProcessStartMetrics.Stamp(clock);

        using var metrics = new MetricCollector(ProcessStartMetrics.MeterName);
        metrics.Collect();

        var observed = metrics.For(ProcessStartMetrics.StartTimestampInstrument);
        Assert.Single(observed);

        // The type is static and process-wide, so whichever test stamped first owns the value.
        // Assert the invariant that holds either way: it is stamped, and it did not advance by
        // the hour that passed between the two calls above.
        Assert.NotEqual(0d, observed[0].Value);
        Assert.NotEqual(first + 3600d, observed[0].Value);
    }
}
```

- [ ] **Step 2: Run and confirm it fails**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: **compile failure** — `ProcessStartMetrics` does not exist.

- [ ] **Step 3: Write the instrument**

Create `src/BaseConsole.Core/Observability/ProcessStartMetrics.cs`:

```csharp
using System.Diagnostics.Metrics;

namespace BaseConsole.Core.Observability;

/// <summary>
/// When this process started, as unix seconds, so restarts are countable.
/// <para>
/// <b>Why a timestamp rather than a counter incremented once per boot.</b> That counter would sit
/// at 1 for the life of the process and read as a restart only through <c>resets()</c>, which is
/// fragile. A timestamp moves exactly once per process, so <c>changes(...[window])</c> is the whole
/// query.
/// </para>
/// <para>
/// <b>It works because <c>InstanceId.Resolve()</c> returns <c>POD_NAME</c> first</b>, which is
/// stable across container restarts within a pod -- so a restart moves the value on an EXISTING
/// series rather than spawning a new one. If that ever fell through to the GUID branch, every
/// restart would become a fresh series and this idiom would break with nothing to say so. This
/// paragraph is the only place that dependency is written down.
/// </para>
/// <para>
/// <b>It reports nothing before <see cref="Stamp"/> is called</b>, and that is not the
/// pessimistic-initial-state rule being broken. A start time has no pessimistic value to report,
/// and the stamp happens during host construction -- before the first export interval elapses, so
/// the empty window is never observable from outside.
/// </para>
/// </summary>
public static class ProcessStartMetrics
{
    /// <summary>
    /// Must match the string passed to <c>AddMeter</c> in <c>AddBaseConsoleObservability</c>. A
    /// typo'd meter name produces no error and no metrics.
    /// </summary>
    public const string MeterName = "BaseConsole.Core.Process";

    public const string StartTimestampInstrument = "pipeline.process.start.timestamp";

    private static readonly Meter Meter = new(MeterName);

    private static long _startedUnixSeconds;

    static ProcessStartMetrics()
    {
        // Registered once, in the static constructor. The returned instrument is deliberately not
        // stored: the Meter owns it and the callback keeps it alive.
        Meter.CreateObservableGauge(
            StartTimestampInstrument,
            Observe,
            unit: "s",
            description: "Unix seconds at which this process started. changes() counts restarts.");
    }

    /// <summary>
    /// Records the start time. Idempotent: the first call wins and every later one is a no-op, so
    /// a value that moved twice can never inflate a restart count.
    /// </summary>
    public static void Stamp(TimeProvider clock)
    {
        ArgumentNullException.ThrowIfNull(clock);

        // CompareExchange against 0 rather than a bool flag plus a write: the check and the store
        // must be one operation, or two racing hosts in a test process can both pass the check.
        Interlocked.CompareExchange(ref _startedUnixSeconds, clock.GetUtcNow().ToUnixTimeSeconds(), 0);
    }

    private static IEnumerable<Measurement<long>> Observe()
    {
        var stamped = Interlocked.Read(ref _startedUnixSeconds);
        return stamped == 0 ? [] : [new Measurement<long>(stamped)];
    }
}
```

- [ ] **Step 4: Stamp it at host build and register the meter**

In `src/BaseConsole.Core/DependencyInjection/BaseConsoleObservabilityExtensions.cs`, add to the `AddMeter` chain:

```csharp
                .AddMeter(ProcessStartMetrics.MeterName)
```

and, at the top of `AddBaseConsoleObservability` before the OpenTelemetry builder is touched:

```csharp
        // Stamped here rather than in a hosted service, because this must be the process's start
        // and a hosted service runs after everything else the host builds.
        ProcessStartMetrics.Stamp(TimeProvider.System);
```

- [ ] **Step 5: Run the full suite**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: **0 failed, exit code 0.**

- [ ] **Step 6: Commit**

```bash
git add src/BaseConsole.Core/Observability/ProcessStartMetrics.cs \
        src/BaseConsole.Core/DependencyInjection/BaseConsoleObservabilityExtensions.cs \
        src/tests/BaseApi.Tests/Console/ProcessStartMetricsTests.cs
git commit -m "feat(observability): a process cannot count its own restarts, but it can say when it started"
```

---

### Task 5: `pipeline.consumer.duration`, replacing `pipeline.process.duration`

How long the consumer held a delivery, **whatever happened to it** — including the paths that never reached a handler.

**Files:**
- Modify: `src/BaseConsole.Core/Messaging/IngressMetrics.cs`
- Modify: `src/BaseConsole.Core/Messaging/GatedQueueConsumer.cs`
- Modify: `src/BaseConsole.Core/DependencyInjection/BaseConsoleObservabilityExtensions.cs` (add the view)
- Test: `src/tests/BaseApi.Tests/Console/ConsumerDurationTests.cs`

**Interfaces:**
- Produces: `IngressMetrics.ConsumerDurationInstrument` = `"pipeline.consumer.duration"`; `IngressMetrics.RecordConsumerDuration(string queue, string type, string disposition, double seconds)`

- [ ] **Step 1: Write the failing test**

Create `src/tests/BaseApi.Tests/Console/ConsumerDurationTests.cs`:

```csharp
using BaseApi.Tests.Support;
using BaseConsole.Core.Messaging;
using Xunit;

namespace BaseApi.Tests.Console;

public sealed class ConsumerDurationTests
{
    [Fact]
    public void EveryDispositionCarriesItsOwnDuration()
    {
        using var metrics = new MetricCollector(IngressMetrics.MeterName);

        // Three terminal paths, one measurement each. A parked delivery's cost must be visible
        // beside a handled one's -- that is the whole meaning of "regardless of path", and it is
        // what pipeline.process.duration could not do, because it only measured the transform and
        // only on deliveries that reached one.
        IngressMetrics.RecordConsumerDuration("q-dur", "T", "acked", 0.010);
        IngressMetrics.RecordConsumerDuration("q-dur", "T", "requeued", 0.020);
        IngressMetrics.RecordConsumerDuration("q-dur", "T", "parked", 0.030);

        var mine = metrics.For(IngressMetrics.ConsumerDurationInstrument)
            .Where(m => m.Tags["queue"] == "q-dur")
            .ToList();

        Assert.Equal(3, mine.Count);
        Assert.Equal(
            ["acked", "requeued", "parked"],
            mine.Select(m => m.Tags["disposition"]));
        Assert.Equal([0.010, 0.020, 0.030], mine.Select(m => m.Value));
    }
}
```

`IngressMetrics` is `internal`; `BaseConsole.Core.csproj` already grants `InternalsVisibleTo` to `BaseApi.Tests`, which is how the existing `IngressMetricsTests` reach it.

- [ ] **Step 2: Run and confirm it fails**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: **compile failure** — `RecordConsumerDuration` does not exist.

- [ ] **Step 3: Add the instrument**

In `src/BaseConsole.Core/Messaging/IngressMetrics.cs`, add beside the other instruments:

```csharp
    /// <summary>
    /// Must match the name the view in <c>AddBaseConsoleObservability</c> targets. A view whose
    /// instrument name matches nothing is silently ignored, so a typo here costs the histogram its
    /// bucket boundaries and nothing reports the mistake.
    /// </summary>
    internal const string ConsumerDurationInstrument = "pipeline.consumer.duration";

    /// <summary>
    /// How long a delivery was held, from arrival to whatever the consumer decided.
    /// <para>
    /// <b>Recorded on every terminal path, which is what its predecessor could not do.</b>
    /// <c>pipeline.process.duration</c> measured only the author's transform, so a delivery parked
    /// for lacking a handler, or bounced off a shut gate, cost nothing that any instrument reported.
    /// The <c>disposition</c> tag is what keeps a slow success and a slow refusal from averaging
    /// into a number describing neither.
    /// </para>
    /// </summary>
    private static readonly Histogram<double> ConsumerDuration = Meter.CreateHistogram<double>(
        ConsumerDurationInstrument,
        unit: "s",
        description: "Seconds a delivery was held, whatever the consumer decided to do with it.");

    /// <summary>Records one delivery's cost, on whichever path it ended.</summary>
    internal static void RecordConsumerDuration(
        string queue, string type, string disposition, double seconds)
    {
        var tags = new TagList
        {
            { "queue", queue },
            { "type", type },
            { "disposition", disposition },
        };

        PipelineAmbientTag.AppendTo(ref tags);

        ConsumerDuration.Record(seconds, tags);
    }
```

- [ ] **Step 4: Add the bucket view**

In `src/BaseConsole.Core/DependencyInjection/BaseConsoleObservabilityExtensions.cs`, alongside the existing `AddView` calls:

```csharp
                // The arrival ladder rather than the transport's. Handler time sits in the same
                // band as arrival time -- tens of milliseconds with a tail -- and the transport's
                // boundaries stop at 10s, which would put a backlogged handler in +Inf where a
                // quantile has nothing to interpolate between.
                .AddView(
                    IngressMetrics.ConsumerDurationInstrument,
                    new ExplicitBucketHistogramConfiguration
                    {
                        Boundaries = IngressMetrics.ArrivalSecondsBoundaries(),
                    })
```

- [ ] **Step 5: Record it from the consumer, on every path**

In `src/BaseConsole.Core/Messaging/GatedQueueConsumer.cs`, in the delivery handler (around line 286):

Add above the `Record` local function:

```csharp
        var started = Stopwatch.GetTimestamp();

        // The value the outer catch's path carries. Every branch that calls Record overwrites it,
        // so this is only ever read for a delivery that escaped classification entirely.
        var disposition = "escaped";
```

Change the `Record` local function to capture it:

```csharp
        void Record(string d, string reason, bool landed)
        {
            recorded = true;
            disposition = d;
            IngressMetrics.RecordConsumed(_options.Queue, type, d, reason, landed);
        }
```

Then wrap the whole outer `try`/`catch` in a `finally`, so the gate-closed path — which returns before the handler region — is covered too:

```csharp
        finally
        {
            // OUTSIDE the handler region's own finally, because a delivery bounced off a shut gate
            // returns before that region is ever entered. It still cost this consumer time, and a
            // pause that is slow to reject is a real thing to be able to see.
            IngressMetrics.RecordConsumerDuration(
                _options.Queue, type, disposition,
                Stopwatch.GetElapsedTime(started).TotalSeconds);
        }
```

Ensure `using System.Diagnostics;` is present for `Stopwatch`.

- [ ] **Step 6: Run the full suite**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: **0 failed, exit code 0.**

- [ ] **Step 7: Commit**

```bash
git add src/BaseConsole.Core/Messaging/IngressMetrics.cs \
        src/BaseConsole.Core/Messaging/GatedQueueConsumer.cs \
        src/BaseConsole.Core/DependencyInjection/BaseConsoleObservabilityExtensions.cs \
        src/tests/BaseApi.Tests/Console/ConsumerDurationTests.cs
git commit -m "feat(observability): a refused delivery cost time too, and now says so"
```

---

### Task 6: Drop the `landed` tag

The distinction stays in the **log line** — an operator deciding whether to go looking in the dead-letter queue needs it — but leaves the metric.

**Files:**
- Modify: `src/BaseConsole.Core/Messaging/IngressMetrics.cs` (`RecordConsumed`)
- Modify: `src/BaseConsole.Core/Messaging/GatedQueueConsumer.cs` (6 call sites + the local function)
- Modify: `src/tests/BaseApi.Tests/Console/IngressMetricsTests.cs` (existing assertions on `landed`)

**Interfaces:**
- Produces: `IngressMetrics.RecordConsumed(string queue, string type, string disposition, string reason)` — the `bool landed` parameter is gone.

- [ ] **Step 1: Update the existing test first**

In `src/tests/BaseApi.Tests/Console/IngressMetricsTests.cs`, remove every assertion reading `Tags["landed"]` and every `landed:` argument. Add one test pinning the new tag set:

```csharp
    [Fact]
    public void ADeliveryCarriesExactlyFourTagsPlusAnyAmbientOne()
    {
        using var metrics = new MetricCollector(IngressMetrics.MeterName);

        IngressMetrics.RecordConsumed("q-tags", "T", "parked", "refused");

        var mine = metrics.For("pipeline.messages.consumed")
            .Single(m => m.Tags["queue"] == "q-tags");

        Assert.Equal("T", mine.Tags["type"]);
        Assert.Equal("parked", mine.Tags["disposition"]);
        Assert.Equal("refused", mine.Tags["reason"]);

        // landed is gone. A park that the broker was never told about is now indistinguishable
        // here from one it was -- the check is pipeline.deadletter.depth, where a park that did
        // not land never appears.
        Assert.False(mine.Tags.ContainsKey("landed"));
    }
```

- [ ] **Step 2: Run and confirm it fails**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: **compile failure** — `RecordConsumed` still requires five arguments.

- [ ] **Step 3: Remove the tag**

In `IngressMetrics.RecordConsumed`, drop the `bool landed` parameter and the tag:

```csharp
    /// <summary>
    /// One delivery, one measurement.
    /// <para>
    /// <b><c>disposition</c> says what the consumer decided; <c>reason</c> says why.</b> Without the
    /// second, all four requeue causes collapse into one number -- and <c>gate_closed</c> dominates
    /// it, because during any store outage every in-flight delivery bounces off the shut gate. That
    /// benign flood would bury <c>send_failed</c> and <c>escaped</c>, leaving a requeue spike an
    /// operator can see but not triage.
    /// </para>
    /// <para>
    /// <b>There is no <c>landed</c> tag.</b> Whether the broker was actually told survives in the
    /// consumer's own log line, where the operator deciding whether to search the dead-letter queue
    /// reads it. On a board the same question is answered by
    /// <c>pipeline.deadletter.depth</c>: a park that did not land never arrives there.
    /// </para>
    /// </summary>
    internal static void RecordConsumed(
        string queue, string type, string disposition, string reason)
    {
        var tags = new TagList
        {
            { "queue", queue },
            { "type", type },
            { "disposition", disposition },
            { "reason", reason },
        };

        PipelineAmbientTag.AppendTo(ref tags);

        Consumed.Add(1, tags);
    }
```

- [ ] **Step 4: Update the consumer's call sites**

In `GatedQueueConsumer`, change the local function to drop the parameter while **keeping** the `landed` locals that the log lines read:

```csharp
        void Record(string d, string reason)
        {
            recorded = true;
            disposition = d;
            IngressMetrics.RecordConsumed(_options.Queue, type, d, reason);
        }
```

Update all six calls: `Record("requeued", "gate_closed")`, `Record("requeued", "store_unreachable")`, `Record("requeued", "send_failed")`, `Record("parked", "refused")`, `Record("acked", "handled")`, and the outer catch's `IngressMetrics.RecordConsumed(_options.Queue, type, "requeued", "escaped")`.

**Leave every `var landed = await SafeNackAsync(...)` and `if (landed)` log branch exactly as it is.** They are the surviving record of the distinction.

- [ ] **Step 5: Run the full suite**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: **0 failed, exit code 0.**

- [ ] **Step 6: Commit**

```bash
git add src/BaseConsole.Core/Messaging/IngressMetrics.cs \
        src/BaseConsole.Core/Messaging/GatedQueueConsumer.cs \
        src/tests/BaseApi.Tests/Console/IngressMetricsTests.cs
git commit -m "refactor(observability): whether the broker was told is a log's answer, not a board's"
```

---

### Task 7: Trim `queue.wait` to `{queue}` and remove `step.elapsed`

**Files:**
- Modify: `src/BaseConsole.Core/Messaging/IngressMetrics.cs` (`RecordArrival`, `StepElapsed`, `StepElapsedInstrument`)
- Modify: `src/BaseConsole.Core/Messaging/GatedQueueConsumer.cs` (the `RecordArrival` call)
- Modify: `src/BaseConsole.Core/DependencyInjection/BaseConsoleObservabilityExtensions.cs` (the `StepElapsedInstrument` view)
- Modify: `src/tests/BaseApi.Tests/Console/ArrivalHistogramBucketTests.cs`, `LatencyHistogramBucketTests.cs` (any `step.elapsed` reference)

**Interfaces:**
- Produces: `IngressMetrics.RecordArrival(string queue, long? sentMs)` — the `type` and `originMs` parameters are gone.

- [ ] **Step 1: Write the failing test**

Add to `src/tests/BaseApi.Tests/Console/IngressMetricsTests.cs`:

```csharp
    [Fact]
    public void QueueWaitIsLabelledLikeQueueDepth()
    {
        using var metrics = new MetricCollector(IngressMetrics.MeterName);

        IngressMetrics.RecordArrival("q-wait", sentMs: MessageClock.NowMs() - 25);

        var mine = metrics.For(IngressMetrics.QueueWaitInstrument)
            .Single(m => m.Tags["queue"] == "q-wait");

        // One dimension, matching pipeline.queue.depth, so the two can be read side by side on a
        // board without one of them fanning out into a dimension the other does not have.
        Assert.False(mine.Tags.ContainsKey("type"));
    }

    [Fact]
    public void AMessageWithNoSentHeaderContributesNothingRatherThanZero()
    {
        using var metrics = new MetricCollector(IngressMetrics.MeterName);

        IngressMetrics.RecordArrival("q-noheader", sentMs: null);

        // A build without the instrument stamps no header, and there are always some during a
        // rollout. Recording those as zero would bury the real distribution under a spike that
        // means nothing.
        Assert.Empty(metrics.For(IngressMetrics.QueueWaitInstrument)
            .Where(m => m.Tags["queue"] == "q-noheader"));
    }
```

If `MessageClock.NowMs()` is not public, substitute the expression the existing arrival tests already use to build a `sentMs` value.

- [ ] **Step 2: Run and confirm it fails**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: **compile failure** — `RecordArrival` still takes four arguments.

- [ ] **Step 3: Rewrite `RecordArrival` and delete `StepElapsed`**

In `IngressMetrics`, delete the `StepElapsed` histogram, the `StepElapsedInstrument` constant, and replace the method:

```csharp
    /// <summary>
    /// Records how long this delivery waited in the broker.
    /// <para>
    /// <b>Recorded ONLY if the header was present.</b> A message published by a build without this
    /// instrument carries none, and during any rollout there are always some. Recording those as
    /// zero -- or as an elapsed time since the epoch -- would bury the real distribution under a
    /// spike that means nothing.
    /// </para>
    /// <para>
    /// <b>It double-counts the publisher confirm, and a panel must subtract it.</b> The header is
    /// stamped before the publish, so the sender's own confirm -- roughly 12 of ~13ms on this stack
    /// -- sits inside this number AND inside <c>pipeline.produce.duration</c>. True broker wait is
    /// the difference. See section 7.1 of the metrics-rewrite spec for the query.
    /// </para>
    /// <para>
    /// Labelled by queue alone, matching <c>pipeline.queue.depth</c>, so the two read side by side.
    /// </para>
    /// </summary>
    internal static void RecordArrival(string queue, long? sentMs)
    {
        if (sentMs is not { } sent)
        {
            return;
        }

        var tags = new TagList { { "queue", queue } };
        PipelineAmbientTag.AppendTo(ref tags);

        QueueWait.Record(MessageClock.ElapsedSeconds(sent), tags);
    }
```

- [ ] **Step 4: Update the call site and remove the view**

In `GatedQueueConsumer`, change the call to `IngressMetrics.RecordArrival(_options.Queue, sentMs);`.

**Keep `var originMs = MessageClock.ReadHeader(headers, MessageClock.OriginHeader);` and `MessageClock.Adopt(originMs);`** — the chain adoption is what makes a downstream step's origin the original step's, and it is unrelated to the removed instrument.

In `BaseConsoleObservabilityExtensions`, delete the `AddView` targeting `IngressMetrics.StepElapsedInstrument`. Leave the one targeting `QueueWaitInstrument`.

- [ ] **Step 5: Repoint the ladder's remarks**

`ArrivalSecondsBoundaries()`'s remarks are largely tuning history for `step.elapsed`. The ladder survives and now serves `queue.wait` and `consumer.duration`. Do **not** delete the history — it records why each rung exists. Change the opening sentence to name the two surviving readers, and add:

```csharp
    /// <para>
    /// <b>The step-elapsed measurements below are history, not a live reader.</b> That instrument
    /// was removed with the metric set of 2026-08-26; the rungs it forced stay, because they were
    /// fitted to the same operating band <c>pipeline.consumer.duration</c> now occupies.
    /// </para>
```

Fix `ArrivalHistogramBucketTests` if it asserts against `step.elapsed` by name; the 1.5×-ratio property assertion itself must survive unchanged.

- [ ] **Step 6: Run the full suite**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: **0 failed, exit code 0.**

- [ ] **Step 7: Commit**

```bash
git add src/BaseConsole.Core/Messaging/IngressMetrics.cs \
        src/BaseConsole.Core/Messaging/GatedQueueConsumer.cs \
        src/BaseConsole.Core/DependencyInjection/BaseConsoleObservabilityExtensions.cs \
        src/tests/BaseApi.Tests/Console/
git commit -m "refactor(observability): queue wait names a queue, the way depth does"
```

---

### Task 8: Dead-letter depth becomes event-driven

The value changes on exactly two occasions — something is parked, or an operator drains the queue by hand. A 30-second poll spends nearly every pass re-reading a number that cannot have moved.

**Files:**
- Create: `src/BaseConsole.Core/Messaging/DeadLetterReadSignal.cs`
- Modify: `src/Messaging.Transport/QueueStatsProbe.cs` (add `WaitAsync`)
- Modify: `src/BaseConsole.Core/Messaging/DeadLetterDepthProbe.cs` (override `WaitAsync`)
- Modify: `src/BaseConsole.Core/Messaging/GatedQueueConsumer.cs` (raise the signal on park)
- Modify: `src/BaseProcessor.Core/DependencyInjection/BaseProcessorServiceCollectionExtensions.cs` (30s → 5min)
- Test: `src/tests/BaseApi.Tests/Console/DeadLetterReadSignalTests.cs`

**Interfaces:**
- Produces: `DeadLetterReadSignal.Requested` (`Task`), `.Request()`, `.Reset()`; `QueueStatsProbe.WaitAsync(TimeSpan interval, CancellationToken ct)` (`protected virtual`)

- [ ] **Step 1: Write the failing test**

Create `src/tests/BaseApi.Tests/Console/DeadLetterReadSignalTests.cs`:

```csharp
using BaseConsole.Core.Messaging;
using Xunit;

namespace BaseApi.Tests.Console;

public sealed class DeadLetterReadSignalTests
{
    [Fact]
    public async Task ARequestCompletesTheWaitAndAResetArmsItAgain()
    {
        DeadLetterReadSignal.Reset();
        var first = DeadLetterReadSignal.Requested;
        Assert.False(first.IsCompleted);

        DeadLetterReadSignal.Request();
        await first;   // completes, or the test times out

        // Reset replaces the source rather than clearing it, mirroring L2Gate.Tripped: a waiter
        // holding the old task must not be re-armed out from under itself.
        DeadLetterReadSignal.Reset();
        Assert.False(DeadLetterReadSignal.Requested.IsCompleted);
        Assert.True(first.IsCompleted);
    }

    [Fact]
    public void RepeatedRequestsBeforeAResetAreOneRequest()
    {
        DeadLetterReadSignal.Reset();

        DeadLetterReadSignal.Request();
        DeadLetterReadSignal.Request();

        // A burst of parks must not queue a burst of broker round trips. One pending read is
        // enough -- it will see whatever the queue holds by the time it runs.
        Assert.True(DeadLetterReadSignal.Requested.IsCompleted);
    }
}
```

- [ ] **Step 2: Run and confirm it fails**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: **compile failure** — `DeadLetterReadSignal` does not exist.

- [ ] **Step 3: Write the signal**

Create `src/BaseConsole.Core/Messaging/DeadLetterReadSignal.cs`:

```csharp
namespace BaseConsole.Core.Messaging;

/// <summary>
/// A request to read the dead-letter depth now, raised where a message is actually refused.
/// <para>
/// <b>Why the read is event-driven and the loop is only a backstop.</b> A dead-letter depth changes
/// on exactly two occasions: something is parked, or an operator drains the queue by hand. Polling
/// it spends nearly every pass re-reading a number that cannot have moved. Raising it here makes
/// the number timely at the one moment it can change from inside the process; the slow loop exists
/// only so a manual drain is eventually noticed, because without it a drained queue would report a
/// stale non-zero forever -- the exact failure this gauge exists to prevent.
/// </para>
/// <para>
/// <b>The task is replaced on reset rather than cleared</b>, mirroring <c>L2Gate.Tripped</c>: a
/// waiter holding the completed task must not be re-armed out from under itself.
/// </para>
/// <para>
/// A static, like <see cref="Messaging.Transport.DispatchedQueues"/>, because the raiser and the
/// reader are in different assemblies and threading a seam between them would buy nothing -- there
/// is one dead-letter probe per process.
/// </para>
/// </summary>
public static class DeadLetterReadSignal
{
    private static volatile TaskCompletionSource _signal = Fresh();

    /// <summary>Completes when a read has been requested. Await it alongside an interval.</summary>
    public static Task Requested => _signal.Task;

    /// <summary>
    /// Ask for a read. Idempotent until <see cref="Reset"/>: a burst of parks is one request, not
    /// one broker round trip each, and a single read sees whatever the queue holds by the time it
    /// runs.
    /// </summary>
    public static void Request() => _signal.TrySetResult();

    /// <summary>Re-arm, after a read has been taken.</summary>
    public static void Reset() => _signal = Fresh();

    private static TaskCompletionSource Fresh() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);
}
```

- [ ] **Step 4: Make the shared loop's wait overridable**

In `src/Messaging.Transport/QueueStatsProbe.cs`, replace the `Task.Delay(_interval, stoppingToken)` at the bottom of the loop with `await WaitAsync(_interval, stoppingToken)`, and add:

```csharp
    /// <summary>
    /// Waits until the next pass is due. Virtual so a subclass whose number changes on an event
    /// rather than on a clock can wake early -- see <c>DeadLetterDepthProbe</c>.
    /// </summary>
    protected virtual Task WaitAsync(TimeSpan interval, CancellationToken ct) =>
        Task.Delay(interval, ct);
```

- [ ] **Step 5: Override it in the dead-letter probe**

In `src/BaseConsole.Core/Messaging/DeadLetterDepthProbe.cs`:

```csharp
    /// <summary>
    /// The interval, or a park -- whichever comes first. The interval is the backstop that notices
    /// a manual drain; the signal is what makes a newly parked message visible without waiting for
    /// it.
    /// </summary>
    protected override async Task WaitAsync(TimeSpan interval, CancellationToken ct)
    {
        var requested = DeadLetterReadSignal.Requested;

        await Task.WhenAny(Task.Delay(interval, ct), requested).ConfigureAwait(false);
        ct.ThrowIfCancellationRequested();

        // Re-armed only when the signal is what woke us. Resetting unconditionally would discard a
        // park that arrived while the interval was elapsing, and that park is the one reading this
        // probe exists to make timely.
        if (requested.IsCompleted)
        {
            DeadLetterReadSignal.Reset();
        }
    }
```

- [ ] **Step 6: Raise it where a message is parked**

In `GatedQueueConsumer`, in the `default:` (park) branch, immediately after `Record("parked", "refused");`:

```csharp
                            // The depth gauge's cadence is five minutes; this is what makes the
                            // number reflect this park now rather than at the next backstop pass.
                            // Raised even when the nack did not land -- in that case the broker
                            // redelivers rather than dead-letters, and a read that finds nothing
                            // new costs one round trip.
                            DeadLetterReadSignal.Request();
```

- [ ] **Step 7: Slow the loop to five minutes**

In `AddProcessorExecution`, change the `DeadLetterDepthProbe` interval from `TimeSpan.FromSeconds(30)` to `TimeSpan.FromMinutes(5)` and replace the cadence paragraph in the surrounding comment:

```csharp
        // Five minutes, not thirty seconds, and the number is no longer what makes this timely.
        // DeadLetterReadSignal wakes this probe the moment something is parked; the interval is
        // only the backstop that notices an operator draining the queue by hand. Without that
        // backstop a drained queue would report a stale non-zero forever.
```

- [ ] **Step 8: Run the full suite**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: **0 failed, exit code 0.** `DeadLetterDepthTests` may assert the old interval — update it to the new cadence rather than reverting the change.

- [ ] **Step 9: Commit**

```bash
git add src/BaseConsole.Core/Messaging/DeadLetterReadSignal.cs \
        src/BaseConsole.Core/Messaging/DeadLetterDepthProbe.cs \
        src/BaseConsole.Core/Messaging/GatedQueueConsumer.cs \
        src/Messaging.Transport/QueueStatsProbe.cs \
        src/BaseProcessor.Core/DependencyInjection/BaseProcessorServiceCollectionExtensions.cs \
        src/tests/BaseApi.Tests/Console/DeadLetterReadSignalTests.cs
git commit -m "perf(observability): the dead-letter read follows the park, not the clock"
```

---

### Task 9: Remove the four superseded instruments

`pipeline.consumer.consuming`, `pipeline.consumer.inflight`, `pipeline.consumer.channel.resets`, `pipeline.process.duration`, `pipeline.duplicate.suppressed`.

**Read the scope warning at the top of this plan first** — these live in shared assemblies and the removal reaches the orchestrator.

**Files:**
- Modify: `src/BaseConsole.Core/Messaging/IngressMetrics.cs`
- Modify: `src/BaseConsole.Core/Messaging/GatedQueueConsumer.cs`
- Modify: `src/BaseProcessor.Core/Observability/ProcessorPipelineMetrics.cs`
- Modify: `src/BaseProcessor.Core/Processing/ProcessDispatchHandler.cs` (lines ~175, ~268)
- Modify: `src/Processor.Sample/ProcessorHost.cs` (the `AddView`, lines ~92-108)
- Modify/delete: `src/tests/BaseApi.Tests/Console/ConsoleObservabilityTests.cs`, `IngressMetricsTests.cs`, `src/tests/BaseApi.Tests/Processor/ProcessorPipelineMetricsTests.cs`, `ProcessDispatchHandlerTests.cs`

- [ ] **Step 1: Delete the tests that pin the removed instruments**

Search first, so nothing is missed:

```bash
grep -rn "consumer.consuming\|consumer.inflight\|channel.resets\|process.duration\|duplicate.suppressed\|TrackConsumer\|UntrackConsumer\|AddInflight\|RecordChannelReset\|RecordProcessDuration\|RecordDuplicateSuppressed" src/ --include=*.cs | grep -v /obj/
```

Delete the test methods asserting these instruments. Do **not** delete a whole test class that also covers surviving behaviour.

- [ ] **Step 2: Run and confirm the suite is green before the production change**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: **0 failed, exit code 0.** Removing tests before production code keeps the next step's compile errors pointing only at production call sites.

- [ ] **Step 3: Strip `IngressMetrics`**

Delete: the `Inflight` `UpDownCounter`, the `ChannelResets` `Counter`, the `Consumers` registry, the static constructor's `CreateObservableGauge` for `pipeline.consumer.consuming`, and the methods `TrackConsumer`, `UntrackConsumer`, `ObserveConsuming`, `AddInflight`, `RecordChannelReset`.

**If the static constructor becomes empty, delete it.**

- [ ] **Step 4: Strip `GatedQueueConsumer`**

Remove every `IngressMetrics.AddInflight(...)`, `IngressMetrics.RecordChannelReset(...)`, `IngressMetrics.TrackConsumer(...)` and `UntrackConsumer(...)` call. The `try`/`finally` that existed only to balance the in-flight count can collapse; **the outer `finally` added in Task 5 must stay**, because the consumer-duration recording lives there.

- [ ] **Step 5: Strip `ProcessorPipelineMetrics`**

Delete the `DuplicateSuppressed` counter, the `ProcessDuration` histogram, `ProcessorPipelineMeter.ProcessDurationInstrument`, `RecordDuplicateSuppressed()` and `RecordProcessDuration(...)`.

**Keep the `Meter` and `ProcessorPipelineMetricsHost`** — `pipeline.identity.ready` hangs off them and is in the surviving set.

In `ProcessDispatchHandler`, delete the `RecordDuplicateSuppressed()` call at ~line 175 and the `RecordProcessDuration(started, ran)` call at ~line 268. **Keep the `_logger.LogInformation("entry absent — treating as a duplicate delivery")` line** — with the counter gone it is the only remaining record of a condition that can be a silent loss rather than a safe duplicate.

- [ ] **Step 6: Remove the view in `ProcessorHost`**

Delete the `.AddView(ProcessorPipelineMeter.ProcessDurationInstrument, ...)` block and the paragraph above it explaining why the transform histogram needed the transport's boundaries. If the `WithMetrics` call is left with only `.AddMeter(ProcessorPipelineMeter.Name)`, keep that — the meter still carries `identity.ready`.

- [ ] **Step 7: Run the full suite**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: **0 failed, exit code 0.**

- [ ] **Step 8: Commit**

```bash
git add -A src/
git commit -m "refactor(observability): five instruments that answered a question something else answers better"
```

---

### Task 10: Clean the comments that now point at nothing

The spec calls a comment naming a removed instrument a defect on the same footing as a broken reference. This codebase's remarks carry the reasoning, so a stale one is a *wrong explanation*.

**Files:** as listed in spec section 8.

- [ ] **Step 1: Find every stale reference**

```bash
grep -rn "consumer.consuming\|consumer.inflight\|channel.resets\|process.duration\|duplicate.suppressed\|step.elapsed\|StepElapsed\|landed" src/ --include=*.cs | grep -v /obj/
```

- [ ] **Step 2: Fix each one**

| Location | What to do |
| --- | --- |
| `QueueDepthMetrics` remarks | The "consumers is broker-side truth, which nothing else here is" paragraph compares against `pipeline.consumer.consuming`. **The comparison still holds and is now stronger** — rewrite it to say the self-asserted gauge was removed *because* this one is better, rather than deleting the paragraph. |
| `L2GateMetrics` remarks | Cites `IngressMetrics`' consumer gauge as the duplicate-stream precedent. Repoint to `QueueDepthMetrics` or `DeadLetterDepthMetrics`, both of which still carry the registry pattern. The hazard is unchanged. |
| `IngressMetrics.RecordConsumed` | Already rewritten in Task 6, Step 3. Verify no `landed` mention survives. |
| `IngressMetrics.ArrivalSecondsBoundaries` | Already repointed in Task 7, Step 5. Verify. |
| `ProcessorPipelineMetrics` type remarks | Describe instruments that no longer exist. Rewrite to describe what the type now is: a meter and a readiness gauge. |
| `ProcessorHost.Create` | The `AddView` paragraph goes with the view (Task 9, Step 6). Verify. |
| `ProcessorStartupOrchestrator`, `QueueStatsProbe`, `DispatchedQueues` | Read them. Expected to stand unchanged; if `QueueStatsProbe`'s channel-cost paragraph quotes the dead-letter probe's 30-second interval, update the arithmetic to five minutes. |

- [ ] **Step 3: Confirm the grep is clean**

Re-run the Step 1 grep. Every remaining hit must be a **deliberate historical reference** in a paragraph that says so — like the `ArrivalSecondsBoundaries` history note — and nothing that reads as a live cross-reference.

- [ ] **Step 4: Build and run the full suite**

```bash
dotnet build SK_P.sln && dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: no warnings about unresolvable `<see cref="..."/>` targets; **0 failed, exit code 0.**

- [ ] **Step 5: Commit**

```bash
git add -A src/
git commit -m "docs(observability): a comment naming a removed instrument is a wrong explanation"
```

---

### Task 11: Rebuild the boards

**Files:**
- Modify: `grafana/build-dashboards.py` — `build_processor()` (~line 2279), and the shared helpers `pipeline_shared()` (~1004), `depth_panels()` (~1270), `since_shared()` (~926), `verdict_shared()` (~856)
- Regenerate: `grafana/dashboards/*.json`
- Modify: `k8s/24-grafana-dashboards.yaml` if the generator writes it (`write_configmap()`, ~line 69)

- [ ] **Step 1: Find every panel reading a removed series**

```bash
cd grafana
grep -n "consumer_consuming\|consumer_inflight\|channel_resets\|process_duration\|duplicate_suppressed\|step_elapsed" build-dashboards.py
```

Every hit is a panel that will render no-data after Task 9. Because `pipeline_shared()` is called by the flow, orchestrator **and** processor boards, a removal there affects all three — which is correct, since the instruments are gone fleet-wide.

- [ ] **Step 2: Remove those panels and their layout slots**

Delete each panel expression together with its `lay.place(...)` consumption, so the grid does not leave a hole. Where a panel is one of several in a shared helper's returned list, check the slicing at the call sites — `build_processor` does `panels += v[:2]` and `panels += v[2:]`, so removing an element from `verdict_shared`'s list shifts those indices.

- [ ] **Step 3: Add the new panels to `build_processor()`**

Three panels are new. Add them to the pipeline row, following the existing `timeseries(...)` call shape:

```python
    panels += [
        timeseries(lay, "Loop rate by loop",
                   [(f'rate(pipeline_loop_iterations_total{{{f}}}[$__rate_interval])',
                     "{{loop}} {{instance}}")],
                   desc="Every watched loop's actual cadence. l2-gate should sit at 0.2/s, "
                        "processor-liveness and queue-depth at 0.1/s." + PARA +
                        "This is what the liveness health checks cannot say. A stale window "
                        "is binary -- it fires at 15s or 30s and says nothing before that -- "
                        "while a loop running at 0.12/s instead of 0.2/s is degrading and "
                        "still green on every probe. Zero means the loop is gone; the counter "
                        "is seeded, so zero is a reading rather than an absence.",
                   unit="reqps", decimals=2),

        timeseries(lay, "Consumer duration by disposition",
                   [(f'sum by (queue,disposition) '
                     f'(rate(pipeline_consumer_duration_seconds_sum{{{f}}}[$__rate_interval])) '
                     f'/ sum by (queue,disposition) '
                     f'(rate(pipeline_consumer_duration_seconds_count{{{f}}}[$__rate_interval]))',
                     "mean {{queue}} {{disposition}}")],
                   desc="How long a delivery was held, on every path including the ones that "
                        "never reached a handler. Split by disposition so a slow success and a "
                        "slow refusal cannot average into a number describing neither." + PARA +
                        "A mean rather than a quantile, deliberately: quantiles off this ladder "
                        "are interpolation between rung edges, and at the sample counts this "
                        "board sees they flip between levels.",
                   unit="s"),

        stat(lay, "Restarts (1h)",
             [f'max(changes(pipeline_process_start_timestamp_seconds{{{f}}}[1h])) or vector(0)'],
             desc="How many times any replica restarted in the last hour. The gauge holds the "
                  "process start time and moves exactly once per process, so changes() over a "
                  "window is the restart count." + PARA +
                  "It works because InstanceId resolves to POD_NAME, stable across container "
                  "restarts within a pod -- a restart moves the value on an existing series "
                  "rather than creating a new one.",
             thresholds=T_WARN, decimals=0),
    ]
```

- [ ] **Step 4: Add the queue-wait panel**

Per spec section 7.1, two series. The `label_replace` and the `avg by (queue)` on both sides are mandatory — without either, the expression returns **no data rather than an error**:

```python
    _wait_mean = (f'avg by (queue) ('
                  f'rate(pipeline_queue_wait_seconds_sum{{{f}}}[$__rate_interval]) '
                  f'/ rate(pipeline_queue_wait_seconds_count{{{f}}}[$__rate_interval]))')
    _produce_mean = (f'avg by (queue) (label_replace('
                     f'rate(pipeline_produce_duration_seconds_sum{{{f}}}[$__rate_interval]) '
                     f'/ rate(pipeline_produce_duration_seconds_count{{{f}}}[$__rate_interval]), '
                     f'"queue", "$1", "destination", "(.*)"))')

    panels += [
        timeseries(lay, "Queue wait by queue",
                   [(_wait_mean, "raw {{queue}}"),
                    (f'{_wait_mean} - on(queue) group_left {_produce_mean}', "net {{queue}}")],
                   desc="Seconds between publish and pickup." + PARA +
                        "TWO SERIES BECAUSE THE RAW ONE IS WRONG. The sent header is stamped "
                        "before the publish, so the sender's own publisher confirm -- about 12 "
                        "of ~13ms on this stack -- sits inside this number and inside produce "
                        "duration both. The net series subtracts it and is the one to read; "
                        "the raw series is here to show how much of it was never broker wait." +
                        PARA +
                        "The net expression is a difference of two means over different "
                        "populations, so it is directional rather than exact. Near zero is the "
                        "healthy reading; growing is real queueing." + PARA +
                        "label_replace joins queue to destination -- they hold the same string "
                        "under different label names -- and the avg by (queue) on both sides "
                        "keeps a cross-process match from going many-to-many. Both fail to "
                        "no-data rather than to an error if removed.",
                   unit="s"),
    ]
```

- [ ] **Step 5: Update the consumer-paths panel to carry `reason`**

Find the existing `pipeline_messages_consumed_total` panel in `pipeline_shared()` and ensure it groups by `(queue, disposition, reason)`. If it currently groups by `landed`, remove that dimension — the series no longer exists.

- [ ] **Step 6: Regenerate and check the expressions**

```bash
cd grafana
python build-dashboards.py
python check-expressions.py
```

Expected: the generator writes the five JSON files; the expression check reports no errors.

⚠️ **A green expression check is not evidence the board works.** It parses PromQL; it does not query Prometheus. The board probes in Task 12 are what verify the panels actually resolve.

- [ ] **Step 7: Commit**

```bash
git add grafana/build-dashboards.py grafana/dashboards/ k8s/24-grafana-dashboards.yaml
git commit -m "feat(grafana): the processor board asks the questions the new series can answer"
```

---

### Task 12: Verify against the live stack

**Files:** none modified — this task is evidence.

- [ ] **Step 1: Confirm the hermetic baseline**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Read the **shape**: 0 failed, exit code 0, everything under `Live/` skipped. Never compare against a remembered total.

- [ ] **Step 2: Build, load and repoint the processor image**

The cluster is `kind` (the kubectl context says `docker-desktop`, but it is kind). Every processor rebuild needs its `SourceHash` repointed in the database, or the new image waits forever on an identity row that does not match it.

```bash
docker build -t skp-processor:dev -f src/Processor.Sample/Dockerfile .
kind load docker-image skp-processor:dev --name desktop
kubectl -n skp rollout restart deploy/processor
```

Then repoint the registered `SourceHash` to the new image's, as the deploy loop requires.

⚠️ A rollout timeout here is **not** necessarily a failure. An unregistered processor sits `Running` / `NotReady` with 0 restarts by design, waiting for its row. That is the expected signal, not a crash loop.

- [ ] **Step 3: Confirm the new series exist and carry the right shape**

Port-forwards are supervised and run on offset ports — never `netstat` the default ports to judge reachability. Query Prometheus through its forward:

```bash
curl -s 'http://localhost:<prom-port>/api/v1/query?query=pipeline_loop_iterations_total' | python -m json.tool
curl -s 'http://localhost:<prom-port>/api/v1/query?query=pipeline_process_start_timestamp_seconds' | python -m json.tool
curl -s 'http://localhost:<prom-port>/api/v1/query?query=pipeline_consumer_duration_seconds_count' | python -m json.tool
```

Expected: `pipeline_loop_iterations_total` carries **exactly three** `loop` values — `l2-gate`, `processor-liveness`, `queue-depth` — and no `processor-startup`.

- [ ] **Step 4: Confirm the rates match the configured cadences**

```bash
curl -s --data-urlencode 'query=rate(pipeline_loop_iterations_total[5m])' \
     'http://localhost:<prom-port>/api/v1/query' | python -m json.tool
```

Expected: ≈0.2 for `l2-gate`, ≈0.1 for `processor-liveness` and `queue-depth`. A value materially below these is a slow loop and is exactly what this instrument was added to show.

- [ ] **Step 5: Confirm the removed series are gone**

```bash
for m in pipeline_consumer_consuming pipeline_consumer_inflight \
         pipeline_consumer_channel_resets_total pipeline_process_duration_seconds_count \
         pipeline_duplicate_suppressed_total pipeline_step_elapsed_seconds_count; do
  echo "== $m"
  curl -s "http://localhost:<prom-port>/api/v1/query?query=$m" | python -c 'import sys,json; print(len(json.load(sys.stdin)["data"]["result"]))'
done
```

Expected: `0` for each **from processor instances**. Older samples inside the retention window still resolve — scope the queries by time if a non-zero count needs explaining.

- [ ] **Step 6: Probe the boards, not the queries**

A green `check-expressions.py` proves the PromQL parses, not that a panel renders. Use the existing board probes:

```bash
cd grafana
node probe-three-panels.js
node audit-nav.js
```

⚠️ **Do not judge series presence from a chaos-timeline legend** — it samples legend text at `now-15m` and no run can show a line stopping. Use `query_range` for that question.

- [ ] **Step 7: Verify the dead-letter read follows a park**

Park a message, then confirm `pipeline_deadletter_depth` moves well inside the five-minute backstop:

```bash
curl -s --data-urlencode 'query=pipeline_deadletter_depth' \
     'http://localhost:<prom-port>/api/v1/query' | python -m json.tool
```

Expected: the depth reflects the new park within roughly one export interval (~10s), not five minutes. If it takes the full interval, `DeadLetterReadSignal.Request()` is not reaching the probe.

- [ ] **Step 8: Commit the evidence**

```bash
git commit --allow-empty -F- <<'MSG'
test(observability): the new set answers on the live stack

Three loop series at their configured cadences, six removed series gone from
processor instances, and the dead-letter depth moving on a park rather than on
the five-minute backstop. Board probes green against the rendered panels, not
just against the expressions.
MSG
```

---

## Self-Review

**Spec coverage.** Every section maps to a task: §4.1 → Tasks 1–4; §4.2 → Tasks 3, 8; §4.3 → Tasks 5–7; §4.4 → unchanged, verified in Task 12; §4.6 initial states → Task 1 Step 3 (seed), Task 4 Step 3 (documented exception); §5.1–5.7 → Tasks 1–8; §6 removals → Task 9; §7 dashboard incl. 7.1 → Task 11; §8 comment cleanup → Task 10; §9–10 non-goals and open gaps → no tasks, correctly.

**Type consistency.** `CountingLoopHeartbeat(ILoopHeartbeat, string)` is constructed identically in Tasks 2 and 3. `RecordConsumed` loses its fifth parameter in Task 6 only, after Task 5 has already added the `disposition` capture that Task 6's local function keeps. `RecordArrival` drops two parameters in Task 7 only. `QueueStatsProbe` gains `heartbeat` in Task 3 and `WaitAsync` in Task 8 — Task 8's edit must land on the Task 3 signature, which is why the order matters.

**Ordering constraint.** Task 5 must precede Task 6 (the `disposition` local it introduces is what Task 6's trimmed `Record` keeps) and Task 9 (whose `finally` collapse must not remove the duration recording). Task 3 must precede Task 8. Task 9 must precede Tasks 10 and 11.

**Known open question:** the shared-assembly scope fact at the top of this plan. It is the one thing that could change task content rather than task order.
