# Pipeline Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit one vocabulary of transport-level metrics from both the orchestrator and every processor, so a produced count and a consumed count for the same message type can sit on one graph and the gap between them is the backlog.

**Architecture:** Every pipeline event on both roles already flows through three shared classes — `QueueSender` (egress), `GatedQueueConsumer` (ingress), and `L2Gate` (the pause signal). Instruments go in those classes' assemblies and the meters are registered in `AddBaseConsoleObservability`, which both hosts already call. Neither role gets a bespoke counter, so neither can drift from the other. Role-specific gauges are four flags that explain *why* a pipeline is idle.

**Tech Stack:** .NET 8, `System.Diagnostics.Metrics` (`Meter`, `Counter<T>`, `Histogram<T>`, `ObservableGauge<T>`, `TagList`), OpenTelemetry .NET 1.15.3, RabbitMQ.Client 7.1.2, StackExchange.Redis, xUnit v3 (Microsoft.Testing.Platform runner), NSubstitute 5.3.0.

**Spec:** `docs/superpowers/specs/2026-08-22-pipeline-metrics-design.md` — read §1–§11 before Task 1. The plan argues from the spec; where this plan gives a rule without a reason, the reason is in the spec.

## Global Constraints

- Target framework `net8.0`, `Nullable=enable`, `LangVersion=latest`. Warnings are not errors, but do not add any.
- **No new package references.** `System.Diagnostics.Metrics` already resolves in `Messaging.Transport` via RabbitMQ.Client 7.1.2's transitive `System.Diagnostics.DiagnosticSource`. This was verified by building a probe file; if a package reference seems needed, stop and report rather than adding one.
- All five source projects already declare `<InternalsVisibleTo Include="BaseApi.Tests" />`. No project file needs to change for test access.
- **`DynamicProxyGenAssembly2` is deliberately NOT granted internals access** (see `BaseConsole.Core/Startup/RabbitMqConnectivityCheck.cs:18`). NSubstitute cannot substitute `internal` types. Use hand-written fakes, as `ConsumerAdmissionTests` already does. Public interfaces such as `RabbitMQ.Client.IChannel` and `IQueueMessageHandler` *can* be substituted.
- Instrument prefix is `pipeline.`. Counters carry unit `{message}`, histograms unit `s` (seconds), gauges unit `1`.
- **Never put `ProcessorId`, `WorkflowId`, `ExecutionId`, `CorrelationId`, payload bytes, or validator text on an instrument.** Spec §2.1. The first is already a resource attribute; the rest are unbounded or sensitive and belong on logs.
- Attribute vocabularies are closed sets, spelled exactly:
  - `route`: `queue` · `fanout`
  - `outcome`: `accepted` · `unroutable` · `transient` · `refused`
  - `disposition`: `acked` · `requeued` · `parked`
  - `reason`: `handled` · `gate_closed` · `store_unreachable` · `send_failed` · `refused`
  - `landed`: `true` · `false`
  - `pipeline.consumer.channel.resets` `reason`: `shutdown` · `recovered` · `reopened`
- **Do not modify `BaseConsole.Core/Gating/L2Gate.cs` or `BaseApi.Core/Gating/L2Gate.cs`.** Spec §6: the two are deliberate copies bound to stay identical, and the API-side one is out of scope.
- **Do not modify anything under `BaseApi.Core/` or `BaseApi.Service/`.** Spec §10 holds the API side out of scope, including its separate `GatedQueueConsumer` copy.
- Metric recording must never change control flow. Every classification is read-only; every exception propagates exactly as it does today.
- **Hermetic baseline: 451 tests — 444 passed, 7 skipped, 0 failed, ~15s.** Every task must end here. The 7 skips are `Live/` RealStack tests and must stay skipped.

### Commands

Full suite (use this at the end of every task):

```bash
dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug
```

One test class or method — `--filter-method` with glob syntax. Note that the
VSTest-style `--filter "Category!=X"` is silently ignored by this runner; use
`--filter-method` and `--filter-trait` only:

```bash
dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug -- --filter-method "*EgressMetrics*"
```

---

## File Structure

**Create:**

| File | Responsibility |
| --- | --- |
| `src/Messaging.Transport/EgressMetrics.cs` | The egress meter, its two instruments, the `outcome` classifier, and the `MeasureAsync` wrapper both send primitives call. |
| `src/BaseConsole.Core/Messaging/IngressMetrics.cs` | The ingress meter, its four instruments, the consumer registry behind the single `consuming` gauge, and one `Record` entry point. |
| `src/BaseConsole.Core/Gating/L2GateMetrics.cs` | Owns `pipeline.gate.open` and `pipeline.gate.trips` over the `L2Gate` singleton without modifying it. |
| `src/Orchestrator/Observability/OrchestratorPipelineMetrics.cs` | Owns `pipeline.leader` and `pipeline.hydration.admitted`. |
| `src/BaseProcessor.Core/Observability/ProcessorPipelineMetrics.cs` | Owns `pipeline.identity.ready` and `pipeline.duplicate.suppressed`. |
| `src/tests/BaseApi.Tests/Support/MetricCollector.cs` | Test-only `MeterListener` wrapper: subscribe by meter name, force a collection of observables, assert on recorded measurements. |
| `src/tests/BaseApi.Tests/Transport/EgressMetricsTests.cs` | The `outcome` classifier table and `MeasureAsync` behaviour. |
| `src/tests/BaseApi.Tests/Console/IngressMetricsTests.cs` | The §5.1 disposition matrix, the exactly-once invariant, inflight, the consuming gauge, and channel resets. |
| `src/tests/BaseApi.Tests/Console/L2GateMetricsTests.cs` | Gate gauge and trip counter. |
| `src/tests/BaseApi.Tests/Orchestrator/OrchestratorPipelineMetricsTests.cs` | Leader and hydration gauges. |
| `src/tests/BaseApi.Tests/Processor/ProcessorPipelineMetricsTests.cs` | Identity gauge and the duplicate-suppression counter. |

**Modify:**

| File | Change |
| --- | --- |
| `src/Messaging.Transport/QueueSender.cs` | Wrap the send body in `EgressMetrics.MeasureAsync`. |
| `src/Messaging.Transport/QueueFanoutPublisher.cs` | Same, with `route = fanout`. |
| `src/BaseConsole.Core/Messaging/GatedQueueConsumer.cs` | `OnReceivedAsync` becomes `internal`; `SafeAckAsync`/`SafeNackAsync` return `bool`; one `IngressMetrics.Record` per exit path; inflight; consumer registration; channel-reset counter. |
| `src/BaseConsole.Core/DependencyInjection/BaseConsoleObservabilityExtensions.cs` | Three `.AddMeter(...)` lines. |
| `src/BaseConsole.Core/DependencyInjection/ConsoleRedisServiceCollectionExtensions.cs` | Register `L2GateMetrics` as a hosted service inside `AddBaseConsoleGating`. |
| `src/Orchestrator/OrchestratorHost.cs` | Register the orchestrator observer and add its meter. |
| `src/BaseProcessor.Core/DependencyInjection/BaseProcessorServiceCollectionExtensions.cs` | Register the processor observer. |
| `src/Processor.Sample/ProcessorHost.cs` | Add the processor meter to the metrics provider. |
| `src/BaseProcessor.Core/Processing/ProcessDispatchHandler.cs` | One counter increment on the duplicate-delivery return. |
| `src/tests/BaseApi.Tests/Console/ConsoleObservabilityTests.cs` | Assert the three shared meters are registered. |
| `src/tests/BaseApi.Tests/Orchestrator/OrchestratorHostWiringTests.cs` | Assert three distinct `queue` values on the consuming gauge. |

---

## Task 1: The egress meter and its outcome classifier

The classifier is a pure function and is the whole risk of the egress half: `SendFaultClassifier.IsTransport` returns **true** for `UnroutablePublishException` and for everything in the `RabbitMQ.Client` namespace, which includes `PublishException`. So testing transport before routing would collapse `unroutable` into `transient` and the distinction the spec exists to create would silently not happen.

**Files:**
- Create: `src/Messaging.Transport/EgressMetrics.cs`
- Create: `src/tests/BaseApi.Tests/Support/MetricCollector.cs`
- Test: `src/tests/BaseApi.Tests/Transport/EgressMetricsTests.cs`

**Interfaces:**
- Consumes: `SendFaultClassifier.IsTransport(Exception)`, `UnroutablePublishException`, `RabbitMQ.Client.Exceptions.PublishException` — all existing and public.
- Produces:
  - `internal static class EgressMetrics` in namespace `Messaging.Transport`
  - `internal const string EgressMetrics.MeterName = "Messaging.Transport"`
  - `internal const string EgressMetrics.RouteQueue = "queue"`, `RouteFanout = "fanout"`
  - `internal static string EgressMetrics.Classify(Exception? ex)`
  - `internal static Task EgressMetrics.MeasureAsync(string route, string destination, string type, Func<Task> send)`
  - `public sealed class MetricCollector : IDisposable` in namespace `BaseApi.Tests.Support`, with `MetricCollector(params string[] meterNames)`, `IReadOnlyList<RecordedMeasurement> Measurements`, `void Collect()`, and `record RecordedMeasurement(string Instrument, double Value, IReadOnlyDictionary<string, string> Tags)`

- [ ] **Step 1: Write the test-only metric collector**

This is infrastructure every later task uses, so it is built first and has no test of its own — it is exercised by every assertion that follows. `MeterListener` is the framework's own subscription API and needs no OpenTelemetry pipeline.

Create `src/tests/BaseApi.Tests/Support/MetricCollector.cs`:

```csharp
using System.Collections.Concurrent;
using System.Diagnostics.Metrics;

namespace BaseApi.Tests.Support;

/// <summary>
/// One measurement as the listener saw it, with tag values flattened to strings so an assertion
/// reads as a dictionary lookup rather than a cast.
/// </summary>
public sealed record RecordedMeasurement(
    string Instrument, double Value, IReadOnlyDictionary<string, string> Tags);

/// <summary>
/// Subscribes to instruments by meter name and records every measurement they publish.
/// <para>
/// A <see cref="MeterListener"/> rather than an OpenTelemetry provider: the SDK aggregates, which
/// would hide exactly the property most of these tests assert — that a counter was incremented
/// once and not twice.
/// </para>
/// <para>
/// Instruments are static, so they outlive any single test. That is safe here because a listener
/// only sees measurements published while it is subscribed, and each test constructs its own.
/// </para>
/// </summary>
public sealed class MetricCollector : IDisposable
{
    private readonly MeterListener _listener = new();
    private readonly ConcurrentQueue<RecordedMeasurement> _measurements = new();
    private readonly HashSet<string> _meters;

    public MetricCollector(params string[] meterNames)
    {
        _meters = new HashSet<string>(meterNames, StringComparer.Ordinal);

        _listener.InstrumentPublished = (instrument, listener) =>
        {
            if (_meters.Contains(instrument.Meter.Name))
            {
                listener.EnableMeasurementEvents(instrument);
            }
        };

        _listener.SetMeasurementEventCallback<long>(
            (instrument, value, tags, _) => Add(instrument, value, tags));
        _listener.SetMeasurementEventCallback<int>(
            (instrument, value, tags, _) => Add(instrument, value, tags));
        _listener.SetMeasurementEventCallback<double>(
            (instrument, value, tags, _) => Add(instrument, value, tags));

        _listener.Start();
    }

    /// <summary>Every measurement seen so far, in the order it was published.</summary>
    public IReadOnlyList<RecordedMeasurement> Measurements => _measurements.ToArray();

    /// <summary>Just the measurements for one instrument name.</summary>
    public IReadOnlyList<RecordedMeasurement> For(string instrument) =>
        Measurements.Where(m => m.Instrument == instrument).ToArray();

    /// <summary>
    /// Polls every observable instrument. Observables publish nothing until asked, so a gauge
    /// assertion that skips this sees an empty list.
    /// </summary>
    public void Collect() => _listener.RecordObservableInstruments();

    private void Add<T>(
        System.Diagnostics.Metrics.Instrument instrument,
        T value,
        ReadOnlySpan<KeyValuePair<string, object?>> tags)
        where T : struct
    {
        var flattened = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var tag in tags)
        {
            flattened[tag.Key] = tag.Value?.ToString() ?? "";
        }

        _measurements.Enqueue(new RecordedMeasurement(
            instrument.Name, Convert.ToDouble(value), flattened));
    }

    public void Dispose() => _listener.Dispose();
}
```

- [ ] **Step 2: Write the failing tests**

Create `src/tests/BaseApi.Tests/Transport/EgressMetricsTests.cs`:

```csharp
using System.Net.Sockets;
using BaseApi.Tests.Support;
using Messaging.Transport;
using RabbitMQ.Client.Exceptions;
using Xunit;

namespace BaseApi.Tests.Transport;

public sealed class EgressMetricsTests
{
    [Fact]
    public void ASendThatReturnedIsAccepted()
    {
        Assert.Equal("accepted", EgressMetrics.Classify(null));
    }

    [Fact]
    public void AnUnroutablePublishIsRoutingRatherThanTransport()
    {
        // The whole reason Classify tests routing before transport:
        // SendFaultClassifier.IsTransport returns TRUE for this type, so the opposite order
        // reports every undeclared queue as a broker blip -- and the two have opposite remedies.
        Assert.True(SendFaultClassifier.IsTransport(new UnroutablePublishException("x")));
        Assert.Equal("unroutable", EgressMetrics.Classify(new UnroutablePublishException("x")));
    }

    [Fact]
    public void ABrokerReturnIsRoutingRatherThanTransport()
    {
        // Same trap from the other direction: PublishException lives in the RabbitMQ.Client
        // namespace, which IsTransport matches wholesale by namespace prefix.
        var ex = new PublishException(PublishReturn.Create(312, "NO_ROUTE", "", ""), isReturn: true);

        Assert.True(SendFaultClassifier.IsTransport(ex));
        Assert.Equal("unroutable", EgressMetrics.Classify(ex));
    }

    [Fact]
    public void ASocketFailureIsTransient()
    {
        Assert.Equal("transient", EgressMetrics.Classify(new SocketException(10061)));
    }

    [Fact]
    public void AShutdownCancellationIsTransientRatherThanRefused()
    {
        // OperationCanceledException is on SendFaultClassifier's allow-list on purpose -- an
        // in-flight send during shutdown is the environment going away, not an unsendable message.
        Assert.Equal("transient", EgressMetrics.Classify(new OperationCanceledException()));
    }

    [Fact]
    public void ASerializationFaultIsRefused()
    {
        Assert.Equal("refused", EgressMetrics.Classify(new InvalidOperationException("bad")));
    }

    [Fact]
    public async Task ASuccessfulSendRecordsOneAcceptedMeasurementOnBothInstruments()
    {
        using var metrics = new MetricCollector(EgressMetrics.MeterName);

        await EgressMetrics.MeasureAsync(
            EgressMetrics.RouteQueue, "orchestrator-result", "step-outcome", () => Task.CompletedTask);

        var produced = Assert.Single(metrics.For("pipeline.messages.produced"));
        Assert.Equal(1, produced.Value);
        Assert.Equal("queue", produced.Tags["route"]);
        Assert.Equal("orchestrator-result", produced.Tags["destination"]);
        Assert.Equal("step-outcome", produced.Tags["type"]);
        Assert.Equal("accepted", produced.Tags["outcome"]);

        var duration = Assert.Single(metrics.For("pipeline.produce.duration"));
        Assert.Equal("accepted", duration.Tags["outcome"]);
        Assert.True(duration.Value >= 0);
    }

    [Fact]
    public async Task AFailedSendRecordsTheClassifiedOutcomeAndStillThrows()
    {
        using var metrics = new MetricCollector(EgressMetrics.MeterName);

        // The exception must reach the caller unchanged -- DeliveryClassifier and every catch
        // filter downstream turn on its type, so absorbing or wrapping it here would silently
        // repartition the requeue/park decision.
        await Assert.ThrowsAsync<SocketException>(() => EgressMetrics.MeasureAsync(
            EgressMetrics.RouteFanout, "orchestrator-fanout", "orchestration-started",
            () => throw new SocketException(10061)));

        var produced = Assert.Single(metrics.For("pipeline.messages.produced"));
        Assert.Equal("fanout", produced.Tags["route"]);
        Assert.Equal("transient", produced.Tags["outcome"]);

        Assert.Single(metrics.For("pipeline.produce.duration"));
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug -- --filter-method "*EgressMetrics*"
```

Expected: build failure — `EgressMetrics` does not exist. That is the failing state for a type that has not been written.

If `PublishReturn.Create(...)` does not compile, the RabbitMQ.Client 7.1.2 factory shape differs from what is written here. Find the real one with `grep -rn "PublishReturn" ~/.nuget/packages/rabbitmq.client/7.1.2/` and adjust that one line only — the assertion is about `Classify`, not about how the exception is built.

- [ ] **Step 4: Write the implementation**

Create `src/Messaging.Transport/EgressMetrics.cs`:

```csharp
using System.Diagnostics;
using System.Diagnostics.Metrics;
using RabbitMQ.Client.Exceptions;

namespace Messaging.Transport;

/// <summary>
/// Pipeline metrics for the egress half: one measurement per message handed to the broker, on both
/// send primitives, with the broker's confirmation inside the measured window.
/// <para>
/// <b>It wraps the primitives, not <c>SendTransientAsync</c>.</b> The entry-step dispatch in
/// <c>WorkflowFireJob</c> calls <see cref="IQueueSender.SendAsync{T}"/> raw and then SWALLOWS the
/// failure, so instrumenting the extension would leave the one path whose failures are otherwise
/// invisible with no metric at all. The processor's identity bootstrap and startup queries call it
/// raw too.
/// </para>
/// <para>
/// <b>Nothing here alters control flow.</b> <see cref="Classify"/> only reads an exception, and
/// <see cref="MeasureAsync"/> rethrows the original untouched — every catch filter downstream, and
/// <c>DeliveryClassifier</c> above them, turns on the exception's type.
/// </para>
/// </summary>
internal static class EgressMetrics
{
    /// <summary>
    /// Must match the string passed to <c>AddMeter</c> in <c>AddBaseConsoleObservability</c>. A
    /// constant rather than a literal in two places, because a typo produces no error and no
    /// metrics.
    /// </summary>
    internal const string MeterName = "Messaging.Transport";

    /// <summary>Addressed to a queue through the default exchange — <see cref="QueueSender"/>.</summary>
    internal const string RouteQueue = "queue";

    /// <summary>Addressed to a named exchange — <see cref="QueueFanoutPublisher"/>.</summary>
    internal const string RouteFanout = "fanout";

    private static readonly Meter Meter = new(MeterName);

    private static readonly Counter<long> Produced = Meter.CreateCounter<long>(
        "pipeline.messages.produced",
        unit: "{message}",
        description: "Messages handed to the broker, by route, destination, type and outcome.");

    private static readonly Histogram<double> Duration = Meter.CreateHistogram<double>(
        "pipeline.produce.duration",
        unit: "s",
        description: "Time from the start of a send until the broker confirmed or refused it.");

    /// <summary>
    /// The outcome attribute for a completed send. Null means it returned normally.
    /// <para>
    /// <b>Routing is tested before transport, and the order is load-bearing.</b>
    /// <see cref="SendFaultClassifier.IsTransport"/> returns true for
    /// <see cref="UnroutablePublishException"/> explicitly, and for <see cref="PublishException"/>
    /// implicitly because it matches the whole <c>RabbitMQ.Client</c> namespace. Asking it first
    /// would report every undeclared queue as a broker blip — and "declare the queue" and "wait for
    /// the broker" are opposite remedies.
    /// </para>
    /// </summary>
    internal static string Classify(Exception? ex) => ex switch
    {
        null                                => "accepted",
        UnroutablePublishException          => "unroutable",
        PublishException { IsReturn: true } => "unroutable",
        _ when SendFaultClassifier.IsTransport(ex) => "transient",
        _                                   => "refused",
    };

    /// <summary>
    /// Runs one send and records exactly one measurement on each instrument, whichever way it ends.
    /// <para>
    /// The caller's serialization is deliberately outside the measured window and the publish
    /// gate's wait is deliberately inside it: the wait is latency the caller genuinely experiences,
    /// and both primitives serialise every send behind one channel.
    /// </para>
    /// </summary>
    internal static async Task MeasureAsync(
        string route, string destination, string type, Func<Task> send)
    {
        var started = Stopwatch.GetTimestamp();

        try
        {
            await send().ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Record(route, destination, type, Classify(ex), started);
            throw;
        }

        Record(route, destination, type, Classify(null), started);
    }

    private static void Record(
        string route, string destination, string type, string outcome, long started)
    {
        // TagList is a struct with inline storage for up to eight tags, so this allocates nothing
        // on a path that runs once per message.
        var tags = new TagList
        {
            { "route", route },
            { "destination", destination },
            { "type", type },
            { "outcome", outcome },
        };

        Produced.Add(1, tags);
        Duration.Record(Stopwatch.GetElapsedTime(started).TotalSeconds, tags);
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug -- --filter-method "*EgressMetrics*"
```

Expected: 8 passed, 0 failed.

- [ ] **Step 6: Run the full suite**

```bash
dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug
```

Expected: total 459, succeeded 452, skipped 7, failed 0.

- [ ] **Step 7: Commit**

```bash
git add src/Messaging.Transport/EgressMetrics.cs \
        src/tests/BaseApi.Tests/Support/MetricCollector.cs \
        src/tests/BaseApi.Tests/Transport/EgressMetricsTests.cs
git commit -m "feat: measure every message handed to the broker

Routing is classified before transport because the transport allow-list
already matches UnroutablePublishException and the whole RabbitMQ.Client
namespace -- the other order reports an undeclared queue as a broker blip,
and the two have opposite remedies.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Wrap both send primitives

No test of its own: `QueueSender.SendAsync` and `QueueFanoutPublisher.PublishAsync` both need a live broker, which is why `Messaging.Transport.csproj` already says only `BuildProperties` is unit-testable. Task 1 tested the measurement; this task is the one-line wrap that puts it on the path, and the full suite proves nothing else moved.

**Files:**
- Modify: `src/Messaging.Transport/QueueSender.cs` — the body of `SendAsync`
- Modify: `src/Messaging.Transport/QueueFanoutPublisher.cs` — the body of `PublishAsync`

**Interfaces:**
- Consumes: `EgressMetrics.MeasureAsync`, `EgressMetrics.RouteQueue`, `EgressMetrics.RouteFanout` from Task 1.
- Produces: nothing new. Both public signatures are unchanged.

- [ ] **Step 1: Wrap `QueueSender.SendAsync`**

In `src/Messaging.Transport/QueueSender.cs`, replace the body from `await _gate.WaitAsync(ct)` through the closing brace of the `finally`. The existing `try`/`catch`/`finally` moves inside the lambda unchanged — do not alter the discard, the log, or the rethrow.

```csharp
    public async Task SendAsync<T>(
        string queue, string type, T body, CancellationToken ct,
        string? replyTo = null, string? correlationId = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(queue);
        ArgumentException.ThrowIfNullOrWhiteSpace(type);

        var payload = JsonSerializer.SerializeToUtf8Bytes(body, MessagingJson.Options);

        var properties = BuildProperties(type, replyTo, correlationId);

        // The gate wait is inside the measured window: sends serialise behind one channel, so
        // queueing behind another send is latency this caller genuinely waited out.
        await EgressMetrics.MeasureAsync(EgressMetrics.RouteQueue, queue, type, async () =>
        {
            await _gate.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                var channel = await GetChannelAsync(ct).ConfigureAwait(false);

                // Empty exchange = the default exchange, which routes to the queue named by the
                // routing key. mandatory: true turns "no such queue" into a fault instead of a
                // silent discard.
                await channel.BasicPublishAsync(
                    exchange: string.Empty,
                    routingKey: queue,
                    mandatory: true,
                    basicProperties: properties,
                    body: payload,
                    cancellationToken: ct).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                // A channel that faulted is unusable for every later send, so drop it here rather
                // than letting the next caller discover it. Recreation happens on the next send,
                // under this same lock. The original exception is what the caller needs, so it
                // propagates untouched.
                await DiscardChannelAsync().ConfigureAwait(false);
                _logger.LogWarning(ex, "send to {Queue} failed; send channel discarded", queue);
                throw;
            }
            finally
            {
                _gate.Release();
            }
        }).ConfigureAwait(false);
    }
```

- [ ] **Step 2: Wrap `QueueFanoutPublisher.PublishAsync`**

In `src/Messaging.Transport/QueueFanoutPublisher.cs`, wrap the *inner* work only. The outer `catch` must keep seeing the raw exception, because that is where the `PublishException` → `UnroutablePublishException` remap and the `TransientSendException` wrap happen — and `EgressMetrics.Classify` is written against the raw shapes.

```csharp
    public async Task PublishAsync<T>(string exchange, string type, T body, CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(exchange);
        ArgumentException.ThrowIfNullOrWhiteSpace(type);

        var payload = JsonSerializer.SerializeToUtf8Bytes(body, MessagingJson.Options);

        var properties = QueueSender.BuildProperties(type, replyTo: null, correlationId: null);

        try
        {
            // Measured inside the outer try so the metric sees the RAW fault, before the remap to
            // UnroutablePublishException and the wrap into TransientSendException below.
            // EgressMetrics.Classify is written against those raw shapes.
            await EgressMetrics.MeasureAsync(EgressMetrics.RouteFanout, exchange, type, async () =>
            {
                // The gate wait is inside this classified region, not before it: a caller that
                // arrives already cancelled must still see TransientSendException, not a raw
                // OperationCanceledException, or DeliveryClassifier would park the control message
                // instead of requeuing it.
                await _gate.WaitAsync(ct).ConfigureAwait(false);
                try
                {
                    var channel = await GetChannelAsync(ct).ConfigureAwait(false);

                    // A named exchange instead of the default one, an empty routing key because a
                    // fan-out exchange ignores it, and mandatory: true so an unroutable message is
                    // reported rather than silently discarded and confirmed anyway.
                    await channel.BasicPublishAsync(
                        exchange: exchange,
                        routingKey: string.Empty,
                        mandatory: true,
                        basicProperties: properties,
                        body: payload,
                        cancellationToken: ct).ConfigureAwait(false);
                }
                finally
                {
                    _gate.Release();
                }
            }).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            // A channel that faulted is not trusted for the next publish, so it is dropped here
            // rather than reused. Recreation happens on the next publish, under this same lock.
            // Safe to call even when the fault happened before any channel was touched, e.g. a
            // cancelled gate wait.
            await DiscardChannelAsync().ConfigureAwait(false);
            _logger.LogWarning(ex, "publish to {Exchange} failed; publish channel discarded", exchange);

            // The client library's own correlation of a return to the publish that caused it.
            // Recognised by its type, not this task's own type, so it is remapped to the
            // exchange-naming diagnosis before the generic classification below runs.
            if (ex is PublishException { IsReturn: true })
            {
                ex = new UnroutablePublishException(exchange);
            }

            if (SendFaultClassifier.IsTransport(ex))
            {
                throw new TransientSendException($"publish to {exchange} failed", ex);
            }

            throw;
        }
    }
```

- [ ] **Step 3: Run the full suite**

```bash
dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug
```

Expected: total 459, succeeded 452, skipped 7, failed 0. Nothing should change — this task adds no test and must break none. `QueueSenderExtensionsTests` in particular substitutes `IQueueSender` and never reaches this code.

- [ ] **Step 4: Commit**

```bash
git add src/Messaging.Transport/QueueSender.cs src/Messaging.Transport/QueueFanoutPublisher.cs
git commit -m "feat: measure sends at the primitive, not at the transient wrapper

The entry-step dispatch calls SendAsync raw and swallows the failure, so
the one send whose faults are otherwise invisible is exactly the one the
wrapper would have missed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: The ingress meter and the disposition matrix

The heart of the change. Splitting `landed` out of `disposition` (spec §5.2) is what makes all five rows reachable without a broker: the intent is decided before any channel is touched, so a consumer built the way `ConsumerAdmissionTests` already builds one can drive every row.

**Files:**
- Create: `src/BaseConsole.Core/Messaging/IngressMetrics.cs`
- Modify: `src/BaseConsole.Core/Messaging/GatedQueueConsumer.cs`
- Test: `src/tests/BaseApi.Tests/Console/IngressMetricsTests.cs`

**Interfaces:**
- Consumes: `MetricCollector` from Task 1. `DeliveryClassifier.Classify`, `DeliveryDisposition`, `L2Gate`, `RabbitMqConnection`, `GatedConsumerOptions`, `IConsumerAdmission`, `IQueueMessageHandler` — all existing and public.
- Produces:
  - `internal static class IngressMetrics` in namespace `BaseConsole.Core.Messaging`
  - `internal const string IngressMetrics.MeterName = "BaseConsole.Core.Messaging"`
  - `internal static void IngressMetrics.RecordConsumed(string queue, string type, string disposition, string reason, bool landed, long? startedTimestamp)`
  - `internal Task GatedQueueConsumer.OnReceivedAsync(object sender, BasicDeliverEventArgs ea)` — visibility widened from `private`
- Later tasks add `TrackConsumer` / `UntrackConsumer` / `Inflight` / `ChannelResets` to `IngressMetrics`; Task 3 creates only what it uses.

- [ ] **Step 1: Write the failing tests**

Create `src/tests/BaseApi.Tests/Console/IngressMetricsTests.cs`:

```csharp
using BaseApi.Tests.Support;
using BaseConsole.Core.Gating;
using BaseConsole.Core.Messaging;
using Messaging.Transport;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using RabbitMQ.Client;
using RabbitMQ.Client.Events;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Console;

/// <summary>
/// Drives the §5.1 disposition matrix through a real <see cref="GatedQueueConsumer"/> with no
/// broker behind it.
/// <para>
/// That works because <c>disposition</c> and <c>reason</c> are decided before any channel is
/// touched, and <c>landed</c> — which is the only part that needs one — is asserted false
/// throughout. Splitting the two facts apart is what bought this coverage; while a lost
/// acknowledgement was a sixth disposition value, none of these rows were reachable hermetically.
/// </para>
/// </summary>
public sealed class IngressMetricsTests
{
    private const string Queue = "some-queue";
    private const string Type = "step-outcome";

    private sealed class Latch : IConsumerAdmission
    {
        public bool IsOpen { get; set; } = true;
    }

    /// <summary>
    /// A handler for <see cref="Type"/> that does whatever the test needs it to do. Hand-written
    /// rather than an NSubstitute mock so it can be registered by concrete type in a container —
    /// and because BaseConsole.Core grants internals to BaseApi.Tests but not to NSubstitute's
    /// proxy assembly.
    /// </summary>
    private sealed class Handler(Func<Task> body) : IQueueMessageHandler
    {
        public string MessageType => Type;
        public Task HandleAsync(ReadOnlyMemory<byte> body_, CancellationToken ct) => body();
    }

    private static BasicDeliverEventArgs Delivery(string type = Type) =>
        new("consumer-tag", deliveryTag: 1UL, redelivered: false,
            exchange: "", routingKey: Queue,
            properties: new BasicProperties { Type = type },
            body: ReadOnlyMemory<byte>.Empty);

    /// <summary>
    /// A consumer with no channel and no broker. Its constructor only assigns fields, and
    /// <see cref="RabbitMqConnection"/> opens no socket until asked — the same construction
    /// <see cref="ConsumerAdmissionTests"/> already relies on.
    /// </summary>
    private static GatedQueueConsumer BuildConsumer(L2Gate gate, params IQueueMessageHandler[] handlers)
    {
        var connection = new RabbitMqConnection(
            Options.Create(new RabbitMqOptions()),
            Array.Empty<IRabbitMqTopology>(),
            NullLogger<RabbitMqConnection>.Instance);

        var services = new ServiceCollection();
        foreach (var handler in handlers)
        {
            services.AddSingleton<IQueueMessageHandler>(handler);
        }

        var scopes = services.BuildServiceProvider().GetRequiredService<IServiceScopeFactory>();

        return new GatedQueueConsumer(
            connection,
            gate,
            scopes,
            Options.Create(new GatedConsumerOptions { Queue = Queue }),
            new Latch(),
            NullLogger<GatedQueueConsumer>.Instance);
    }

    /// <summary>An L2Gate driven to the state the test needs. It is constructed closed by design.</summary>
    private static async Task<L2Gate> GateAsync(bool open)
    {
        var gate = new L2Gate(NullLogger<L2Gate>.Instance);
        if (open)
        {
            await gate.ReportHealthyAsync();
        }

        return gate;
    }

    private static RecordedMeasurement TheOnlyConsumedMeasurement(MetricCollector metrics)
    {
        // Assert.Single is the exactly-once invariant in its cheapest form, and it is asserted on
        // every row rather than once: the failure it guards against is a second Record left behind
        // on one branch, which a per-branch value assertion would happily pass.
        return Assert.Single(metrics.For("pipeline.messages.consumed"));
    }

    [Fact]
    public async Task ADeliveryArrivingWhileTheGateIsShutIsRequeuedAsGateClosed()
    {
        // The gate can close between the broker handing a message over and it arriving, and
        // messages already in flight when the subscription was cancelled still arrive. This row is
        // the one that makes a pause read as a pause rather than as a burst of failures.
        using var metrics = new MetricCollector(IngressMetrics.MeterName);
        var consumer = BuildConsumer(await GateAsync(open: false));

        await consumer.OnReceivedAsync(this, Delivery());

        var m = TheOnlyConsumedMeasurement(metrics);
        Assert.Equal("requeued", m.Tags["disposition"]);
        Assert.Equal("gate_closed", m.Tags["reason"]);
        Assert.Equal(Queue, m.Tags["queue"]);
        Assert.Equal(Type, m.Tags["type"]);
    }

    [Fact]
    public async Task AHandlerThatReturnsIsAcked()
    {
        using var metrics = new MetricCollector(IngressMetrics.MeterName);
        var consumer = BuildConsumer(
            await GateAsync(open: true), new Handler(() => Task.CompletedTask));

        await consumer.OnReceivedAsync(this, Delivery());

        var m = TheOnlyConsumedMeasurement(metrics);
        Assert.Equal("acked", m.Tags["disposition"]);
        Assert.Equal("handled", m.Tags["reason"]);
    }

    [Fact]
    public async Task AStoreFaultRequeuesAsStoreUnreachable()
    {
        // DeliveryClassifier maps a Redis connection fault to RequeueAndTrip, which is the branch
        // that also closes the gate -- the pause is at the broker rather than a redelivery burned
        // per message for the length of the outage.
        using var metrics = new MetricCollector(IngressMetrics.MeterName);
        var consumer = BuildConsumer(
            await GateAsync(open: true),
            new Handler(() => throw new RedisConnectionException(
                ConnectionFailureType.UnableToConnect, "down")));

        await consumer.OnReceivedAsync(this, Delivery());

        var m = TheOnlyConsumedMeasurement(metrics);
        Assert.Equal("requeued", m.Tags["disposition"]);
        Assert.Equal("store_unreachable", m.Tags["reason"]);
    }

    [Fact]
    public async Task ATransientSendFaultRequeuesAsSendFailed()
    {
        using var metrics = new MetricCollector(IngressMetrics.MeterName);
        var consumer = BuildConsumer(
            await GateAsync(open: true),
            new Handler(() => throw new TransientSendException("broker blip")));

        await consumer.OnReceivedAsync(this, Delivery());

        var m = TheOnlyConsumedMeasurement(metrics);
        Assert.Equal("requeued", m.Tags["disposition"]);
        Assert.Equal("send_failed", m.Tags["reason"]);
    }

    [Fact]
    public async Task ADeterministicFaultIsParkedAsRefused()
    {
        using var metrics = new MetricCollector(IngressMetrics.MeterName);
        var consumer = BuildConsumer(
            await GateAsync(open: true),
            new Handler(() => throw new InvalidOperationException("will fail identically forever")));

        await consumer.OnReceivedAsync(this, Delivery());

        var m = TheOnlyConsumedMeasurement(metrics);
        Assert.Equal("parked", m.Tags["disposition"]);
        Assert.Equal("refused", m.Tags["reason"]);
    }

    [Fact]
    public async Task AMessageWithNoRegisteredHandlerIsParkedAsRefused()
    {
        // No redeploy of this process grows a handler for an unknown type, so retrying cannot help.
        using var metrics = new MetricCollector(IngressMetrics.MeterName);
        var consumer = BuildConsumer(await GateAsync(open: true));

        await consumer.OnReceivedAsync(this, Delivery(type: "no-such-type"));

        var m = TheOnlyConsumedMeasurement(metrics);
        Assert.Equal("parked", m.Tags["disposition"]);
        Assert.Equal("refused", m.Tags["reason"]);
        Assert.Equal("no-such-type", m.Tags["type"]);
    }

    [Fact]
    public async Task AMessageWithNoTypeHeaderIsParkedAndStillNamesItsQueue()
    {
        // Above the type boundary there is no type to report, but the queue is still known -- and
        // a measurement with an empty type attribute is what tells an operator the header is
        // missing rather than the handler.
        using var metrics = new MetricCollector(IngressMetrics.MeterName);
        var consumer = BuildConsumer(await GateAsync(open: true));

        await consumer.OnReceivedAsync(this, Delivery(type: ""));

        var m = TheOnlyConsumedMeasurement(metrics);
        Assert.Equal("parked", m.Tags["disposition"]);
        Assert.Equal("refused", m.Tags["reason"]);
        Assert.Equal(Queue, m.Tags["queue"]);
    }

    [Fact]
    public async Task EveryRowReportsLandedFalseWhenThereIsNoChannel()
    {
        // The other half of the split. With no channel the acknowledgement cannot be issued, so
        // the broker will redeliver -- which is exactly the silent retry amplification `landed`
        // exists to expose. A row that reported landed=true here would be lying.
        using var metrics = new MetricCollector(IngressMetrics.MeterName);
        var consumer = BuildConsumer(
            await GateAsync(open: true), new Handler(() => Task.CompletedTask));

        await consumer.OnReceivedAsync(this, Delivery());

        Assert.Equal("false", TheOnlyConsumedMeasurement(metrics).Tags["landed"]);
    }

    [Fact]
    public async Task TheHandlerDurationIsRecordedOnlyWhenAHandlerRan()
    {
        // A gate_closed reject never enters a handler, so recording a duration for it would drag
        // the histogram toward zero and make a paused consumer look fast.
        using var closed = new MetricCollector(IngressMetrics.MeterName);
        await BuildConsumer(await GateAsync(open: false)).OnReceivedAsync(this, Delivery());
        Assert.Empty(closed.For("pipeline.process.duration"));

        using var ran = new MetricCollector(IngressMetrics.MeterName);
        await BuildConsumer(await GateAsync(open: true), new Handler(() => Task.CompletedTask))
            .OnReceivedAsync(this, Delivery());

        var duration = Assert.Single(ran.For("pipeline.process.duration"));
        Assert.Equal("acked", duration.Tags["disposition"]);
        Assert.True(duration.Value >= 0);
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug -- --filter-method "*IngressMetrics*"
```

Expected: build failure — `IngressMetrics` does not exist and `OnReceivedAsync` is private.

- [ ] **Step 3: Write `IngressMetrics`**

Create `src/BaseConsole.Core/Messaging/IngressMetrics.cs`:

```csharp
using System.Diagnostics;
using System.Diagnostics.Metrics;

namespace BaseConsole.Core.Messaging;

/// <summary>
/// Pipeline metrics for the ingress half: one measurement per delivery, whatever the consumer
/// decided to do with it.
/// <para>
/// <b>Intent and landing are separate attributes.</b> <c>disposition</c> and <c>reason</c> say what
/// the consumer decided; <c>landed</c> says whether the broker was ever told. Collapsing them would
/// make a gate pause during a broker blip report as a channel fault, because only one of the two
/// facts could win the slot.
/// </para>
/// </summary>
internal static class IngressMetrics
{
    /// <summary>
    /// Must match the string passed to <c>AddMeter</c> in <c>AddBaseConsoleObservability</c>. A
    /// constant rather than a literal in two places, because a typo produces no error and no
    /// metrics.
    /// </summary>
    internal const string MeterName = "BaseConsole.Core.Messaging";

    private static readonly Meter Meter = new(MeterName);

    private static readonly Counter<long> Consumed = Meter.CreateCounter<long>(
        "pipeline.messages.consumed",
        unit: "{message}",
        description: "Deliveries handled, by queue, type, what was decided, and whether the broker was told.");

    private static readonly Histogram<double> ProcessDuration = Meter.CreateHistogram<double>(
        "pipeline.process.duration",
        unit: "s",
        description: "Time spent inside the message handler. Recorded only when a handler ran.");

    /// <summary>
    /// One delivery, one measurement.
    /// <para>
    /// <paramref name="startedTimestamp"/> is null when no handler ran — a delivery rejected
    /// because the gate was shut never entered one, and recording a near-zero duration for it would
    /// make a paused consumer look fast.
    /// </para>
    /// </summary>
    internal static void RecordConsumed(
        string queue, string type, string disposition, string reason, bool landed,
        long? startedTimestamp)
    {
        var tags = new TagList
        {
            { "queue", queue },
            { "type", type },
            { "disposition", disposition },
            { "reason", reason },
            // Lower-case literals rather than a bool: an exporter is free to render a boolean tag
            // as "True", and a dashboard written against "true" would then match nothing.
            { "landed", landed ? "true" : "false" },
        };

        Consumed.Add(1, tags);

        if (startedTimestamp is { } started)
        {
            ProcessDuration.Record(
                Stopwatch.GetElapsedTime(started).TotalSeconds,
                new TagList
                {
                    { "queue", queue },
                    { "type", type },
                    { "disposition", disposition },
                });
        }
    }
}
```

- [ ] **Step 4: Change `SafeAckAsync` and `SafeNackAsync` to report whether they landed**

In `src/BaseConsole.Core/Messaging/GatedQueueConsumer.cs`, change both methods' return types and add a return on every path. Nothing else in them moves.

```csharp
    /// <summary>
    /// Acknowledges a delivery. Returns whether the broker was actually told — false means the
    /// delivery tag was void or the channel had gone, so the broker will redeliver a message whose
    /// handler already ran.
    /// </summary>
    private async Task<bool> SafeAckAsync(BasicDeliverEventArgs ea, long epoch)
    {
        if (!TagStillValid(epoch) || _channel is null)
        {
            return false;
        }

        try
        {
            await _channel.BasicAckAsync(ea.DeliveryTag, multiple: false).ConfigureAwait(false);
            return true;
        }
        catch (Exception ex) when (ex is AlreadyClosedException
                                      or OperationInterruptedException
                                      or ObjectDisposedException)
        {
            // The channel went away between the check and the call. The delivery is unacknowledged,
            // so the broker requeues it — which against an idempotent handler is a repeat, not a loss.
            _logger.LogDebug(ex, "acknowledgement dropped — channel gone");
            return false;
        }
    }

    /// <summary>
    /// Rejects a delivery. Returns whether the broker was actually told; see
    /// <see cref="SafeAckAsync"/>.
    /// </summary>
    private async Task<bool> SafeNackAsync(BasicDeliverEventArgs ea, bool requeue, long epoch)
    {
        if (!TagStillValid(epoch) || _channel is null)
        {
            // A tag from a previous epoch is meaningless now, and rejecting it would be a
            // channel-level error that closes the channel permanently. Everything unacknowledged has
            // already been requeued by the broker.
            return false;
        }

        try
        {
            await _channel.BasicNackAsync(ea.DeliveryTag, multiple: false, requeue: requeue)
                .ConfigureAwait(false);
            return true;
        }
        catch (Exception ex) when (ex is AlreadyClosedException
                                      or OperationInterruptedException
                                      or ObjectDisposedException)
        {
            _logger.LogDebug(ex, "rejection dropped — channel gone");
            return false;
        }
    }
```

- [ ] **Step 5: Record one measurement per exit path of `OnReceivedAsync`**

Replace `OnReceivedAsync` in the same file. It becomes `internal` (the precedent is the existing `internal bool ShouldConsume` on this class), and every `await SafeAckAsync`/`SafeNackAsync` result feeds the `landed` attribute.

```csharp
    /// <summary>
    /// One delivery, start to finish. <c>internal</c> rather than <c>private</c> so the disposition
    /// matrix can be driven without a broker — the same reason <see cref="ShouldConsume"/> is.
    /// <para>
    /// <b>Exactly one <c>RecordConsumed</c> per exit path, and they all live here.</b> Recording
    /// inside <see cref="SafeAckAsync"/> and <see cref="SafeNackAsync"/> instead would put the
    /// increment in two places, and "exactly once per delivery" would become a rule to remember
    /// rather than something you can see by reading one method.
    /// </para>
    /// </summary>
    internal async Task OnReceivedAsync(object sender, BasicDeliverEventArgs ea)
    {
        var epoch = Interlocked.Read(ref _epoch);
        var type = ea.BasicProperties.Type ?? "";

        // The gate can close between the broker handing this message over and it arriving here, and
        // messages already in flight when the subscription was cancelled still arrive. Re-checking
        // here is what makes a pause clean rather than a burst of failures.
        if (!_gate.IsOpen)
        {
            var landed = await SafeNackAsync(ea, requeue: true, epoch).ConfigureAwait(false);

            // No handler ran, so no duration: a near-zero sample here would make a paused consumer
            // look fast.
            IngressMetrics.RecordConsumed(
                _options.Queue, type, "requeued", "gate_closed", landed, startedTimestamp: null);
            return;
        }

        // Copy out of the transport buffer, which is pooled and valid only for this callback.
        var body = ea.Body.ToArray();

        // Debug, and it stays Debug however useful it looks. This runs ABOVE the deserialization
        // boundary, so the ids that make a record joinable — correlation, workflow, step — are still
        // bytes here and cannot be put on it. A per-delivery Information record that carries only a
        // queue name would double the log volume of every run while answering none of the questions
        // the ids answer. The handlers log their own entry one layer down, inside the scope where
        // those ids exist, and that is the record worth shipping.
        _logger.LogDebug("received a {Type} delivery on {Queue}", type, _options.Queue);

        var started = Stopwatch.GetTimestamp();

        try
        {
            if (string.IsNullOrWhiteSpace(type))
            {
                throw new InvalidOperationException("message carries no type header");
            }

            await using var scope = _scopes.CreateAsyncScope();
            var handler = scope.ServiceProvider
                .GetServices<IQueueMessageHandler>()
                .SingleOrDefault(h => h.MessageType == type);

            if (handler is null)
            {
                // Unknown type. Retrying cannot help — no redeploy of this process grows a handler
                // for it — so park it, where it survives for inspection.
                throw new InvalidOperationException("no handler is registered for this message type");
            }

            // Deliberately not the delivery's own token: cancelling mid-handler would abandon a
            // partially applied write with the message already claimed. Shutdown lets in-flight work
            // finish and leaves unacknowledged deliveries to be redelivered.
            await handler.HandleAsync(body, CancellationToken.None).ConfigureAwait(false);

            var landed = await SafeAckAsync(ea, epoch).ConfigureAwait(false);
            IngressMetrics.RecordConsumed(
                _options.Queue, type, "acked", "handled", landed, started);
        }
        catch (Exception ex)
        {
            switch (DeliveryClassifier.Classify(ex))
            {
                case DeliveryDisposition.RequeueAndTrip:
                {
                    _logger.LogWarning(
                        ex, "projection store unreachable — returning message to {Queue}", _options.Queue);

                    // Awaited rather than fired and forgotten: closing the gate before the message goes
                    // back means the redelivery finds it already closed instead of racing it. That is
                    // only safe because gate subscribers signal rather than perform I/O — a subscriber
                    // that did broker work inside the notification would deadlock here.
                    await _gate.TripAsync().ConfigureAwait(false);
                    var landed = await SafeNackAsync(ea, requeue: true, epoch).ConfigureAwait(false);
                    IngressMetrics.RecordConsumed(
                        _options.Queue, type, "requeued", "store_unreachable", landed, started);
                    break;
                }

                case DeliveryDisposition.Requeue:
                {
                    // The projection store said nothing about itself, so the gate stays open and this
                    // consumer keeps working. Only this delivery goes back.
                    _logger.LogWarning(
                        ex, "send failed while handling {Type} — returning message to {Queue}",
                        type, _options.Queue);
                    var landed = await SafeNackAsync(ea, requeue: true, epoch).ConfigureAwait(false);
                    IngressMetrics.RecordConsumed(
                        _options.Queue, type, "requeued", "send_failed", landed, started);
                    break;
                }

                default:
                {
                    // Taken as a property of the message rather than of the environment. A parked
                    // message can be recovered by hand; a message requeued forever is an outage that
                    // never resolves, so the ambiguous case is deliberately resolved toward parking.
                    _logger.LogError(ex, "refusing message of type {Type} — parking", type);
                    var landed = await SafeNackAsync(ea, requeue: false, epoch).ConfigureAwait(false);
                    IngressMetrics.RecordConsumed(
                        _options.Queue, type, "parked", "refused", landed, started);
                    break;
                }
            }
        }
    }
```

Add `using System.Diagnostics;` to the file's using block for `Stopwatch`.

Note the two deliberate changes beyond adding metrics, both forced by the above:
- `type` is now read once at the top and defaulted to `""`, because the `gate_closed` path needs it and because a null type would otherwise reach a tag value. The subsequent `IsNullOrWhiteSpace` check is unchanged in meaning.
- `case` arms gained braces, because each now declares a `landed` local and C# scopes switch-section locals to the whole switch.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug -- --filter-method "*IngressMetrics*"
```

Expected: 10 passed, 0 failed.

- [ ] **Step 7: Run the full suite**

```bash
dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug
```

Expected: total 469, succeeded 462, skipped 7, failed 0.

- [ ] **Step 8: Commit**

```bash
git add src/BaseConsole.Core/Messaging/IngressMetrics.cs \
        src/BaseConsole.Core/Messaging/GatedQueueConsumer.cs \
        src/tests/BaseApi.Tests/Console/IngressMetricsTests.cs
git commit -m "feat: record what the consumer decided and whether the broker was told

SafeAck and SafeNack now report whether the acknowledgement landed, so
one Record call per exit path of OnReceivedAsync covers both facts and
exactly-once is visible by reading a single method.

Keeping landing out of the disposition is also what makes the whole
matrix reachable without a broker: intent is decided before any channel
is touched.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Consumer state — inflight, the consuming gauge, channel resets

**Files:**
- Modify: `src/BaseConsole.Core/Messaging/IngressMetrics.cs`
- Modify: `src/BaseConsole.Core/Messaging/GatedQueueConsumer.cs`
- Test: `src/tests/BaseApi.Tests/Console/IngressMetricsTests.cs` (append)

**Interfaces:**
- Consumes: everything from Task 3.
- Produces:
  - `internal static void IngressMetrics.TrackConsumer(string queue, Func<bool> isConsuming)`
  - `internal static void IngressMetrics.UntrackConsumer(string queue)`
  - `internal static void IngressMetrics.AddInflight(string queue, int delta)`
  - `internal static void IngressMetrics.RecordChannelReset(string queue, string reason)`

- [ ] **Step 1: Write the failing tests**

Append to `src/tests/BaseApi.Tests/Console/IngressMetricsTests.cs`, inside the same class:

```csharp
    [Fact]
    public async Task TheConsumingGaugeReportsOneSeriesPerQueueFromASingleInstrument()
    {
        // ONE instrument, N measurements -- not N instruments. Creating this gauge once per
        // consumer would put three instruments with one name on one meter, which the OpenTelemetry
        // SDK resolves to a single stream and warns about or drops. An observable callback may
        // return many measurements, so a registry keyed by queue is the shape that works.
        IngressMetrics.TrackConsumer("queue-a", () => true);
        IngressMetrics.TrackConsumer("queue-b", () => false);

        try
        {
            using var metrics = new MetricCollector(IngressMetrics.MeterName);
            metrics.Collect();

            var byQueue = metrics.For("pipeline.consumer.consuming")
                .ToDictionary(m => m.Tags["queue"], m => m.Value);

            Assert.Equal(1, byQueue["queue-a"]);
            Assert.Equal(0, byQueue["queue-b"]);
        }
        finally
        {
            IngressMetrics.UntrackConsumer("queue-a");
            IngressMetrics.UntrackConsumer("queue-b");
        }
    }

    [Fact]
    public void AnUntrackedConsumerStopsBeingReported()
    {
        // A consumer that stopped must not keep reporting the last value it held -- a stale 1 here
        // reads as "something is listening" for a queue nothing is reading.
        IngressMetrics.TrackConsumer("queue-gone", () => true);
        IngressMetrics.UntrackConsumer("queue-gone");

        using var metrics = new MetricCollector(IngressMetrics.MeterName);
        metrics.Collect();

        Assert.DoesNotContain(
            metrics.For("pipeline.consumer.consuming"), m => m.Tags["queue"] == "queue-gone");
    }

    [Fact]
    public async Task InflightRisesForTheHandlerAndFallsBackToZero()
    {
        // Read against PrefetchCount this is saturation. The decrement is in a finally, so the
        // assertion that matters is the one after a handler that THREW.
        using var metrics = new MetricCollector(IngressMetrics.MeterName);

        var consumer = BuildConsumer(
            await GateAsync(open: true),
            new Handler(() => throw new InvalidOperationException("boom")));

        await consumer.OnReceivedAsync(this, Delivery());

        var deltas = metrics.For("pipeline.consumer.inflight").Select(m => m.Value).ToArray();
        Assert.Equal(new double[] { 1, -1 }, deltas);
        Assert.Equal(0, deltas.Sum());
    }

    [Fact]
    public void AChannelResetIsCountedWithItsCause()
    {
        using var metrics = new MetricCollector(IngressMetrics.MeterName);

        IngressMetrics.RecordChannelReset(Queue, "shutdown");

        var m = Assert.Single(metrics.For("pipeline.consumer.channel.resets"));
        Assert.Equal(1, m.Value);
        Assert.Equal("shutdown", m.Tags["reason"]);
        Assert.Equal(Queue, m.Tags["queue"]);
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug -- --filter-method "*IngressMetrics*"
```

Expected: build failure — `TrackConsumer`, `UntrackConsumer`, `RecordChannelReset` do not exist.

- [ ] **Step 3: Add the three instruments to `IngressMetrics`**

Add to `src/BaseConsole.Core/Messaging/IngressMetrics.cs`. The `using System.Collections.Concurrent;` directive is new.

```csharp
    private static readonly UpDownCounter<long> Inflight = Meter.CreateUpDownCounter<long>(
        "pipeline.consumer.inflight",
        unit: "{message}",
        description: "Deliveries currently inside a handler. Read against PrefetchCount for saturation.");

    private static readonly Counter<long> ChannelResets = Meter.CreateCounter<long>(
        "pipeline.consumer.channel.resets",
        unit: "1",
        description: "Times the delivery numbering was invalidated, by cause. The reason landed=false happens.");

    /// <summary>
    /// Every live consumer's subscription state, keyed by the queue it reads.
    /// <para>
    /// <b>This registry exists so there is ONE observable instrument rather than one per
    /// consumer.</b> An orchestrator holds three <see cref="GatedQueueConsumer"/> singletons, and
    /// three instruments sharing a name on one meter resolve to a single metric stream in the
    /// OpenTelemetry SDK — which warns about the duplicates and may drop them. An observable
    /// callback is allowed to return many measurements, so one gauge over a registry is the shape
    /// that reports all three.
    /// </para>
    /// </summary>
    private static readonly ConcurrentDictionary<string, Func<bool>> Consumers = new(StringComparer.Ordinal);

    static IngressMetrics()
    {
        // Registered once, in the static constructor, because an observable created more than once
        // is the duplicate-stream hazard the registry above exists to avoid. The returned instrument
        // is intentionally not stored: the Meter owns it and the callback keeps it alive.
        Meter.CreateObservableGauge(
            "pipeline.consumer.consuming",
            ObserveConsuming,
            unit: "1",
            description: "1 while a consumer holds its subscription, 0 while it is paused.");
    }

    /// <summary>
    /// Report this queue's subscription state until <see cref="UntrackConsumer"/> is called.
    /// Re-registering the same queue replaces the previous delegate rather than adding a second.
    /// </summary>
    internal static void TrackConsumer(string queue, Func<bool> isConsuming) =>
        Consumers[queue] = isConsuming;

    /// <summary>
    /// Stop reporting a queue. Without this a stopped consumer's last value would persist, and a
    /// stale 1 reads as "something is listening" for a queue nothing is reading.
    /// </summary>
    internal static void UntrackConsumer(string queue) => Consumers.TryRemove(queue, out _);

    private static IEnumerable<Measurement<int>> ObserveConsuming() =>
        Consumers.Select(entry => new Measurement<int>(
            entry.Value() ? 1 : 0,
            new KeyValuePair<string, object?>("queue", entry.Key)));

    /// <summary>Move the in-flight count for one queue. Always paired: +1 on entry, -1 in a finally.</summary>
    internal static void AddInflight(string queue, int delta) =>
        Inflight.Add(delta, new KeyValuePair<string, object?>("queue", queue));

    /// <summary>
    /// Count one invalidation of the delivery numbering. <paramref name="reason"/> is
    /// <c>shutdown</c>, <c>recovered</c> or <c>reopened</c>.
    /// </summary>
    internal static void RecordChannelReset(string queue, string reason) =>
        ChannelResets.Add(1, new TagList { { "queue", queue }, { "reason", reason } });
```

- [ ] **Step 4: Wire the consumer to them**

Four edits to `src/BaseConsole.Core/Messaging/GatedQueueConsumer.cs`.

First, register at the end of the constructor:

```csharp
        _logger     = logger ?? throw new ArgumentNullException(nameof(logger));

        // In the constructor rather than in ExecuteAsync: the gauge must report 0 for a consumer
        // that exists but has not started or cannot start, which is precisely the state worth
        // seeing. Registering on start would leave that consumer absent from the gauge entirely,
        // and absent reads the same as "no such queue".
        IngressMetrics.TrackConsumer(_options.Queue, () => IsConsuming);
```

Second, bracket the handler call in `OnReceivedAsync`. Replace the `var started = Stopwatch.GetTimestamp();` line and wrap the whole `try`/`catch` block that follows it:

```csharp
        var started = Stopwatch.GetTimestamp();
        IngressMetrics.AddInflight(_options.Queue, 1);

        try
        {
            // ... the existing try/catch from Task 3, unchanged ...
        }
        finally
        {
            IngressMetrics.AddInflight(_options.Queue, -1);
        }
```

Concretely: wrap the existing `try { ... } catch (Exception ex) { switch ... }` in an outer `try { ... } finally { IngressMetrics.AddInflight(_options.Queue, -1); }`. The `gate_closed` early return sits above this and is deliberately outside it — that delivery never enters a handler.

Third, count the three resets. In `OnChannelShutdownAsync`, after `Interlocked.Increment(ref _epoch);`:

```csharp
        IngressMetrics.RecordChannelReset(_options.Queue, "shutdown");
```

In `OnRecoveredAsync`, after its `Interlocked.Increment(ref _epoch);`:

```csharp
        IngressMetrics.RecordChannelReset(_options.Queue, "recovered");
```

In `OpenChannelAsync`, after its `Interlocked.Increment(ref _epoch);`:

```csharp
        IngressMetrics.RecordChannelReset(_options.Queue, "reopened");
```

Fourth, unregister in `StopAsync`, immediately after the `base.StopAsync` call:

```csharp
        await base.StopAsync(cancellationToken).ConfigureAwait(false);

        // Before the channel is discarded, so nothing can observe a consumer that is mid-teardown.
        IngressMetrics.UntrackConsumer(_options.Queue);

        await DiscardChannelAsync().ConfigureAwait(false);
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug -- --filter-method "*IngressMetrics*"
```

Expected: 14 passed, 0 failed.

If `TheConsumingGaugeReportsOneSeriesPerQueue...` sees extra queues, another test in the same run left a consumer tracked. The registry is static and process-wide; find the leak rather than filtering it out in the assertion — a real consumer that never unregisters is the same bug.

- [ ] **Step 6: Run the full suite**

```bash
dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug
```

Expected: total 473, succeeded 466, skipped 7, failed 0.

- [ ] **Step 7: Commit**

```bash
git add src/BaseConsole.Core/Messaging/IngressMetrics.cs \
        src/BaseConsole.Core/Messaging/GatedQueueConsumer.cs \
        src/tests/BaseApi.Tests/Console/IngressMetricsTests.cs
git commit -m "feat: report whether each queue is being read, and what churns its channel

One gauge over a registry rather than one gauge per consumer: three
instruments sharing a name on one meter collapse to a single stream in
the SDK, and an observable may return many measurements anyway.

Channel resets are the cause of landed=false, so they are counted with
the cause that produced them.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: The gate gauge, without touching `L2Gate`

`BaseConsole.Core.Gating.L2Gate`'s own remarks bind it to stay identical to `BaseApi.Core.Gating.L2Gate`, and the API side is out of scope. So the instruments go in a separate owner.

**Files:**
- Create: `src/BaseConsole.Core/Gating/L2GateMetrics.cs`
- Modify: `src/BaseConsole.Core/DependencyInjection/ConsoleRedisServiceCollectionExtensions.cs`
- Test: `src/tests/BaseApi.Tests/Console/L2GateMetricsTests.cs`

**Interfaces:**
- Consumes: `L2Gate` (`IsOpen`, `StateChanged`, `TripAsync`, `ReportHealthyAsync`) — existing and public.
- Produces:
  - `internal sealed class L2GateMetrics : IHostedService, IDisposable` in namespace `BaseConsole.Core.Gating`
  - `internal const string L2GateMetrics.MeterName = "BaseConsole.Core.Gating"`
  - constructor `L2GateMetrics(L2Gate gate)`

- [ ] **Step 1: Write the failing tests**

Create `src/tests/BaseApi.Tests/Console/L2GateMetricsTests.cs`:

```csharp
using BaseApi.Tests.Support;
using BaseConsole.Core.Gating;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace BaseApi.Tests.Console;

public sealed class L2GateMetricsTests
{
    [Fact]
    public async Task TheGaugeFollowsTheGate()
    {
        // L2Gate is constructed closed by design -- notification fires on transitions only, so a
        // gate that started open would never produce an opening edge.
        var gate = new L2Gate(NullLogger<L2Gate>.Instance);
        using var owner = new L2GateMetrics(gate);
        using var metrics = new MetricCollector(L2GateMetrics.MeterName);

        metrics.Collect();
        Assert.Equal(0, Assert.Single(metrics.For("pipeline.gate.open")).Value);

        await gate.ReportHealthyAsync();

        metrics.Collect();
        Assert.Equal(1, metrics.For("pipeline.gate.open")[^1].Value);
    }

    [Fact]
    public async Task OnlyTheFallingEdgeIsCountedAsATrip()
    {
        var gate = new L2Gate(NullLogger<L2Gate>.Instance);
        using var owner = new L2GateMetrics(gate);
        using var metrics = new MetricCollector(L2GateMetrics.MeterName);

        // Open, then closed, then open again: one trip, not two edges and not three.
        await gate.ReportHealthyAsync();
        await gate.TripAsync();
        await gate.ReportHealthyAsync();

        Assert.Equal(1, metrics.For("pipeline.gate.trips").Sum(m => m.Value));
    }

    [Fact]
    public async Task DisposingUnsubscribesSoAStoppedOwnerCountsNothing()
    {
        var gate = new L2Gate(NullLogger<L2Gate>.Instance);
        var owner = new L2GateMetrics(gate);
        await gate.ReportHealthyAsync();

        owner.Dispose();

        using var metrics = new MetricCollector(L2GateMetrics.MeterName);
        await gate.TripAsync();

        Assert.Empty(metrics.For("pipeline.gate.trips"));
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug -- --filter-method "*L2GateMetrics*"
```

Expected: build failure — `L2GateMetrics` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/BaseConsole.Core/Gating/L2GateMetrics.cs`:

```csharp
using System.Diagnostics.Metrics;
using Microsoft.Extensions.Hosting;

namespace BaseConsole.Core.Gating;

/// <summary>
/// Publishes the projection-store gate as metrics, without <see cref="L2Gate"/> knowing about it.
/// <para>
/// <b>A separate owner rather than instrumentation inside the gate, and that is a constraint.</b>
/// <see cref="L2Gate"/> is a deliberate copy of <c>BaseApi.Core.Gating.L2Gate</c>, and its own
/// remarks say behaviour must not diverge between the two. Instrumenting the console copy while
/// the API copy is out of scope would be exactly that divergence, so both stay untouched.
/// </para>
/// <para>
/// <b>It is an <see cref="IHostedService"/> only so the container constructs it.</b> A DI singleton
/// is never built until something resolves it, and an observable gauge that is never created
/// reports nothing — with no error anywhere to say so. Start and Stop do no work.
/// </para>
/// <para>
/// The subscription honours the gate's standing rule that handlers must not perform I/O and must
/// not re-enter it: incrementing a counter is a flag flip. The gauge does not use the event at all,
/// reading <see cref="L2Gate.IsOpen"/> when it is polled.
/// </para>
/// </summary>
internal sealed class L2GateMetrics : IHostedService, IDisposable
{
    /// <summary>
    /// Must match the string passed to <c>AddMeter</c> in <c>AddBaseConsoleObservability</c>. A
    /// constant rather than a literal in two places, because a typo produces no error and no
    /// metrics.
    /// </summary>
    internal const string MeterName = "BaseConsole.Core.Gating";

    private static readonly Meter Meter = new(MeterName);

    private static readonly Counter<long> Trips = Meter.CreateCounter<long>(
        "pipeline.gate.trips",
        unit: "1",
        description: "Times the projection store went away and consumption was paused at the broker.");

    private readonly L2Gate _gate;

    public L2GateMetrics(L2Gate gate)
    {
        _gate = gate ?? throw new ArgumentNullException(nameof(gate));

        // Exactly one L2Gate exists per process, so creating the observable here rather than in a
        // static constructor cannot produce the duplicate-stream problem that forced the consumer
        // gauge behind a registry.
        Meter.CreateObservableGauge(
            "pipeline.gate.open",
            () => _gate.IsOpen ? 1 : 0,
            unit: "1",
            description: "1 while the projection store is usable and consumers may run, 0 while it is not.");

        _gate.StateChanged += OnStateChanged;
    }

    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    /// <summary>
    /// The falling edge only. The gate raises this on transitions in both directions, and counting
    /// both would make the number mean "changes" rather than "outages" — half of it would be the
    /// recoveries.
    /// </summary>
    private void OnStateChanged(bool open)
    {
        if (!open)
        {
            Trips.Add(1);
        }
    }

    public void Dispose() => _gate.StateChanged -= OnStateChanged;
}
```

- [ ] **Step 4: Register it**

In `src/BaseConsole.Core/DependencyInjection/ConsoleRedisServiceCollectionExtensions.cs`, immediately after the existing `services.TryAddSingleton<L2Gate>();` line:

```csharp
        services.TryAddSingleton<L2Gate>();

        // Hosted purely so the container constructs it: it owns an observable gauge, and an
        // observable nothing resolved is an instrument that never publishes, silently.
        services.AddHostedService<L2GateMetrics>();
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug -- --filter-method "*L2GateMetrics*"
```

Expected: 3 passed, 0 failed.

- [ ] **Step 6: Run the full suite**

```bash
dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug
```

Expected: total 476, succeeded 469, skipped 7, failed 0.

`ConsoleGatingWiringTests` and `OrchestratorHostWiringTests` both count hosted services or registrations. If either fails, it is asserting an exact count that this task's new registration changed — update the expected number and say so in the commit; do not remove the registration.

- [ ] **Step 7: Commit**

```bash
git add src/BaseConsole.Core/Gating/L2GateMetrics.cs \
        src/BaseConsole.Core/DependencyInjection/ConsoleRedisServiceCollectionExtensions.cs \
        src/tests/BaseApi.Tests/Console/L2GateMetricsTests.cs
git commit -m "feat: publish the projection-store gate without touching L2Gate

The gate is a deliberate copy of the API-side one and its remarks bind
the two to stay identical, so the instruments live in a separate owner
and both copies stay byte-for-byte the same.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Register the three shared meters

Until this lands, every instrument from Tasks 1–5 exists and publishes to nothing.

**Files:**
- Modify: `src/BaseConsole.Core/DependencyInjection/BaseConsoleObservabilityExtensions.cs`
- Test: `src/tests/BaseApi.Tests/Console/ConsoleObservabilityTests.cs` (append)

**Interfaces:**
- Consumes: `EgressMetrics.MeterName`, `IngressMetrics.MeterName`, `L2GateMetrics.MeterName`.
- Produces: no signature change. `AddBaseConsoleObservability` keeps its parameters.

- [ ] **Step 1: Write the failing test**

Append to `src/tests/BaseApi.Tests/Console/ConsoleObservabilityTests.cs`, inside the existing class:

```csharp
    [Fact]
    public void TheThreePipelineMetersAreRegisteredOnTheMetricsProvider()
    {
        // The enforcement mechanism for the whole design: both hosts already call this method, so
        // a new worker cannot ship without the shared instruments. Asserting on the built provider
        // rather than on the call is what catches a meter added to the wrong builder -- the file's
        // own remarks explain that the resource must be set per-provider here, and the same trap
        // applies to AddMeter.
        var builder = BuilderWith(("Service:Name", "orchestrator"), ("Service:Version", "1.0.0"));
        builder.AddBaseConsoleObservability(builder.Configuration, source: "worker");

        using var host = builder.Build();
        using var collector = new MetricCollector(
            "Messaging.Transport", "BaseConsole.Core.Messaging", "BaseConsole.Core.Gating");

        var options = host.Services
            .GetRequiredService<IOptionsMonitor<MetricsOptions>>()
            .Get(Options.DefaultName);

        Assert.Contains("Messaging.Transport", options.Meters);
        Assert.Contains("BaseConsole.Core.Messaging", options.Meters);
        Assert.Contains("BaseConsole.Core.Gating", options.Meters);
    }
```

The exact way to read back the configured meter names depends on the OpenTelemetry 1.15.3 internals, and `MetricsOptions` above is a placeholder for whichever type actually holds them. Before writing the assertion, find the real one:

```bash
grep -rn "Meters" ~/.nuget/packages/opentelemetry/1.15.3/lib/net8.0/ 2>/dev/null | head
dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug -- --filter-method "*ThreePipelineMeters*"
```

If the configured names are not reachable from a built host — they are held in an internal SDK type in some versions — replace the assertion with the behavioural equivalent, which is stronger anyway: build the host, publish one measurement on each meter through the internal `Record` entry points, and assert a `MetricCollector` subscribed to those three meter names saw all three. Either form is acceptable; a test that asserts nothing is not.

- [ ] **Step 2: Run the test to verify it fails**

```bash
dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug -- --filter-method "*ThreePipelineMeters*"
```

Expected: FAIL — the meters are not registered.

- [ ] **Step 3: Add the three lines**

In `src/BaseConsole.Core/DependencyInjection/BaseConsoleObservabilityExtensions.cs`, inside the `.WithMetrics(m => m ...)` chain, immediately before `.AddRuntimeInstrumentation()`:

```csharp
                // The whole consistency mechanism in three lines: both the orchestrator host and
                // every processor host already call this method, so both roles emit the same
                // instruments and a new worker cannot ship without them. The names come from
                // constants rather than literals because a typo here produces no error and no
                // metrics.
                .AddMeter(EgressMetrics.MeterName)
                .AddMeter(IngressMetrics.MeterName)
                .AddMeter(L2GateMetrics.MeterName)
```

`EgressMetrics` is `internal` to `Messaging.Transport`, which `BaseConsole.Core` references as a project but is not granted internals access to. So this will not compile. Fix it by widening only the constant — the class stays internal:

In `src/Messaging.Transport/EgressMetrics.cs`, change the class declaration and the one constant:

```csharp
/// <summary>The egress meter's name, public so the console host can register it. See <see cref="EgressMetrics"/>.</summary>
public static class EgressMeter
{
    public const string Name = "Messaging.Transport";
}
```

and have `EgressMetrics.MeterName` reference it:

```csharp
    internal const string MeterName = EgressMeter.Name;
```

Then use `EgressMeter.Name` in the `AddMeter` call. `IngressMetrics` and `L2GateMetrics` are both in `BaseConsole.Core` and need no such change — use their `internal` constants directly.

Add the required `using BaseConsole.Core.Gating;`, `using BaseConsole.Core.Messaging;` and `using Messaging.Transport;` to the file.

- [ ] **Step 4: Run the test to verify it passes**

```bash
dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug -- --filter-method "*ThreePipelineMeters*"
```

Expected: PASS.

- [ ] **Step 5: Run the full suite**

```bash
dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug
```

Expected: total 477, succeeded 470, skipped 7, failed 0.

- [ ] **Step 6: Commit**

```bash
git add src/BaseConsole.Core/DependencyInjection/BaseConsoleObservabilityExtensions.cs \
        src/Messaging.Transport/EgressMetrics.cs \
        src/tests/BaseApi.Tests/Console/ConsoleObservabilityTests.cs
git commit -m "feat: register the shared pipeline meters where both hosts already look

Three lines in the method the orchestrator and every processor already
call, which is what makes drift between them structurally impossible
rather than a convention someone has to remember.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: The orchestrator's two gauges

**Files:**
- Create: `src/Orchestrator/Observability/OrchestratorPipelineMetrics.cs`
- Modify: `src/Orchestrator/OrchestratorHost.cs`
- Test: `src/tests/BaseApi.Tests/Orchestrator/OrchestratorPipelineMetricsTests.cs`
- Test: `src/tests/BaseApi.Tests/Orchestrator/OrchestratorHostWiringTests.cs` (append)

**Interfaces:**
- Consumes: `LeaderState` (`IsLeader`, `BecomeLeader`, `BecomeFollower`), `HydrationAdmission` (`IsOpen`, `Open`) — existing and public. `IngressMetrics` for the wiring assertion.
- Produces:
  - `internal sealed class OrchestratorPipelineMetrics : IHostedService` in namespace `Orchestrator.Observability`
  - `internal const string OrchestratorPipelineMetrics.MeterName = "Orchestrator"`
  - constructor `OrchestratorPipelineMetrics(LeaderState leader, HydrationAdmission hydration)`

- [ ] **Step 1: Write the failing tests**

Create `src/tests/BaseApi.Tests/Orchestrator/OrchestratorPipelineMetricsTests.cs`:

```csharp
using BaseApi.Tests.Support;
using Orchestrator.Election;
using Orchestrator.Hydration;
using Orchestrator.Observability;
using Xunit;

namespace BaseApi.Tests.Orchestrator;

public sealed class OrchestratorPipelineMetricsTests
{
    [Fact]
    public void LeadershipIsReportedInBothDirections()
    {
        // Both directions, not just acquisition: the self-demotion fence is the half that matters,
        // and a gauge that only ever went up would show two leaders on one workflow as one.
        var leader = new LeaderState();
        var hydration = new HydrationAdmission();
        using var owner = new OrchestratorPipelineMetrics(leader, hydration);
        using var metrics = new MetricCollector(OrchestratorPipelineMetrics.MeterName);

        metrics.Collect();
        Assert.Equal(0, metrics.For("pipeline.leader")[^1].Value);

        leader.BecomeLeader();
        metrics.Collect();
        Assert.Equal(1, metrics.For("pipeline.leader")[^1].Value);

        leader.BecomeFollower();
        metrics.Collect();
        Assert.Equal(0, metrics.For("pipeline.leader")[^1].Value);
    }

    [Fact]
    public void HydrationAdmissionIsReportedAndIsOneShot()
    {
        // It distinguishes "not consuming because the store is down" from "not consuming because
        // the first hydration pass has not finished" -- two states that look identical otherwise.
        var leader = new LeaderState();
        var hydration = new HydrationAdmission();
        using var owner = new OrchestratorPipelineMetrics(leader, hydration);
        using var metrics = new MetricCollector(OrchestratorPipelineMetrics.MeterName);

        metrics.Collect();
        Assert.Equal(0, metrics.For("pipeline.hydration.admitted")[^1].Value);

        hydration.Open();
        metrics.Collect();
        Assert.Equal(1, metrics.For("pipeline.hydration.admitted")[^1].Value);
    }

    [Fact]
    public void ThePipelineLeaderGaugeIsIndependentOfConsumption()
    {
        // A follower still consumes: leadership fences cron fires only, because exactly one outcome
        // exists per step that ran. Asserting the two are separate instruments is what stops a
        // future reader wiring consumption to leadership on the strength of this gauge.
        var leader = new LeaderState();
        using var owner = new OrchestratorPipelineMetrics(leader, new HydrationAdmission());
        using var metrics = new MetricCollector(
            OrchestratorPipelineMetrics.MeterName, "BaseConsole.Core.Messaging");

        metrics.Collect();

        Assert.Empty(metrics.For("pipeline.leader")
            .Where(m => m.Tags.ContainsKey("queue")));
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug -- --filter-method "*OrchestratorPipelineMetrics*"
```

Expected: build failure — the type does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/Orchestrator/Observability/OrchestratorPipelineMetrics.cs`:

```csharp
using System.Diagnostics.Metrics;
using Microsoft.Extensions.Hosting;
using Orchestrator.Election;
using Orchestrator.Hydration;

namespace Orchestrator.Observability;

/// <summary>
/// The two flags that explain why an orchestrator replica is doing less than another one.
/// <para>
/// <b>Neither is a reason to stop consuming, and the leader gauge especially is not.</b>
/// Leadership fences cron fires, where two replicas firing one schedule double-dispatch. Exactly
/// one outcome exists per step that ran, so <c>StepOutcomeHandler</c> is deliberately NOT gated on
/// it — a replica reporting <c>pipeline.leader = 0</c> is expected to be consuming normally, and an
/// alert written the other way round would fire on every healthy follower.
/// </para>
/// <para>
/// <b>Hosted only so the container constructs it</b>, for the same reason as
/// <c>L2GateMetrics</c>: a DI singleton nothing resolves is an observable that never publishes.
/// Start and Stop do no work. There is exactly one of these per process, so the observables are
/// created here rather than behind a registry.
/// </para>
/// </summary>
internal sealed class OrchestratorPipelineMetrics : IHostedService, IDisposable
{
    /// <summary>
    /// Must match the string passed to <c>AddMeter</c> in <c>OrchestratorHost</c>. A constant
    /// rather than a literal in two places, because a typo produces no error and no metrics.
    /// </summary>
    internal const string MeterName = "Orchestrator";

    private static readonly Meter Meter = new(MeterName);

    public OrchestratorPipelineMetrics(LeaderState leader, HydrationAdmission hydration)
    {
        ArgumentNullException.ThrowIfNull(leader);
        ArgumentNullException.ThrowIfNull(hydration);

        Meter.CreateObservableGauge(
            "pipeline.leader",
            () => leader.IsLeader ? 1 : 0,
            unit: "1",
            description: "1 while this replica holds the lease and fires schedules. Followers still consume.");

        Meter.CreateObservableGauge(
            "pipeline.hydration.admitted",
            () => hydration.IsOpen ? 1 : 0,
            unit: "1",
            description: "1 once the first hydration pass finished and consumption was admitted. One-shot.");
    }

    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    // Nothing to release -- the observables hold their own delegates and the Meter is static and
    // process-lived. IDisposable is implemented so the shape matches L2GateMetrics and a future
    // subscription has an obvious place to be torn down.
    public void Dispose()
    {
    }
}
```

- [ ] **Step 4: Wire it into the host**

In `src/Orchestrator/OrchestratorHost.cs`, after the existing `builder.Services.AddSingleton<HydrationAdmission>();` line:

```csharp
        builder.Services.AddSingleton<HydrationAdmission>();

        // Hosted purely so the container constructs it; see the type's own remarks.
        builder.Services.AddHostedService<OrchestratorPipelineMetrics>();
```

And after the existing `builder.AddBaseConsoleObservability(builder.Configuration, source: "worker");` call:

```csharp
        builder.AddBaseConsoleObservability(builder.Configuration, source: "worker");

        // A second WithMetrics on the same OpenTelemetryBuilder adds to the provider the shared
        // call configured rather than replacing it. The role meter is added here rather than
        // inside AddBaseConsoleObservability so that method's contract stays role-agnostic.
        builder.Services.AddOpenTelemetry()
            .WithMetrics(m => m.AddMeter(OrchestratorPipelineMetrics.MeterName));
```

Add `using Orchestrator.Observability;` and `using OpenTelemetry.Metrics;` to the file if not already present.

- [ ] **Step 5: Extend the host wiring test**

Append to `src/tests/BaseApi.Tests/Orchestrator/OrchestratorHostWiringTests.cs`, inside the existing class:

```csharp
    [Fact]
    public void EachOfTheThreeConsumersReportsItsOwnQueueOnTheConsumingGauge()
    {
        // The counterpart to EveryQueueThisReplicaReadsHasAConsumerOfItsOwn, and it catches the
        // failure that test cannot: three consumers each creating their own gauge with one shared
        // name would collapse to a single metric stream in the SDK, and two of the three queues
        // would silently stop being reported. One instrument over a registry is what stops that,
        // and three distinct queue values is the observable proof it worked.
        _ = _host.Services.GetServices<IHostedService>().OfType<GatedQueueConsumer>().ToList();

        using var metrics = new MetricCollector("BaseConsole.Core.Messaging");
        metrics.Collect();

        var queues = metrics.For("pipeline.consumer.consuming")
            .Select(m => m.Tags["queue"])
            .Distinct()
            .ToList();

        Assert.Equal(3, queues.Count);
        Assert.Contains(OrchestratorQueues.Result, queues);
        Assert.Contains(OrchestratorQueues.ResultPost, queues);
    }
```

Add `using BaseApi.Tests.Support;`, `using BaseConsole.Core.Messaging;` and `using Messaging.Contracts;` to that file if not already present.

This test depends on the consumers having been constructed. `GetServices<IHostedService>()` constructs them, which is what the discarded assignment on the first line is for — the registry is populated by their constructors.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug -- --filter-method "*OrchestratorPipelineMetrics*"
dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug -- --filter-method "*OrchestratorHostWiring*"
```

Expected: 3 passed and then the wiring class's existing count plus one, all passing.

If `EachOfTheThreeConsumers...` sees more than three queues, another test class in the same run left consumers tracked — the registry is process-wide. Prefer scoping the assertion to the three names it knows over relaxing the count, and note the interaction.

- [ ] **Step 7: Run the full suite**

```bash
dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug
```

Expected: total 481, succeeded 474, skipped 7, failed 0.

- [ ] **Step 8: Commit**

```bash
git add src/Orchestrator/Observability/OrchestratorPipelineMetrics.cs \
        src/Orchestrator/OrchestratorHost.cs \
        src/tests/BaseApi.Tests/Orchestrator/OrchestratorPipelineMetricsTests.cs \
        src/tests/BaseApi.Tests/Orchestrator/OrchestratorHostWiringTests.cs
git commit -m "feat: say why one orchestrator replica is quieter than another

Leadership and hydration admission are the two flags that explain an idle
replica. Neither gates consumption -- a follower consumes normally -- so
the gauges are documented against the alert someone would otherwise write
backwards.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: The processor's gauge and its duplicate counter

**Files:**
- Create: `src/BaseProcessor.Core/Observability/ProcessorPipelineMetrics.cs`
- Modify: `src/BaseProcessor.Core/DependencyInjection/BaseProcessorServiceCollectionExtensions.cs`
- Modify: `src/BaseProcessor.Core/Processing/ProcessDispatchHandler.cs`
- Modify: `src/Processor.Sample/ProcessorHost.cs`
- Test: `src/tests/BaseApi.Tests/Processor/ProcessorPipelineMetricsTests.cs`

**Interfaces:**
- Consumes: `IProcessorContext.Identity` — existing and public.
- Produces:
  - `internal static class ProcessorPipelineMetrics` in namespace `BaseProcessor.Core.Observability`, holding `MeterName`, `RecordDuplicateSuppressed()`, and `TrackIdentity(Func<bool>)`
  - `internal sealed class ProcessorPipelineMetricsHost : IHostedService` in the same namespace, constructor `ProcessorPipelineMetricsHost(IProcessorContext context)`
  - `public const string ProcessorPipelineMeter.Name = "BaseProcessor.Core"` for the host's `AddMeter` call

Split into a static holder plus a hosted registrar because the duplicate counter is incremented from `ProcessDispatchHandler`, which is a scoped handler and cannot own a static instrument's lifetime, while the identity gauge needs a singleton to observe.

- [ ] **Step 1: Write the failing tests**

Create `src/tests/BaseApi.Tests/Processor/ProcessorPipelineMetricsTests.cs`:

```csharp
using BaseApi.Tests.Support;
using BaseProcessor.Core.Identity;
using BaseProcessor.Core.Observability;
using Xunit;

namespace BaseApi.Tests.Processor;

public sealed class ProcessorPipelineMetricsTests
{
    private sealed class Context : IProcessorContext
    {
        public ProcessorIdentity? Identity { get; set; }
        public bool IsHealthy { get; set; }
        public void SetIdentity(Messaging.Contracts.ProcessorIdentityFound identity) =>
            throw new NotSupportedException();
    }

    [Fact]
    public void IdentityReadyIsZeroWhileTheProcessorIsStillWaitingToBeRegistered()
    {
        // An unregistered processor waits rather than restarting -- Running/NotReady with 0
        // restarts is by design. This gauge is what makes that state legible instead of alarming,
        // so the zero case is the one worth asserting first.
        var context = new Context { Identity = null };
        using var owner = new ProcessorPipelineMetricsHost(context);
        using var metrics = new MetricCollector(ProcessorPipelineMeter.Name);

        metrics.Collect();

        Assert.Equal(0, metrics.For("pipeline.identity.ready")[^1].Value);
    }

    [Fact]
    public void ADuplicateDeliverySuppressionIsCounted()
    {
        // That path acks having done no work, so it is invisible under disposition=acked. It is
        // the primary idempotence mechanism, and its rate is the only way to notice the mechanism
        // firing more than rarely.
        using var metrics = new MetricCollector(ProcessorPipelineMeter.Name);

        ProcessorPipelineMetrics.RecordDuplicateSuppressed();

        var m = Assert.Single(metrics.For("pipeline.duplicate.suppressed"));
        Assert.Equal(1, m.Value);
    }
}
```

The `Context` fake must satisfy every member of `IProcessorContext`. Read `src/BaseProcessor.Core/Identity/IProcessorContext.cs` first and add whatever else it declares — throwing `NotSupportedException` from members these tests do not reach is correct, because a test that silently returned a default from one would be asserting against a fiction.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug -- --filter-method "*ProcessorPipelineMetrics*"
```

Expected: build failure — the types do not exist.

- [ ] **Step 3: Write the implementation**

Create `src/BaseProcessor.Core/Observability/ProcessorPipelineMetrics.cs`:

```csharp
using System.Diagnostics.Metrics;
using BaseProcessor.Core.Identity;
using Microsoft.Extensions.Hosting;

namespace BaseProcessor.Core.Observability;

/// <summary>The processor meter's name, public so the host can register it on its metrics provider.</summary>
public static class ProcessorPipelineMeter
{
    public const string Name = "BaseProcessor.Core";
}

/// <summary>
/// The processor's two pipeline instruments.
/// <para>
/// A static holder because <see cref="RecordDuplicateSuppressed"/> is called from
/// <c>ProcessDispatchHandler</c>, which is resolved per delivery and cannot own an instrument's
/// lifetime. The identity gauge needs something singleton to observe, which is
/// <see cref="ProcessorPipelineMetricsHost"/>.
/// </para>
/// </summary>
internal static class ProcessorPipelineMetrics
{
    internal const string MeterName = ProcessorPipelineMeter.Name;

    internal static readonly Meter Meter = new(MeterName);

    private static readonly Counter<long> DuplicateSuppressed = Meter.CreateCounter<long>(
        "pipeline.duplicate.suppressed",
        unit: "{message}",
        description: "Dispatches whose input key was already reclaimed, so the author was not re-run.");

    /// <summary>
    /// One dispatch acknowledged without running the author, because an earlier attempt had already
    /// finished it and reclaimed the input key.
    /// <para>
    /// It is pipeline rather than business: the statement is about delivery semantics — a message
    /// arrived that had already been handled — not about what the step computed.
    /// </para>
    /// </summary>
    internal static void RecordDuplicateSuppressed() => DuplicateSuppressed.Add(1);
}

/// <summary>
/// Owns <c>pipeline.identity.ready</c>.
/// <para>
/// <b>Hosted only so the container constructs it</b>, for the same reason as
/// <c>L2GateMetrics</c>: a DI singleton nothing resolves is an observable that never publishes,
/// with no error to say so. Start and Stop do no work.
/// </para>
/// </summary>
internal sealed class ProcessorPipelineMetricsHost : IHostedService, IDisposable
{
    public ProcessorPipelineMetricsHost(IProcessorContext context)
    {
        ArgumentNullException.ThrowIfNull(context);

        // Identity being non-null, NOT IsHealthy: the two are deliberately distinct, and this is
        // the one that explains a pod sitting Running/NotReady with zero restarts. That state is by
        // design -- an unregistered processor waits for its row rather than crash-looping -- and
        // without this gauge it is indistinguishable from a hang.
        ProcessorPipelineMetrics.Meter.CreateObservableGauge(
            "pipeline.identity.ready",
            () => context.Identity is not null ? 1 : 0,
            unit: "1",
            description: "1 once this processor resolved its identity row and can accept work.");
    }

    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public void Dispose()
    {
    }
}
```

- [ ] **Step 4: Increment the counter on the duplicate path**

In `src/BaseProcessor.Core/Processing/ProcessDispatchHandler.cs`, in the `raw.IsNullOrEmpty` branch, beside the existing log line. Leave the long comment block above it exactly as it is — it is the reasoning this counter measures.

```csharp
                _logger.LogInformation("entry absent — treating as a duplicate delivery");
                ProcessorPipelineMetrics.RecordDuplicateSuppressed();
                return;
```

Add `using BaseProcessor.Core.Observability;` to the file.

- [ ] **Step 5: Register the host**

In `src/BaseProcessor.Core/DependencyInjection/BaseProcessorServiceCollectionExtensions.cs`, after the existing `services.TryAddSingleton<IProcessorContext, ProcessorContext>();`:

```csharp
        services.TryAddSingleton<IProcessorContext, ProcessorContext>();

        // Hosted purely so the container constructs it; see the type's own remarks.
        services.AddHostedService<ProcessorPipelineMetricsHost>();
```

Add `using BaseProcessor.Core.Observability;` to that file.

- [ ] **Step 6: Add the meter to the processor host**

In `src/Processor.Sample/ProcessorHost.cs`, after the existing `builder.AddBaseConsoleObservability(...)` call:

```csharp
        // A second WithMetrics on the same OpenTelemetryBuilder adds to the provider the shared
        // call configured rather than replacing it.
        builder.Services.AddOpenTelemetry()
            .WithMetrics(m => m.AddMeter(ProcessorPipelineMeter.Name));
```

Add `using BaseProcessor.Core.Observability;` and `using OpenTelemetry.Metrics;` if not already present.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug -- --filter-method "*ProcessorPipelineMetrics*"
```

Expected: 2 passed, 0 failed.

- [ ] **Step 8: Run the full suite**

```bash
dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug
```

Expected: total 483, succeeded 476, skipped 7, failed 0.

`ProcessorHostWiringTests` and `ProcessDispatchHandlerTests` both touch the files this task changed. `ProcessDispatchHandlerTests` already covers the duplicate-delivery branch; if it fails, the counter call was placed on the wrong side of the `return`.

- [ ] **Step 9: Commit**

```bash
git add src/BaseProcessor.Core/Observability/ProcessorPipelineMetrics.cs \
        src/BaseProcessor.Core/DependencyInjection/BaseProcessorServiceCollectionExtensions.cs \
        src/BaseProcessor.Core/Processing/ProcessDispatchHandler.cs \
        src/Processor.Sample/ProcessorHost.cs \
        src/tests/BaseApi.Tests/Processor/ProcessorPipelineMetricsTests.cs
git commit -m "feat: distinguish a processor waiting for its row from one that is stuck

Running/NotReady with zero restarts is by design, and without a gauge for
it that state is indistinguishable from a hang.

The duplicate-suppression counter covers the one path that acknowledges a
dispatch without running the author, which is invisible under acked and
is the primary idempotence mechanism.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage.** Every numbered section maps to a task:

| Spec | Task |
| --- | --- |
| §2 consistency mechanism | 6 (the `AddMeter` lines are the mechanism) |
| §2.1 no identity on instruments | Global Constraints; no task adds one |
| §3, §3.1 naming, `route` | 1, 2 |
| §4 egress instruments | 1 |
| §4.1 instrument the primitives | 2 |
| §4.2 outcome classification | 1 |
| §5 ingress instruments | 3, 4 |
| §5.1 disposition matrix | 3 |
| §5.2 `landed` | 3 |
| §5.3 duration / inflight / consuming | 3 (duration), 4 (inflight, consuming) |
| §5.4 instrument ownership | 4 (registry), 5, 7, 8 (single owners) |
| §6 gate + role gauges | 5, 7, 8 |
| §7 queries | no code; the attribute names the tasks assert are what make them resolve |
| §8 cardinality | Global Constraints (closed vocabularies); `destination` is left raw as the spec chose |
| §9 wiring | 6, 7, 8 |
| §10 out of scope | Global Constraints forbid touching `BaseApi.*` and either `L2Gate` |
| §11 testing | every task's test steps; the RealStack gap is stated below |

**Known gaps, stated rather than hidden:**

- **`landed=true` is never asserted.** It needs a real channel and a valid delivery tag. Spec §11 says so; no task claims otherwise. It is exercised by any RealStack run and by production.
- **Task 2 has no test of its own.** Both send primitives need a live broker — `Messaging.Transport.csproj`'s own comment says only `BuildProperties` is unit-testable. Task 1 tests the measurement; Task 2 is the wrap, and the full suite proves nothing else moved.
- **Task 6, Step 1 does not pin the assertion.** How OpenTelemetry 1.15.3 exposes configured meter names from a built host is not established, so the step gives the preferred assertion, a command to find the real type, and a strictly stronger behavioural fallback. This is the one place the plan defers a decision, and it defers it with both branches spelled out rather than leaving it open.
- **The consumer registry is process-wide static state**, so tests that assert on the set of tracked queues can see consumers another test class constructed. Tasks 4 and 7 both name this and say to find the leak rather than loosen the assertion.

**Type consistency.** `MeterName` is the constant name on `EgressMetrics`, `IngressMetrics`, `L2GateMetrics`, `OrchestratorPipelineMetrics` and `ProcessorPipelineMetrics`. The two that must cross an assembly boundary for an `AddMeter` call are additionally exposed as `public const string Name` on `EgressMeter` (Task 6) and `ProcessorPipelineMeter` (Task 8) — the difference is deliberate and each is introduced at the point it is needed. `MetricCollector.For(string)` and `RecordedMeasurement.Tags` are used identically in every test file. `IngressMetrics.RecordConsumed` keeps the same six-parameter signature from Task 3 through Task 4.

**Test counts.** 451 → 459 (T1) → 459 (T2) → 469 (T3) → 473 (T4) → 476 (T5) → 477 (T6) → 481 (T7) → 483 (T8). Skips stay at 7 throughout. Any task that lands on a different total has added or lost a test unintentionally.
