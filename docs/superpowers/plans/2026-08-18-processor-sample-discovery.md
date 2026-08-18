# Processor.Sample Discovery & Liveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a processor console in `src/` that discovers its own identity and schemas from BaseApi over RabbitMQ, validates config-schema coverage, and publishes liveness to Redis — consuming no work.

**Architecture:** One background loop owns all state and drives everything: it stamps a liveness heartbeat, asks BaseApi over reply-to RPC, applies answers handed to it by a reply consumer through an atomic slot, evaluates Gate A, and writes the L2 liveness entry. The reply consumer never touches processor state, which keeps the existing WR-03 memory-visibility invariant true without adding synchronization.

**Tech Stack:** .NET 8, RabbitMQ.Client 7.x (raw AMQP — no MassTransit), StackExchange.Redis, xUnit v3 under Microsoft.Testing.Platform, `Microsoft.Extensions.TimeProvider.Testing` for loop tests.

**Spec:** `docs/superpowers/specs/2026-08-18-processor-sample-discovery-design.md`

## Global Constraints

- **Target framework** `net8.0`; `Nullable` enabled; `TreatWarningsAsErrors` on (from `Directory.Build.props`) — a warning fails the build.
- **Central Package Management:** no `Version=` attribute on any `PackageReference`. All versions come from `src/Directory.Packages.props`. Every package this plan needs is already pinned there.
- **No MassTransit** anywhere. Raw `RabbitMQ.Client` 7.x async API only (`BasicPublishAsync`, `BasicConsumeAsync`, `BasicAckAsync`).
- **File-scoped namespaces**, explicit constructors with `ArgumentNullException` guards — match the surrounding `src` style.
- **Message type headers** come from `Messaging.Contracts.MessageTypes`; payloads serialize with `MessagingJson.Options`.
- **Every send** is wrapped in `try/catch`: log and continue. Nothing escapes a loop.
- **Every loop** stamps `Beat()` first, before any I/O, unconditionally.
- **Repo prerequisite:** `C:\Users\UserL\source\repos\SK_P9` is **not a git repository**. Run `git init` before Task 1, or drop every commit step.

## Scope Note — one addition the spec did not cover

The spec assumes the processor can use `src`'s transport primitives, but does not say how. It cannot reference `BaseApi.Core`: that project carries `FrameworkReference Microsoft.AspNetCore.App`, EF Core, Npgsql, Swashbuckle, and Asp.Versioning, so a console referencing it inherits the entire API stack — precisely what the reference repo's console dependency-firewall test existed to prevent.

**Task 2 therefore extracts the shared transport into a new `src/Messaging.Transport` project** referenced by both `BaseApi.Core` and `BaseConsole.Core`. This modifies `BaseApi.Core`, which was not in the named scope. The alternative — copying `RabbitMqConnection`, `QueueSender`, and `RabbitMqOptions` into `BaseConsole.Core` — needs no change to `BaseApi.Core` but creates two copies of the connection and publisher-confirm logic that will drift.

**Confirm the extraction before executing Task 2.** Everything downstream depends on which way this goes.

## Second Scope Note — `SampleProcessor.cs` cannot come across

The spec lists `SampleProcessor.cs` among the files to port. It cannot: `SampleProcessor` derives from `BaseProcessor<SampleConfig>` and uses `DataResult`, `StepOutcome`, and `SpawnToPost` — all dispatch machinery that is explicitly out of scope. This slice's `Processor.Sample` is `Program.cs` plus `SampleConfig.cs`; `SampleConfig` is still needed because Gate A evaluates coverage against the concrete config type. The transform arrives with dispatch.

For the same reason `BaseProcessorConfigTypeProvider` cannot be ported verbatim — it reflects over a registered `BaseProcessor` to find `TConfig`. Task 8 replaces it with a generic `ConfigTypeProvider<TConfig>`.

---

## File Structure

**New project — `src/Messaging.Transport/`** (Task 2). Raw-AMQP primitives shared by API and consoles. Depends only on `RabbitMQ.Client` and `Messaging.Contracts`. No ASP.NET, no EF.
- `RabbitMqOptions.cs`, `RabbitMqConnection.cs`, `IQueueSender.cs`, `QueueSender.cs`, `IQueueMessageHandler.cs`, `IRabbitMqTopology.cs` — all moved from `BaseApi.Core/Messaging/`.

**New project — `src/BaseConsole.Core/`** (Tasks 3–5, 10). Console host concerns, no processor semantics.
- `Loop/ILoopHeartbeat.cs`, `Loop/LoopHeartbeat.cs`, `Loop/ConsoleLoopOptions.cs` — the loop stamp.
- `Health/IStartupGate.cs`, `Health/LoopLivenessHealthCheck.cs`, `Health/EmbeddedHealthEndpointService.cs`.
- `Messaging/ReplySlot.cs` — the atomic handoff plus wake signal.
- `Messaging/ReplyQueueConsumer.cs` — exclusive auto-delete reply queue; validates, stores, acks, signals.

**New project — `src/BaseProcessor.Core/`** (Tasks 6–9). Processor semantics.
- `Identity/ISourceHashProvider.cs`, `Identity/AssemblyMetadataSourceHashProvider.cs`, `Identity/IProcessorContext.cs`, `Identity/ProcessorContext.cs`.
- `Configuration/ProcessorConfig.cs`, `Configuration/IConfigTypeProvider.cs`, `Configuration/ConfigTypeProvider.cs`, `Configuration/ConfigSchemaCoverageCheck.cs`, `Configuration/ProcessorLivenessOptions.cs`.
- `Liveness/ProcessorLivenessWriter.cs`.
- `Discovery/ProcessorDiscoveryLoop.cs` — the single background service.
- `DependencyInjection/BaseProcessorServiceCollectionExtensions.cs`.
- `SourceHash.targets` — build-time identity, imported explicitly by concretes.

**New project — `src/Processor.Sample/`** (Task 11). Thin shell: `Program.cs`, `SampleConfig.cs`.

**New test project — `src/tests/BaseApi.Tests/`** (Task 1). One project covering the whole solution, as in the reference repo.

---

### Task 1: Test project scaffold

**Files:**
- Create: `src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
- Create: `src/tests/BaseApi.Tests/xunit.runner.json`
- Create: `src/tests/BaseApi.Tests/MetaTest.cs`
- Modify: `SK_P.sln`

**Interfaces:**
- Consumes: nothing.
- Produces: a runnable MTP test host at `src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe`. Every later task adds tests here.

- [ ] **Step 1: Write the failing test**

Create `src/tests/BaseApi.Tests/MetaTest.cs`:

```csharp
using Xunit;

namespace BaseApi.Tests;

public sealed class MetaTest
{
    [Fact]
    public void TestStackIsWired() => Assert.True(true);
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: FAIL — the project file does not exist yet (MSBuild error MSB1009).

- [ ] **Step 3: Create the project file**

Create `src/tests/BaseApi.Tests/BaseApi.Tests.csproj`. All four properties are load-bearing for xunit.v3 3.2.2 under Microsoft.Testing.Platform — omitting `TestingPlatformDotnetTestSupport` routes `dotnet test` to the legacy VSTest host, which then fails resolving xunit.v3's dependencies:

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <RootNamespace>BaseApi.Tests</RootNamespace>
    <AssemblyName>BaseApi.Tests</AssemblyName>
    <IsPackable>false</IsPackable>
    <IsTestProject>true</IsTestProject>
    <OutputType>Exe</OutputType>
    <UseMicrosoftTestingPlatformRunner>true</UseMicrosoftTestingPlatformRunner>
    <TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport>
  </PropertyGroup>

  <ItemGroup>
    <None Include="xunit.runner.json" CopyToOutputDirectory="PreserveNewest" />
  </ItemGroup>

  <ItemGroup>
    <PackageReference Include="xunit.v3" />
    <PackageReference Include="xunit.v3.assert" />
    <PackageReference Include="xunit.runner.visualstudio">
      <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>
      <PrivateAssets>all</PrivateAssets>
    </PackageReference>
    <PackageReference Include="NSubstitute" />
    <PackageReference Include="Microsoft.Extensions.TimeProvider.Testing" />
  </ItemGroup>

</Project>
```

- [ ] **Step 4: Create the runner config**

Create `src/tests/BaseApi.Tests/xunit.runner.json`:

```json
{
  "$schema": "https://xunit.net/schema/current/xunit.runner.schema.json",
  "maxParallelThreads": 6,
  "parallelAlgorithm": "conservative"
}
```

- [ ] **Step 5: Add the project to the solution**

Run: `dotnet sln SK_P.sln add src/tests/BaseApi.Tests/BaseApi.Tests.csproj`

- [ ] **Step 6: Run the test to verify it passes**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: PASS, 1 test. Note for later tasks: under MTP a plain `--filter` is **silently ignored** — select with `--filter-class`, `--filter-method`, or `--filter-trait`.

- [ ] **Step 7: Commit**

```bash
git add src/tests SK_P.sln
git commit -m "test: add BaseApi.Tests project with xunit.v3 MTP scaffold"
```

---

### Task 2: Extract `Messaging.Transport`

**Confirm the Scope Note above before starting.**

**Files:**
- Create: `src/Messaging.Transport/Messaging.Transport.csproj`
- Move: `src/BaseApi.Core/Messaging/{RabbitMqOptions,RabbitMqConnection,IQueueSender,QueueSender,IQueueMessageHandler,IRabbitMqTopology}.cs` → `src/Messaging.Transport/`
- Modify: `src/BaseApi.Core/BaseApi.Core.csproj` (add ProjectReference), and every file in `BaseApi.Core`/`BaseApi.Service` that used those types (add `using Messaging.Transport;`)
- Test: `src/tests/BaseApi.Tests/Transport/TransportDependencyFirewallTests.cs`
- Modify: `SK_P.sln`

**Interfaces:**
- Consumes: nothing.
- Produces: namespace `Messaging.Transport` exporting `RabbitMqOptions`, `RabbitMqConnection` (`ValueTask<IConnection> GetAsync(CancellationToken)`, `bool IsOpen`), `IQueueSender.SendAsync<T>(string queue, string type, T body, CancellationToken ct)`, `IQueueMessageHandler` (`string MessageType`, `Task HandleAsync(ReadOnlyMemory<byte> body, CancellationToken ct)`), `IRabbitMqTopology.DeclareAsync(IChannel, CancellationToken)`.

- [ ] **Step 1: Write the failing test**

Create `src/tests/BaseApi.Tests/Transport/TransportDependencyFirewallTests.cs`. This is the test that keeps a console able to use the transport — it fails the moment someone pulls ASP.NET or EF into it:

```csharp
using System.Reflection;
using Messaging.Transport;
using Xunit;

namespace BaseApi.Tests.Transport;

public sealed class TransportDependencyFirewallTests
{
    [Fact]
    public void TransportReferencesNoWebOrDataStack()
    {
        var referenced = typeof(RabbitMqConnection).Assembly
            .GetReferencedAssemblies()
            .Select(a => a.Name ?? string.Empty)
            .ToArray();

        Assert.DoesNotContain(referenced, n => n.StartsWith("Microsoft.AspNetCore", StringComparison.Ordinal));
        Assert.DoesNotContain(referenced, n => n.StartsWith("Microsoft.EntityFrameworkCore", StringComparison.Ordinal));
        Assert.DoesNotContain(referenced, n => n.StartsWith("Swashbuckle", StringComparison.Ordinal));
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj --filter-class "*TransportDependencyFirewallTests"`
Expected: FAIL — `Messaging.Transport` does not exist (CS0246).

- [ ] **Step 3: Create the project**

Create `src/Messaging.Transport/Messaging.Transport.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <ItemGroup>
    <PackageReference Include="RabbitMQ.Client" />
    <ProjectReference Include="..\Messaging.Contracts\Messaging.Contracts.csproj" />
  </ItemGroup>

</Project>
```

- [ ] **Step 4: Move the six files**

```bash
git mv src/BaseApi.Core/Messaging/RabbitMqOptions.cs      src/Messaging.Transport/
git mv src/BaseApi.Core/Messaging/RabbitMqConnection.cs   src/Messaging.Transport/
git mv src/BaseApi.Core/Messaging/IQueueSender.cs         src/Messaging.Transport/
git mv src/BaseApi.Core/Messaging/QueueSender.cs          src/Messaging.Transport/
git mv src/BaseApi.Core/Messaging/IQueueMessageHandler.cs src/Messaging.Transport/
git mv src/BaseApi.Core/Messaging/IRabbitMqTopology.cs    src/Messaging.Transport/
```

In each moved file change `namespace BaseApi.Core.Messaging;` to `namespace Messaging.Transport;`. Leave every doc comment intact — they carry the rationale for `mandatory: true` and publisher confirms, which later tasks depend on.

- [ ] **Step 5: Reference the project and fix usings**

Add to `src/BaseApi.Core/BaseApi.Core.csproj`:

```xml
<ProjectReference Include="..\Messaging.Transport\Messaging.Transport.csproj" />
```

Run: `dotnet sln SK_P.sln add src/Messaging.Transport/Messaging.Transport.csproj`

Then build and add `using Messaging.Transport;` to every file the compiler flags. Expect: `GatedQueueConsumer.cs`, `RpcQueueConsumer.cs`, `BrokerHealthCheck.cs`, `DependencyInjection/MessagingServiceCollectionExtensions.cs` in `BaseApi.Core`; `Composition/QueryTopology.cs` and `Features/Orchestration/Messaging/OrchestrationTopology.cs` in `BaseApi.Service`.

- [ ] **Step 6: Run the build and the test**

Run: `dotnet build SK_P.sln -c Debug` — expected: 0 warnings, 0 errors.
Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj --filter-class "*TransportDependencyFirewallTests"` — expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: extract Messaging.Transport from BaseApi.Core"
```

---

### Task 3: BaseConsole.Core loop primitives

**Files:**
- Create: `src/BaseConsole.Core/BaseConsole.Core.csproj`
- Create: `src/BaseConsole.Core/Loop/{ILoopHeartbeat,LoopHeartbeat,ConsoleLoopOptions}.cs`
- Create: `src/BaseConsole.Core/Health/{IStartupGate,LoopLivenessHealthCheck}.cs`
- Test: `src/tests/BaseApi.Tests/Console/LoopHeartbeatTests.cs`
- Modify: `SK_P.sln`

**Interfaces:**
- Consumes: nothing.
- Produces: `ILoopHeartbeat` (`DateTimeOffset? Last`, `void Beat()`); `ConsoleLoopOptions` (`TimeSpan Interval` default 10s, `int StaleFactor` default 3, `TimeSpan GracePeriod` default 1s, `int RequestTimeoutSeconds` default 8); `IStartupGate` (`bool IsReady`, `void MarkReady()`); `LoopLivenessHealthCheck : IHealthCheck`.

- [ ] **Step 1: Write the failing tests**

Create `src/tests/BaseApi.Tests/Console/LoopHeartbeatTests.cs`:

```csharp
using BaseConsole.Core.Health;
using BaseConsole.Core.Loop;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;
using Xunit;

namespace BaseApi.Tests.Console;

public sealed class LoopHeartbeatTests
{
    private static LoopLivenessHealthCheck Check(ILoopHeartbeat beat, TimeProvider clock) =>
        new(beat, Options.Create(new ConsoleLoopOptions
        {
            Interval = TimeSpan.FromSeconds(10),
            StaleFactor = 3,
        }), clock);

    [Fact]
    public void LastIsNullBeforeFirstBeat()
    {
        var clock = new FakeTimeProvider();
        Assert.Null(new LoopHeartbeat(clock).Last);
    }

    [Fact]
    public async Task UnhealthyBeforeFirstBeat()
    {
        var clock = new FakeTimeProvider();
        var result = await Check(new LoopHeartbeat(clock), clock)
            .CheckHealthAsync(new HealthCheckContext(), TestContext.Current.CancellationToken);

        Assert.Equal(HealthStatus.Unhealthy, result.Status);
    }

    [Fact]
    public async Task HealthyWithinTheStaleWindow()
    {
        var clock = new FakeTimeProvider();
        var beat = new LoopHeartbeat(clock);
        beat.Beat();
        clock.Advance(TimeSpan.FromSeconds(29));   // interval 10 * staleFactor 3 = 30

        var result = await Check(beat, clock)
            .CheckHealthAsync(new HealthCheckContext(), TestContext.Current.CancellationToken);

        Assert.Equal(HealthStatus.Healthy, result.Status);
    }

    [Fact]
    public async Task UnhealthyOnceTheStaleWindowElapses()
    {
        var clock = new FakeTimeProvider();
        var beat = new LoopHeartbeat(clock);
        beat.Beat();
        clock.Advance(TimeSpan.FromSeconds(31));

        var result = await Check(beat, clock)
            .CheckHealthAsync(new HealthCheckContext(), TestContext.Current.CancellationToken);

        Assert.Equal(HealthStatus.Unhealthy, result.Status);
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj --filter-class "*LoopHeartbeatTests"`
Expected: FAIL — `BaseConsole.Core` does not exist (CS0246).

- [ ] **Step 3: Create the project**

`src/BaseConsole.Core/BaseConsole.Core.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <ItemGroup>
    <PackageReference Include="Microsoft.Extensions.Hosting" />
    <PackageReference Include="Microsoft.Extensions.Diagnostics.HealthChecks" />
    <PackageReference Include="StackExchange.Redis" />
    <ProjectReference Include="..\Messaging.Transport\Messaging.Transport.csproj" />
    <ProjectReference Include="..\Messaging.Contracts\Messaging.Contracts.csproj" />
  </ItemGroup>

</Project>
```

Run `dotnet sln SK_P.sln add src/BaseConsole.Core/BaseConsole.Core.csproj`.

- [ ] **Step 4: Implement the loop primitives**

`src/BaseConsole.Core/Loop/ILoopHeartbeat.cs`:

```csharp
namespace BaseConsole.Core.Loop;

/// <summary>
/// The stamp a loop leaves on every iteration. It is the only evidence the process is still capable
/// of running that loop — a loop that is asleep is indistinguishable from one that has died.
/// </summary>
public interface ILoopHeartbeat
{
    /// <summary>The last stamp, or null if the loop has never run an iteration.</summary>
    DateTimeOffset? Last { get; }

    /// <summary>Stamp the current time. Called at the top of every iteration, before any I/O.</summary>
    void Beat();
}
```

`src/BaseConsole.Core/Loop/LoopHeartbeat.cs`:

```csharp
namespace BaseConsole.Core.Loop;

public sealed class LoopHeartbeat : ILoopHeartbeat
{
    private readonly TimeProvider _clock;
    private long _lastUtcTicks;

    public LoopHeartbeat(TimeProvider clock)
        => _clock = clock ?? throw new ArgumentNullException(nameof(clock));

    public DateTimeOffset? Last
    {
        get
        {
            var ticks = Interlocked.Read(ref _lastUtcTicks);
            return ticks == 0 ? null : new DateTimeOffset(ticks, TimeSpan.Zero);
        }
    }

    public void Beat()
    {
        var now = _clock.GetUtcNow();
        Interlocked.Exchange(ref _lastUtcTicks, now.UtcTicks);
    }
}
```

`src/BaseConsole.Core/Loop/ConsoleLoopOptions.cs`:

```csharp
namespace BaseConsole.Core.Loop;

public sealed class ConsoleLoopOptions
{
    /// <summary>Cadence of the discovery/liveness loop.</summary>
    public TimeSpan Interval { get; set; } = TimeSpan.FromSeconds(10);

    /// <summary>Multiples of <see cref="Interval"/> before a missing beat reads as dead.</summary>
    public int StaleFactor { get; set; } = 3;

    /// <summary>
    /// Cushion between the reply queue's consume confirmation and the first ask. The broker's
    /// confirmation is the guarantee; this only absorbs jitter, so zero must remain correct.
    /// </summary>
    public TimeSpan GracePeriod { get; set; } = TimeSpan.FromSeconds(1);
}
```

`src/BaseConsole.Core/Health/IStartupGate.cs` — copy verbatim from `src/BaseApi.Core/Health/IStartupGate.cs`, changing only the namespace to `BaseConsole.Core.Health`.

`src/BaseConsole.Core/Health/LoopLivenessHealthCheck.cs`:

```csharp
using BaseConsole.Core.Loop;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;

namespace BaseConsole.Core.Health;

public sealed class LoopLivenessHealthCheck : IHealthCheck
{
    private readonly ILoopHeartbeat _heartbeat;
    private readonly ConsoleLoopOptions _options;
    private readonly TimeProvider _clock;

    public LoopLivenessHealthCheck(
        ILoopHeartbeat heartbeat, IOptions<ConsoleLoopOptions> options, TimeProvider clock)
    {
        _heartbeat = heartbeat ?? throw new ArgumentNullException(nameof(heartbeat));
        _options   = options?.Value ?? throw new ArgumentNullException(nameof(options));
        _clock     = clock ?? throw new ArgumentNullException(nameof(clock));
    }

    public Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context, CancellationToken cancellationToken = default)
    {
        if (_heartbeat.Last is not { } last)
        {
            return Task.FromResult(HealthCheckResult.Unhealthy("discovery loop has not started"));
        }

        var window = _options.Interval * _options.StaleFactor;
        return Task.FromResult(_clock.GetUtcNow() - last > window
            ? HealthCheckResult.Unhealthy("discovery loop stale")
            : HealthCheckResult.Healthy("discovery loop running"));
    }
}
```

- [ ] **Step 5: Run the tests**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj --filter-class "*LoopHeartbeatTests"`
Expected: PASS, 4 tests. Add `<ProjectReference Include="..\..\..\BaseConsole.Core\BaseConsole.Core.csproj" />` to the test csproj if the compiler cannot find the namespace.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add BaseConsole.Core loop heartbeat and liveness check"
```

---

### Task 4: The reply slot

**Files:**
- Create: `src/BaseConsole.Core/Messaging/ReplySlot.cs`
- Test: `src/tests/BaseApi.Tests/Console/ReplySlotTests.cs`

**Interfaces:**
- Consumes: nothing.
- Produces: `ReplySlot<T> where T : class` — `void Publish(T reply)`, `T? Take()`, `Task WaitAsync(TimeSpan timeout, CancellationToken ct)`.

This is the single piece of shared mutable state in the design. The consumer publishes, the loop takes. Latest wins, because duplicate replies are idempotent and a newer answer is never worse than an older one.

- [ ] **Step 1: Write the failing tests**

Create `src/tests/BaseApi.Tests/Console/ReplySlotTests.cs`:

```csharp
using System.Diagnostics;
using BaseConsole.Core.Messaging;
using Xunit;

namespace BaseApi.Tests.Console;

public sealed class ReplySlotTests
{
    [Fact]
    public void TakeReturnsNullWhenEmpty() => Assert.Null(new ReplySlot<string>().Take());

    [Fact]
    public void TakeDrainsTheSlot()
    {
        var slot = new ReplySlot<string>();
        slot.Publish("first");

        Assert.Equal("first", slot.Take());
        Assert.Null(slot.Take());
    }

    [Fact]
    public void LatestPublishWins()
    {
        var slot = new ReplySlot<string>();
        slot.Publish("first");
        slot.Publish("second");

        Assert.Equal("second", slot.Take());
    }

    [Fact]
    public async Task WaitReturnsEarlyWhenAReplyArrives()
    {
        var slot = new ReplySlot<string>();
        var sw = Stopwatch.StartNew();

        var waiter = slot.WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken);
        slot.Publish("arrived");
        await waiter;

        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(5), $"waited {sw.Elapsed}");
    }

    [Fact]
    public async Task WaitReturnsOnTimeoutWithNoReply()
    {
        var slot = new ReplySlot<string>();
        await slot.WaitAsync(TimeSpan.FromMilliseconds(50), TestContext.Current.CancellationToken);
        Assert.Null(slot.Take());
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj --filter-class "*ReplySlotTests"`
Expected: FAIL — `ReplySlot<T>` not defined.

- [ ] **Step 3: Implement**

`src/BaseConsole.Core/Messaging/ReplySlot.cs`:

```csharp
namespace BaseConsole.Core.Messaging;

/// <summary>
/// The handoff between the reply consumer's thread and the loop that owns all state.
/// <para>
/// <b>Latest wins.</b> Replies to a periodic ask are idempotent, so a newer answer is never worse
/// than the one it replaces and dropping the older one costs nothing.
/// </para>
/// <para>
/// <b>Waiting is a signal, not a queue.</b> <see cref="WaitAsync"/> returns as soon as something is
/// published or the timeout elapses, whichever comes first — without it, deferring application to
/// the loop's next tick would add a full interval per discovery stage to every boot.
/// </para>
/// </summary>
public sealed class ReplySlot<T> where T : class
{
    private readonly SemaphoreSlim _signal = new(0);
    private T? _pending;

    /// <summary>Store a reply and wake any waiter. Safe to call from a consumer thread.</summary>
    public void Publish(T reply)
    {
        ArgumentNullException.ThrowIfNull(reply);
        Interlocked.Exchange(ref _pending, reply);
        if (_signal.CurrentCount == 0)
        {
            _signal.Release();
        }
    }

    /// <summary>Take the pending reply, leaving the slot empty. Null when nothing has arrived.</summary>
    public T? Take() => Interlocked.Exchange(ref _pending, null);

    /// <summary>Wait for a publish or the timeout, whichever comes first.</summary>
    public async Task WaitAsync(TimeSpan timeout, CancellationToken ct)
    {
        try
        {
            await _signal.WaitAsync(timeout, ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Shutdown. The caller's loop condition handles it.
        }
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj --filter-class "*ReplySlotTests"`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add ReplySlot handoff with wake signal"
```

---

### Task 5: The reply queue consumer

**Files:**
- Create: `src/BaseConsole.Core/Messaging/ReplyQueueConsumer.cs`
- Create: `src/BaseConsole.Core/Messaging/DiscoveryReply.cs`
- Test: `src/tests/BaseApi.Tests/Console/DiscoveryReplyRouterTests.cs`

**Interfaces:**
- Consumes: `ReplySlot<T>` (Task 4); `RabbitMqConnection` (Task 2); `MessageTypes`, `MessagingJson`, `ProcessorIdentityFound`, `ProcessorIdentityNotFound`, `SchemaDefinitionFound`, `SchemaDefinitionNotFound` from `Messaging.Contracts`.
- Produces: `sealed record DiscoveryReply(string Type, ReadOnlyMemory<byte> Body)`; `ReplyQueueConsumer` with `string QueueName { get; }` and `Task StartAsync(CancellationToken)`; and `DiscoveryReplyRouter.Route(string type, ReadOnlyMemory<byte> body)` returning `object?`.

The router is separated from the AMQP plumbing so the parsing rules are testable without a broker.

- [ ] **Step 1: Write the failing tests**

Create `src/tests/BaseApi.Tests/Console/DiscoveryReplyRouterTests.cs`:

```csharp
using System.Text;
using System.Text.Json;
using BaseConsole.Core.Messaging;
using Messaging.Contracts;
using Xunit;

namespace BaseApi.Tests.Console;

public sealed class DiscoveryReplyRouterTests
{
    private static ReadOnlyMemory<byte> Json<T>(T value) =>
        JsonSerializer.SerializeToUtf8Bytes(value, MessagingJson.Options);

    [Fact]
    public void RoutesIdentityFound()
    {
        var found = new ProcessorIdentityFound(
            Guid.NewGuid(), null, null, null, "sample", "1.0.0");

        var routed = DiscoveryReplyRouter.Route(MessageTypes.ProcessorIdentityFound, Json(found));

        Assert.Equal(found, Assert.IsType<ProcessorIdentityFound>(routed));
    }

    [Fact]
    public void RoutesIdentityNotFound()
    {
        var routed = DiscoveryReplyRouter.Route(
            MessageTypes.ProcessorIdentityNotFound, Json(new ProcessorIdentityNotFound("abc")));

        Assert.Equal("abc", Assert.IsType<ProcessorIdentityNotFound>(routed).SourceHash);
    }

    [Fact]
    public void RoutesSchemaFound()
    {
        var routed = DiscoveryReplyRouter.Route(
            MessageTypes.SchemaDefinitionFound, Json(new SchemaDefinitionFound("{}")));

        Assert.Equal("{}", Assert.IsType<SchemaDefinitionFound>(routed).Definition);
    }

    [Fact]
    public void UnknownTypeReturnsNull() =>
        Assert.Null(DiscoveryReplyRouter.Route("no-such-type", Json(new { x = 1 })));

    [Fact]
    public void MalformedBodyThrows() =>
        Assert.ThrowsAny<JsonException>(() => DiscoveryReplyRouter.Route(
            MessageTypes.ProcessorIdentityFound,
            new ReadOnlyMemory<byte>(Encoding.UTF8.GetBytes("{not json"))));
}
```

- [ ] **Step 2: Run to verify failure**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj --filter-class "*DiscoveryReplyRouterTests"`
Expected: FAIL — `DiscoveryReplyRouter` not defined.

- [ ] **Step 3: Implement the router**

`src/BaseConsole.Core/Messaging/DiscoveryReply.cs`:

```csharp
using System.Text.Json;
using Messaging.Contracts;

namespace BaseConsole.Core.Messaging;

/// <summary>
/// Turns a reply's type header plus body into the contract record it names. Unknown types return
/// null — the caller drops them. A malformed body throws, and the caller treats that as a property
/// of the message: log, ack, drop. The next ask produces a fresh answer.
/// </summary>
public static class DiscoveryReplyRouter
{
    public static object? Route(string type, ReadOnlyMemory<byte> body) => type switch
    {
        MessageTypes.ProcessorIdentityFound =>
            JsonSerializer.Deserialize<ProcessorIdentityFound>(body.Span, MessagingJson.Options),
        MessageTypes.ProcessorIdentityNotFound =>
            JsonSerializer.Deserialize<ProcessorIdentityNotFound>(body.Span, MessagingJson.Options),
        MessageTypes.SchemaDefinitionFound =>
            JsonSerializer.Deserialize<SchemaDefinitionFound>(body.Span, MessagingJson.Options),
        MessageTypes.SchemaDefinitionNotFound =>
            JsonSerializer.Deserialize<SchemaDefinitionNotFound>(body.Span, MessagingJson.Options),
        _ => null,
    };
}
```

- [ ] **Step 4: Implement the consumer**

`src/BaseConsole.Core/Messaging/ReplyQueueConsumer.cs`. Note the disposition: **ack whatever happened**, mirroring `RpcQueueConsumer` — a reply that cannot be parsed is worthless and the periodic asker will produce another:

```csharp
using BaseConsole.Core.Loop;
using Messaging.Transport;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using RabbitMQ.Client;
using RabbitMQ.Client.Events;

namespace BaseConsole.Core.Messaging;

/// <summary>
/// The processor's own reply address: an exclusive, auto-delete queue that dies with the connection,
/// so nothing is orphaned in the broker when a replica goes away.
/// <para>
/// This consumer never touches processor state. It parses, hands the payload to the slot, acks, and
/// signals — leaving the loop as the sole writer.
/// </para>
/// </summary>
public sealed class ReplyQueueConsumer : IAsyncDisposable
{
    private readonly RabbitMqConnection _connection;
    private readonly ReplySlot<object> _slot;
    private readonly ILogger<ReplyQueueConsumer> _logger;
    private IChannel? _channel;

    public ReplyQueueConsumer(
        RabbitMqConnection connection,
        ReplySlot<object> slot,
        string instanceId,
        ILogger<ReplyQueueConsumer> logger)
    {
        _connection = connection ?? throw new ArgumentNullException(nameof(connection));
        _slot       = slot ?? throw new ArgumentNullException(nameof(slot));
        _logger     = logger ?? throw new ArgumentNullException(nameof(logger));
        ArgumentException.ThrowIfNullOrWhiteSpace(instanceId);
        QueueName = $"proc-reply-{instanceId}";
    }

    /// <summary>The reply address sent as <c>ReplyTo</c> on every request.</summary>
    public string QueueName { get; }

    /// <summary>
    /// Declares the queue and attaches the consumer, returning only once the broker has confirmed
    /// the subscription. Asking before this completes would let an answer arrive with no listener.
    /// </summary>
    public async Task StartAsync(CancellationToken ct)
    {
        var connection = await _connection.GetAsync(ct).ConfigureAwait(false);
        _channel = await connection.CreateChannelAsync(cancellationToken: ct).ConfigureAwait(false);

        await _channel.QueueDeclareAsync(
            queue: QueueName,
            durable: false,
            exclusive: true,
            autoDelete: true,
            arguments: null,
            cancellationToken: ct).ConfigureAwait(false);

        var consumer = new AsyncEventingBasicConsumer(_channel);
        consumer.ReceivedAsync += OnReceivedAsync;

        await _channel.BasicConsumeAsync(
            QueueName, autoAck: false, consumer, ct).ConfigureAwait(false);

        _logger.LogInformation("reply queue {Queue} bound", QueueName);
    }

    private async Task OnReceivedAsync(object sender, BasicDeliverEventArgs ea)
    {
        var type = ea.BasicProperties.Type ?? string.Empty;
        try
        {
            var routed = DiscoveryReplyRouter.Route(type, ea.Body);
            if (routed is null)
            {
                _logger.LogWarning("reply of unknown type {Type} on {Queue} — dropping", type, QueueName);
            }
            else
            {
                _slot.Publish(routed);
            }
        }
        catch (Exception ex)
        {
            // A property of the message, not of the environment. The loop asks again on its next
            // tick, so there is nothing worth parking and nobody left to answer from a dead letter.
            _logger.LogError(ex, "reply of type {Type} on {Queue} could not be read — dropping", type, QueueName);
        }
        finally
        {
            if (_channel is { IsOpen: true })
            {
                await _channel.BasicAckAsync(ea.DeliveryTag, multiple: false).ConfigureAwait(false);
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_channel is not null)
        {
            await _channel.DisposeAsync().ConfigureAwait(false);
        }
    }
}
```

- [ ] **Step 5: Run the tests**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj --filter-class "*DiscoveryReplyRouterTests"`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add reply queue consumer and discovery reply router"
```

---

### Task 6: Processor identity and source hash

**Files:**
- Create: `src/BaseProcessor.Core/BaseProcessor.Core.csproj`
- Create: `src/BaseProcessor.Core/Identity/{ISourceHashProvider,AssemblyMetadataSourceHashProvider,IProcessorContext,ProcessorContext}.cs`
- Create: `src/BaseProcessor.Core/SourceHash.targets`
- Test: `src/tests/BaseApi.Tests/Processor/ProcessorContextTests.cs`
- Modify: `SK_P.sln`

**Interfaces:**
- Consumes: `ProcessorIdentityFound` from `Messaging.Contracts`.
- Produces: `ISourceHashProvider.Get()`; `IProcessorContext` with `Guid? Id`, `Guid? InputSchemaId`, `Guid? OutputSchemaId`, `Guid? ConfigSchemaId`, `string? Name`, `string? Version`, `string? InputDefinition`, `string? OutputDefinition`, `string? ConfigDefinition`, `bool IsHealthy`, `void SetIdentity(ProcessorIdentityFound)`, `void SetDefinition(Guid schemaId, string definition)`, `void MarkHealthy()`.

- [ ] **Step 1: Write the failing tests**

Create `src/tests/BaseApi.Tests/Processor/ProcessorContextTests.cs`:

```csharp
using BaseProcessor.Core.Identity;
using Messaging.Contracts;
using Xunit;

namespace BaseApi.Tests.Processor;

public sealed class ProcessorContextTests
{
    [Fact]
    public void StartsEmpty()
    {
        var context = new ProcessorContext();

        Assert.Null(context.Id);
        Assert.False(context.IsHealthy);
    }

    [Fact]
    public void SetIdentityPopulatesEveryField()
    {
        var id = Guid.NewGuid();
        var input = Guid.NewGuid();
        var context = new ProcessorContext();

        context.SetIdentity(new ProcessorIdentityFound(id, input, null, null, "sample", "1.0.0"));

        Assert.Equal(id, context.Id);
        Assert.Equal(input, context.InputSchemaId);
        Assert.Null(context.OutputSchemaId);
        Assert.Equal("sample", context.Name);
        Assert.Equal("1.0.0", context.Version);
    }

    [Fact]
    public void SetDefinitionRoutesBySchemaId()
    {
        var input = Guid.NewGuid();
        var config = Guid.NewGuid();
        var context = new ProcessorContext();
        context.SetIdentity(new ProcessorIdentityFound(Guid.NewGuid(), input, null, config, "s", "1"));

        context.SetDefinition(input, "{\"type\":\"object\"}");
        context.SetDefinition(config, "{\"type\":\"string\"}");

        Assert.Equal("{\"type\":\"object\"}", context.InputDefinition);
        Assert.Equal("{\"type\":\"string\"}", context.ConfigDefinition);
        Assert.Null(context.OutputDefinition);
    }

    [Fact]
    public void MarkHealthyIsIdempotent()
    {
        var context = new ProcessorContext();

        context.MarkHealthy();
        context.MarkHealthy();

        Assert.True(context.IsHealthy);
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj --filter-class "*ProcessorContextTests"`
Expected: FAIL — `BaseProcessor.Core` does not exist.

- [ ] **Step 3: Create the project**

`src/BaseProcessor.Core/BaseProcessor.Core.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <ItemGroup>
    <PackageReference Include="Microsoft.Extensions.Hosting" />
    <PackageReference Include="StackExchange.Redis" />
    <PackageReference Include="JsonSchema.Net" />
    <ProjectReference Include="..\BaseConsole.Core\BaseConsole.Core.csproj" />
    <ProjectReference Include="..\Messaging.Contracts\Messaging.Contracts.csproj" />
    <ProjectReference Include="..\Messaging.Transport\Messaging.Transport.csproj" />
  </ItemGroup>

</Project>
```

Run `dotnet sln SK_P.sln add src/BaseProcessor.Core/BaseProcessor.Core.csproj`.

- [ ] **Step 4: Port identity, preserving the WR-03 invariant**

Copy these four files from `references/src/BaseProcessor.Core/Identity/` verbatim, changing only the namespace:

- `ISourceHashProvider.cs`
- `AssemblyMetadataSourceHashProvider.cs`
- `IProcessorContext.cs` — **keep the WR-03 doc block exactly as written.** It states that only `IsHealthy`/`WhenHealthy` carry synchronization and that the nine identity/definition properties are safe to read cross-thread only after observing `IsHealthy`, published by the barrier in `MarkHealthy`. This plan's design keeps that true by making the loop the sole writer; the comment is the contract.
- `ProcessorContext.cs`

Delete the `WhenHealthy` / `TaskCompletionSource` member and its interface declaration: it exists for dispatch consumers awaiting readiness, and there are none in this slice. Keep the `Volatile.Read` / `Interlocked.Exchange` int-latch backing `IsHealthy` — that barrier is what publishes the plain property writes.

- [ ] **Step 5: Copy the build-time identity targets**

Copy `references/src/BaseProcessor.Core/SourceHash.targets` to `src/BaseProcessor.Core/SourceHash.targets` verbatim. It computes a reproducible SHA-256 over the implementation `.cs` of `BaseProcessor.Core` plus the importing concrete and emits `[assembly: AssemblyMetadata("SourceHash", "<64-hex>")]` on the entry assembly. Do not import it from `BaseProcessor.Core.csproj` — it must never be self-applied; concretes import it explicitly (Task 11).

- [ ] **Step 6: Run the tests**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj --filter-class "*ProcessorContextTests"`
Expected: PASS, 4 tests.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add BaseProcessor.Core identity and source-hash provider"
```

---

### Task 7: Liveness writer

**Files:**
- Create: `src/BaseProcessor.Core/Configuration/ProcessorLivenessOptions.cs`
- Create: `src/BaseProcessor.Core/Liveness/ProcessorLivenessWriter.cs`
- Test: `src/tests/BaseApi.Tests/Processor/LivenessEntryTests.cs`

**Interfaces:**
- Consumes: `L2ProjectionKeys.PerInstance(Guid, string)`, `L2ProjectionKeys.InstanceIndex(Guid)`, `ProcessorLivenessEntry.Create(string?, string?, string?, DateTime, int)`, `LivenessStatus`, `SchemaOutcome` — all already in `Messaging.Contracts`.
- Produces: `ProcessorLivenessOptions` (`IntervalSeconds` = 10, `TtlSeconds` = 30, `RequestTimeoutSeconds` = 8); `ProcessorLivenessWriter.WriteAsync(Guid processorId, string instanceId, ProcessorLivenessEntry entry)`.

- [ ] **Step 1: Write the failing tests**

Create `src/tests/BaseApi.Tests/Processor/LivenessEntryTests.cs`. These pin the invariant the writer depends on:

```csharp
using BaseProcessor.Core.Liveness;
using Messaging.Contracts.Projections;
using Xunit;

namespace BaseApi.Tests.Processor;

public sealed class LivenessEntryTests
{
    [Fact]
    public void AllOutcomesSuccessYieldsHealthy()
    {
        var entry = ProcessorLivenessEntry.Create(
            SchemaOutcome.Success, SchemaOutcome.Success, SchemaOutcome.Success,
            DateTime.UtcNow, interval: 10);

        Assert.Equal(LivenessStatus.Healthy, entry.Status);
    }

    [Fact]
    public void NullOutcomeCountsAsSuccess()
    {
        var entry = ProcessorLivenessEntry.Create(null, null, null, DateTime.UtcNow, interval: 10);

        Assert.Equal(LivenessStatus.Healthy, entry.Status);
        Assert.Equal(SchemaOutcome.Success, entry.Summary.ConfigSchema);
    }

    [Fact]
    public void AnyFailYieldsUnhealthy()
    {
        var entry = ProcessorLivenessEntry.Create(
            SchemaOutcome.Success, SchemaOutcome.Success, SchemaOutcome.Fail,
            DateTime.UtcNow, interval: 10);

        Assert.Equal(LivenessStatus.Unhealthy, entry.Status);
    }

    [Theory]
    [InlineData(10, 30, 30)]   // floor wins
    [InlineData(30, 30, 60)]   // interval * 2 wins
    public void TtlIsIntervalTimesTwoOrTheFloor(int interval, int floor, int expected) =>
        Assert.Equal(expected, ProcessorLivenessWriter.DeriveTtlSeconds(interval, floor));
}
```

Check `LivenessSummary`'s property name for the config outcome before writing the second test; use whatever `Messaging.Contracts.Projections.LivenessSummary` actually declares.

- [ ] **Step 2: Run to verify failure**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj --filter-class "*LivenessEntryTests"`
Expected: FAIL — `ProcessorLivenessWriter` not defined.

- [ ] **Step 3: Implement the options**

Copy `references/src/BaseProcessor.Core/Configuration/ProcessorLivenessOptions.cs`, keeping only `IntervalSeconds`, `TtlSeconds`, and `RequestTimeoutSeconds` with their `[ConfigurationKeyName]` attributes. Drop `StartupIntervalSeconds`, `BackoffCapSeconds`, and `ExecutionDataTtlSeconds` — this slice has one cadence and no dispatch.

- [ ] **Step 4: Implement the writer**

`src/BaseProcessor.Core/Liveness/ProcessorLivenessWriter.cs`:

```csharp
using Messaging.Contracts.Projections;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using StackExchange.Redis;

namespace BaseProcessor.Core.Liveness;

/// <summary>
/// Writes the per-instance liveness key and keeps the instance index current.
/// <para>
/// A Redis fault is logged and swallowed. The caller is a loop whose next iteration will write
/// again, and a write failure must never end it.
/// </para>
/// </summary>
public sealed class ProcessorLivenessWriter
{
    private readonly IConnectionMultiplexer _redis;
    private readonly ProcessorLivenessOptions _options;
    private readonly ILogger<ProcessorLivenessWriter> _logger;

    public ProcessorLivenessWriter(
        IConnectionMultiplexer redis,
        IOptions<ProcessorLivenessOptions> options,
        ILogger<ProcessorLivenessWriter> logger)
    {
        _redis   = redis ?? throw new ArgumentNullException(nameof(redis));
        _options = options?.Value ?? throw new ArgumentNullException(nameof(options));
        _logger  = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    /// <summary>TTL is twice the recorded interval, floored — a slow cadence must not expire itself.</summary>
    public static int DeriveTtlSeconds(int interval, int floor) => Math.Max(interval * 2, floor);

    public async Task WriteAsync(Guid processorId, string instanceId, ProcessorLivenessEntry entry)
    {
        ArgumentNullException.ThrowIfNull(entry);
        try
        {
            var db = _redis.GetDatabase();
            var ttl = TimeSpan.FromSeconds(DeriveTtlSeconds(entry.Interval, _options.TtlSeconds));

            await db.StringSetAsync(
                L2ProjectionKeys.PerInstance(processorId, instanceId),
                System.Text.Json.JsonSerializer.Serialize(entry),
                ttl).ConfigureAwait(false);

            await db.SetAddAsync(
                L2ProjectionKeys.InstanceIndex(processorId), instanceId).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "liveness write failed for {ProcessorId}/{InstanceId}", processorId, instanceId);
        }
    }
}
```

- [ ] **Step 5: Run the tests**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj --filter-class "*LivenessEntryTests"`
Expected: PASS, 5 tests (3 facts + 2 theory cases).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add processor liveness writer"
```

---

### Task 8: Gate A — config schema coverage

**Files:**
- Create: `src/BaseProcessor.Core/Configuration/ProcessorConfig.cs`
- Create: `src/BaseProcessor.Core/Configuration/IConfigTypeProvider.cs`
- Create: `src/BaseProcessor.Core/Configuration/ConfigTypeProvider.cs`
- Create: `src/BaseProcessor.Core/Configuration/ConfigSchemaCoverageCheck.cs`
- Test: `src/tests/BaseApi.Tests/Processor/ConfigSchemaCoverageTests.cs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `abstract record ProcessorConfig` with `static readonly JsonSerializerOptions SerializerOptions`; `IConfigTypeProvider.Get()`; `ConfigTypeProvider<TConfig> : IConfigTypeProvider`; `ConfigSchemaCoverageCheck.Evaluate(string? configDefinition, Type configType)` returning `(bool Covered, string? ClashDetail)`.

- [ ] **Step 1: Write the failing tests**

Create `src/tests/BaseApi.Tests/Processor/ConfigSchemaCoverageTests.cs`:

```csharp
using BaseProcessor.Core.Configuration;
using Xunit;

namespace BaseApi.Tests.Processor;

public sealed record TestConfig(int Number, string? Label) : ProcessorConfig;

public sealed class ConfigSchemaCoverageTests
{
    [Fact]
    public void NullDefinitionIsCovered()
    {
        var (covered, clash) = ConfigSchemaCoverageCheck.Evaluate(null, typeof(TestConfig));

        Assert.True(covered);
        Assert.Null(clash);
    }

    [Fact]
    public void MatchingSchemaIsCovered()
    {
        const string schema = """
        {"type":"object","properties":{"Number":{"type":"integer"},"Label":{"type":"string"}}}
        """;

        var (covered, _) = ConfigSchemaCoverageCheck.Evaluate(schema, typeof(TestConfig));

        Assert.True(covered);
    }

    [Fact]
    public void TypeClashIsReportedWithDetail()
    {
        const string schema = """
        {"type":"object","properties":{"Number":{"type":"string"},"Label":{"type":"string"}}}
        """;

        var (covered, clash) = ConfigSchemaCoverageCheck.Evaluate(schema, typeof(TestConfig));

        Assert.False(covered);
        Assert.NotNull(clash);
        Assert.Contains("Number", clash, StringComparison.Ordinal);
    }

    [Fact]
    public void ProviderReturnsTheConfiguredType() =>
        Assert.Equal(typeof(TestConfig), new ConfigTypeProvider<TestConfig>().Get());
}
```

- [ ] **Step 2: Run to verify failure**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj --filter-class "*ConfigSchemaCoverageTests"`
Expected: FAIL — `ConfigSchemaCoverageCheck` not defined.

- [ ] **Step 3: Port the coverage check**

Copy `references/src/BaseProcessor.Core/Configuration/ConfigSchemaCoverageCheck.cs` verbatim, changing only the namespace. It is roughly 430 lines of schema-vs-type walking built on `JsonSchema.Net`; do not rewrite it. Its entry point stays `public static (bool Covered, string? ClashDetail) Evaluate(string? configDefinition, Type configType)`.

Copy `Configuration/ProcessorConfig.cs` verbatim (the abstract record plus `SerializerOptions` with `PropertyNameCaseInsensitive = true`), and `Configuration/IConfigTypeProvider.cs`, dropping its `using BaseProcessor.Core.Processing;`.

- [ ] **Step 4: Implement the replacement config-type provider**

`references`' `BaseProcessorConfigTypeProvider` reflects over a registered `BaseProcessor` to discover `TConfig`. There is no `BaseProcessor` in this slice, so state the type directly:

```csharp
namespace BaseProcessor.Core.Configuration;

/// <summary>
/// Supplies the concrete config type Gate A checks the fetched schema against. The concrete console
/// names its own type at registration; nothing needs to be reflected out of a processor that does
/// not exist until dispatch lands.
/// </summary>
public sealed class ConfigTypeProvider<TConfig> : IConfigTypeProvider
    where TConfig : ProcessorConfig
{
    public Type Get() => typeof(TConfig);
}
```

- [ ] **Step 5: Run the tests**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj --filter-class "*ConfigSchemaCoverageTests"`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add Gate A config schema coverage check"
```

---

### Task 9: The discovery loop

This is the task the whole slice exists for. It is one `BackgroundService` implementing Loop A, Loop B, Gate A, and the steady state — and it is the sole writer of `IProcessorContext`.

**Files:**
- Create: `src/BaseProcessor.Core/Discovery/DiscoveryState.cs`
- Create: `src/BaseProcessor.Core/Discovery/ProcessorDiscoveryLoop.cs`
- Test: `src/tests/BaseApi.Tests/Processor/DiscoveryStateTests.cs`

**Interfaces:**
- Consumes: `ILoopHeartbeat`, `ConsoleLoopOptions`, `ReplySlot<object>`, `ReplyQueueConsumer`, `IQueueSender`, `IProcessorContext`, `ISourceHashProvider`, `IConfigTypeProvider`, `ProcessorLivenessWriter`, `ProcessorLivenessOptions`, `IStartupGate`.
- Produces: `enum DiscoveryPhase { Identity, Schemas, Gate, Steady, Terminal }`; `DiscoveryState.Next(...)`; `ProcessorDiscoveryLoop : BackgroundService`.

The phase decision is pulled out into a pure function so the ordering rules are testable without a broker, a clock, or Redis.

- [ ] **Step 1: Write the failing tests**

Create `src/tests/BaseApi.Tests/Processor/DiscoveryStateTests.cs`:

```csharp
using BaseProcessor.Core.Discovery;
using Xunit;

namespace BaseApi.Tests.Processor;

public sealed class DiscoveryStateTests
{
    [Fact]
    public void WithoutIdentityThePhaseIsIdentity() =>
        Assert.Equal(DiscoveryPhase.Identity, DiscoveryState.Next(
            hasIdentity: false, unresolvedSchemas: 0, gateEvaluated: false, gateCovered: false));

    [Fact]
    public void IdentityWithOutstandingSchemasMovesToSchemas() =>
        Assert.Equal(DiscoveryPhase.Schemas, DiscoveryState.Next(
            hasIdentity: true, unresolvedSchemas: 2, gateEvaluated: false, gateCovered: false));

    [Fact]
    public void AllSchemasResolvedMovesToGate() =>
        Assert.Equal(DiscoveryPhase.Gate, DiscoveryState.Next(
            hasIdentity: true, unresolvedSchemas: 0, gateEvaluated: false, gateCovered: false));

    [Fact]
    public void GatePassMovesToSteady() =>
        Assert.Equal(DiscoveryPhase.Steady, DiscoveryState.Next(
            hasIdentity: true, unresolvedSchemas: 0, gateEvaluated: true, gateCovered: true));

    [Fact]
    public void GateClashIsTerminal() =>
        Assert.Equal(DiscoveryPhase.Terminal, DiscoveryState.Next(
            hasIdentity: true, unresolvedSchemas: 0, gateEvaluated: true, gateCovered: false));
}
```

- [ ] **Step 2: Run to verify failure**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj --filter-class "*DiscoveryStateTests"`
Expected: FAIL — `DiscoveryState` not defined.

- [ ] **Step 3: Implement the phase function**

`src/BaseProcessor.Core/Discovery/DiscoveryState.cs`:

```csharp
namespace BaseProcessor.Core.Discovery;

public enum DiscoveryPhase
{
    /// <summary>No identity yet — ask, and write nothing to L2 (the key needs a processor id).</summary>
    Identity,

    /// <summary>Identity known, definitions outstanding — ask for the next one.</summary>
    Schemas,

    /// <summary>Everything resolved — evaluate config coverage.</summary>
    Gate,

    /// <summary>Gate passed — refresh the healthy entry forever.</summary>
    Steady,

    /// <summary>Gate clashed — stay up, never serve, refresh the unhealthy entry forever.</summary>
    Terminal,
}

public static class DiscoveryState
{
    public static DiscoveryPhase Next(
        bool hasIdentity, int unresolvedSchemas, bool gateEvaluated, bool gateCovered)
    {
        if (!hasIdentity) return DiscoveryPhase.Identity;
        if (unresolvedSchemas > 0) return DiscoveryPhase.Schemas;
        if (!gateEvaluated) return DiscoveryPhase.Gate;
        return gateCovered ? DiscoveryPhase.Steady : DiscoveryPhase.Terminal;
    }
}
```

- [ ] **Step 4: Run the phase tests**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj --filter-class "*DiscoveryStateTests"`
Expected: PASS, 5 tests.

- [ ] **Step 5: Implement the loop**

`src/BaseProcessor.Core/Discovery/ProcessorDiscoveryLoop.cs`:

```csharp
using BaseConsole.Core.Health;
using BaseConsole.Core.Loop;
using BaseConsole.Core.Messaging;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Identity;
using BaseProcessor.Core.Liveness;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Messaging.Transport;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace BaseProcessor.Core.Discovery;

/// <summary>
/// The processor's one background loop. It stamps liveness, asks BaseApi for whatever it still
/// needs, applies the answers the reply consumer has handed it, and writes the L2 entry.
/// <para>
/// <b>This is the sole writer of <see cref="IProcessorContext"/>.</b> The reply consumer only parks
/// payloads in the slot, so every mutation happens here, on one thread, in a fixed order — which is
/// what keeps the WR-03 memory-visibility invariant true now that no request client applies replies
/// inline.
/// </para>
/// <para>
/// <b>Nothing is written to L2 before identity resolves</b>, because the key is built from the
/// processor id. Until then the replica is genuinely absent, and the start gate reads it as such.
/// </para>
/// </summary>
public sealed class ProcessorDiscoveryLoop : BackgroundService
{
    private readonly ILoopHeartbeat _heartbeat;
    private readonly ReplySlot<object> _slot;
    private readonly ReplyQueueConsumer _replies;
    private readonly IQueueSender _sender;
    private readonly IProcessorContext _context;
    private readonly ISourceHashProvider _sourceHash;
    private readonly IConfigTypeProvider _configType;
    private readonly ProcessorLivenessWriter _writer;
    private readonly ProcessorLivenessOptions _liveness;
    private readonly ConsoleLoopOptions _loop;
    private readonly IStartupGate _gate;
    private readonly string _instanceId;
    private readonly ILogger<ProcessorDiscoveryLoop> _logger;

    private bool _gateEvaluated;
    private bool _gateCovered;

    public ProcessorDiscoveryLoop(
        ILoopHeartbeat heartbeat,
        ReplySlot<object> slot,
        ReplyQueueConsumer replies,
        IQueueSender sender,
        IProcessorContext context,
        ISourceHashProvider sourceHash,
        IConfigTypeProvider configType,
        ProcessorLivenessWriter writer,
        IOptions<ProcessorLivenessOptions> liveness,
        IOptions<ConsoleLoopOptions> loop,
        IStartupGate gate,
        string instanceId,
        ILogger<ProcessorDiscoveryLoop> logger)
    {
        _heartbeat  = heartbeat ?? throw new ArgumentNullException(nameof(heartbeat));
        _slot       = slot ?? throw new ArgumentNullException(nameof(slot));
        _replies    = replies ?? throw new ArgumentNullException(nameof(replies));
        _sender     = sender ?? throw new ArgumentNullException(nameof(sender));
        _context    = context ?? throw new ArgumentNullException(nameof(context));
        _sourceHash = sourceHash ?? throw new ArgumentNullException(nameof(sourceHash));
        _configType = configType ?? throw new ArgumentNullException(nameof(configType));
        _writer     = writer ?? throw new ArgumentNullException(nameof(writer));
        _liveness   = liveness?.Value ?? throw new ArgumentNullException(nameof(liveness));
        _loop       = loop?.Value ?? throw new ArgumentNullException(nameof(loop));
        _gate       = gate ?? throw new ArgumentNullException(nameof(gate));
        _logger     = logger ?? throw new ArgumentNullException(nameof(logger));
        ArgumentException.ThrowIfNullOrWhiteSpace(instanceId);
        _instanceId = instanceId;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Bind before asking: an answer that arrives with no listener is simply gone.
        await _replies.StartAsync(stoppingToken).ConfigureAwait(false);
        await Task.Delay(_loop.GracePeriod, stoppingToken).ConfigureAwait(false);

        while (!stoppingToken.IsCancellationRequested)
        {
            _heartbeat.Beat();            // first, before any I/O, unconditionally
            _gate.MarkReady();            // one-way latch: no crash-loop while discovery resolves

            try
            {
                Apply(_slot.Take());
                await StepAsync(stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "discovery iteration failed; continuing");
            }

            await _slot.WaitAsync(_loop.Interval, stoppingToken).ConfigureAwait(false);
        }
    }

    /// <summary>Applies a reply the consumer parked. Only this method mutates the context.</summary>
    private void Apply(object? reply)
    {
        switch (reply)
        {
            case ProcessorIdentityFound found:
                _context.SetIdentity(found);
                _logger.LogInformation("identity resolved: processor {ProcessorId}", found.Id);
                break;

            case ProcessorIdentityNotFound notFound:
                _logger.LogInformation(
                    "API is reachable but has no processor registered for hash {Hash}; will retry",
                    notFound.SourceHash);
                break;

            case SchemaDefinitionFound schema:
                foreach (var id in OutstandingSchemaIds())
                {
                    _context.SetDefinition(id, schema.Definition);
                    break;   // one outstanding ask at a time
                }
                break;

            case SchemaDefinitionNotFound missing:
                _logger.LogInformation("schema {SchemaId} not yet available; will retry", missing.SchemaId);
                break;

            case null:
                break;
        }
    }

    private async Task StepAsync(CancellationToken ct)
    {
        var phase = DiscoveryState.Next(
            _context.Id is not null, OutstandingSchemaIds().Count(), _gateEvaluated, _gateCovered);

        switch (phase)
        {
            case DiscoveryPhase.Identity:
                await SendAsync(
                    ProcessorQueues.IdentityQuery,
                    MessageTypes.GetProcessorBySourceHash,
                    new GetProcessorBySourceHash(_sourceHash.Get()), ct).ConfigureAwait(false);
                return;   // nothing to write: no id, no key

            case DiscoveryPhase.Schemas:
                await WriteAsync(unhealthy: true, configOutcome: null).ConfigureAwait(false);
                var next = OutstandingSchemaIds().First();
                await SendAsync(
                    ProcessorQueues.SchemaQuery,
                    MessageTypes.GetSchemaDefinition,
                    new GetSchemaDefinition(next), ct).ConfigureAwait(false);
                return;

            case DiscoveryPhase.Gate:
                var (covered, clash) = ConfigSchemaCoverageCheck.Evaluate(
                    _context.ConfigDefinition, _configType.Get());
                _gateEvaluated = true;
                _gateCovered = covered;

                if (!covered)
                {
                    _logger.LogError(
                        "Gate A incompatibility for processor {ProcessorId} config schema {ConfigSchemaId}: {Clash}",
                        _context.Id, _context.ConfigSchemaId, clash);
                    await WriteAsync(unhealthy: true, configOutcome: SchemaOutcome.Fail).ConfigureAwait(false);
                    return;
                }

                _context.MarkHealthy();
                await WriteAsync(unhealthy: false, configOutcome: null).ConfigureAwait(false);
                _logger.LogInformation("processor {ProcessorId} reached Healthy", _context.Id);
                return;

            case DiscoveryPhase.Steady:
                await WriteAsync(unhealthy: false, configOutcome: null).ConfigureAwait(false);
                return;

            case DiscoveryPhase.Terminal:
                // Stay up, never serve, never re-evaluate. Only the timestamp refreshes, so the key
                // stays present and Unhealthy rather than expiring into absent.
                await WriteAsync(unhealthy: true, configOutcome: SchemaOutcome.Fail).ConfigureAwait(false);
                return;
        }
    }

    private IEnumerable<Guid> OutstandingSchemaIds()
    {
        if (_context.InputSchemaId is { } input && _context.InputDefinition is null) yield return input;
        if (_context.OutputSchemaId is { } output && _context.OutputDefinition is null) yield return output;
        if (_context.ConfigSchemaId is { } config && _context.ConfigDefinition is null) yield return config;
    }

    private async Task SendAsync<T>(string queue, string type, T body, CancellationToken ct)
    {
        try
        {
            await _sender.SendAsync(queue, type, body, ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            // The next tick asks again; a send failure costs one interval and never ends the loop.
            _logger.LogWarning(ex, "ask on {Queue} failed; retrying next tick", queue);
        }
    }

    private async Task WriteAsync(bool unhealthy, string? configOutcome)
    {
        if (_context.Id is not { } id)
        {
            return;
        }

        var outcome = unhealthy ? SchemaOutcome.Fail : SchemaOutcome.Success;
        var entry = ProcessorLivenessEntry.Create(
            inputOutcome:  configOutcome is null ? outcome : SchemaOutcome.Success,
            outputOutcome: configOutcome is null ? outcome : SchemaOutcome.Success,
            configOutcome: configOutcome ?? outcome,
            timestamp: DateTime.UtcNow,
            interval: _liveness.IntervalSeconds);

        await _writer.WriteAsync(id, _instanceId, entry).ConfigureAwait(false);
    }
}
```

The `ReplyTo` header is not set by `IQueueSender`. Extend `IQueueSender` with an optional `string? replyTo = null` parameter and pass it through to `BasicProperties.ReplyTo` in `QueueSender`; existing callers are unaffected by the default. Pass `_replies.QueueName` from both `SendAsync` call sites above.

- [ ] **Step 6: Run the full suite**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: PASS, all tests.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add processor discovery loop with Gate A and liveness writes"
```

---

### Task 10: Console health endpoints

**Files:**
- Create: `src/BaseConsole.Core/Health/EmbeddedHealthEndpointService.cs`
- Create: `src/BaseConsole.Core/Health/IdentityReadyHealthCheck.cs`
- Create: `src/BaseConsole.Core/DependencyInjection/BaseConsoleServiceCollectionExtensions.cs`
- Test: `src/tests/BaseApi.Tests/Console/IdentityReadyHealthCheckTests.cs`

**Interfaces:**
- Consumes: `IStartupGate`, `ILoopHeartbeat`, `LoopLivenessHealthCheck`, `IProcessorContext`.
- Produces: `AddBaseConsoleHealth(IServiceCollection, IConfiguration)`; endpoints `/health/live`, `/health/ready`, `/health/startup` on `ConsoleHealth:Port` (default 8081).

- [ ] **Step 1: Write the failing test**

Create `src/tests/BaseApi.Tests/Console/IdentityReadyHealthCheckTests.cs`:

```csharp
using BaseConsole.Core.Health;
using BaseProcessor.Core.Identity;
using Messaging.Contracts;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Xunit;

namespace BaseApi.Tests.Console;

public sealed class IdentityReadyHealthCheckTests
{
    [Fact]
    public async Task UnhealthyBeforeIdentityResolves()
    {
        var result = await new IdentityReadyHealthCheck(new ProcessorContext())
            .CheckHealthAsync(new HealthCheckContext(), TestContext.Current.CancellationToken);

        Assert.Equal(HealthStatus.Unhealthy, result.Status);
    }

    [Fact]
    public async Task HealthyOnceMarkedHealthy()
    {
        var context = new ProcessorContext();
        context.SetIdentity(new ProcessorIdentityFound(Guid.NewGuid(), null, null, null, "s", "1"));
        context.MarkHealthy();

        var result = await new IdentityReadyHealthCheck(context)
            .CheckHealthAsync(new HealthCheckContext(), TestContext.Current.CancellationToken);

        Assert.Equal(HealthStatus.Healthy, result.Status);
    }
}
```

`IdentityReadyHealthCheck` takes `IProcessorContext`, so `BaseConsole.Core` would have to reference `BaseProcessor.Core` — the wrong direction. Put the check in `BaseProcessor.Core/Liveness/IdentityReadyHealthCheck.cs` instead and adjust the test's `using`.

- [ ] **Step 2: Run to verify failure**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj --filter-class "*IdentityReadyHealthCheckTests"`
Expected: FAIL — `IdentityReadyHealthCheck` not defined.

- [ ] **Step 3: Implement the readiness check**

```csharp
using BaseProcessor.Core.Identity;
using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace BaseProcessor.Core.Liveness;

/// <summary>
/// Readiness is identity plus schemas plus a passed Gate A — exactly what <c>IsHealthy</c> means.
/// Unlatched on purpose: it reports the live state rather than a one-way flag.
/// </summary>
public sealed class IdentityReadyHealthCheck : IHealthCheck
{
    private readonly IProcessorContext _context;

    public IdentityReadyHealthCheck(IProcessorContext context)
        => _context = context ?? throw new ArgumentNullException(nameof(context));

    public Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context, CancellationToken cancellationToken = default)
        => Task.FromResult(_context.IsHealthy
            ? HealthCheckResult.Healthy("identity and schemas resolved")
            : HealthCheckResult.Unhealthy("identity or schemas unresolved"));
}
```

- [ ] **Step 4: Implement the endpoint host**

Port `references/src/BaseConsole.Core/Health/EmbeddedHealthEndpointService.cs`, keeping its port convention (`ConsoleHealth:Port`, default 8081) and its bind-failure isolation, and mapping exactly three endpoints filtered by tag: `/health/live` → the `live` tag (`LoopLivenessHealthCheck`), `/health/ready` → the `ready` tag (`IdentityReadyHealthCheck`), `/health/startup` → the `startup` tag (a check reading `IStartupGate.IsReady`).

- [ ] **Step 5: Run the tests**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj --filter-class "*IdentityReadyHealthCheckTests"`
Expected: PASS, 2 tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add console health endpoints and readiness check"
```

---

### Task 11: Processor.Sample and wire-up

**Files:**
- Create: `src/Processor.Sample/Processor.Sample.csproj`
- Create: `src/Processor.Sample/Program.cs`
- Create: `src/Processor.Sample/SampleConfig.cs`
- Create: `src/BaseProcessor.Core/DependencyInjection/BaseProcessorServiceCollectionExtensions.cs`
- Modify: `SK_P.sln`

**Interfaces:**
- Consumes: everything from Tasks 2–10.
- Produces: `AddBaseProcessor<TConfig>(IServiceCollection, IConfiguration)` registering the context, hash provider, config-type provider, liveness writer, reply slot, reply consumer, sender, health checks, and the discovery loop as the single hosted service.

- [ ] **Step 1: Write the registration extension**

```csharp
using BaseConsole.Core.Loop;
using BaseConsole.Core.Messaging;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Discovery;
using BaseProcessor.Core.Identity;
using BaseProcessor.Core.Liveness;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace BaseProcessor.Core.DependencyInjection;

public static class BaseProcessorServiceCollectionExtensions
{
    /// <summary>
    /// Folds the whole processor stack: identity, liveness, discovery, health. The concrete console
    /// names its config type and nothing else.
    /// </summary>
    public static IServiceCollection AddBaseProcessor<TConfig>(
        this IServiceCollection services, IConfiguration cfg)
        where TConfig : ProcessorConfig
    {
        services.Configure<ProcessorLivenessOptions>(cfg.GetSection("ProcessorLiveness"));
        services.Configure<ConsoleLoopOptions>(cfg.GetSection("ConsoleLoop"));

        services.TryAddSingleton(TimeProvider.System);
        services.TryAddSingleton<ILoopHeartbeat, LoopHeartbeat>();
        services.TryAddSingleton<IProcessorContext, ProcessorContext>();
        services.TryAddSingleton<ISourceHashProvider, AssemblyMetadataSourceHashProvider>();
        services.TryAddSingleton<IConfigTypeProvider, ConfigTypeProvider<TConfig>>();
        services.TryAddSingleton<ProcessorLivenessWriter>();
        services.TryAddSingleton<ReplySlot<object>>();

        services.AddHostedService<ProcessorDiscoveryLoop>();
        return services;
    }
}
```

`instanceId` comes from the pod name. Register it as a keyed string or wrap it in a small `InstanceId` record resolved from `Environment.GetEnvironmentVariable("POD_NAME") ?? Environment.MachineName`, and inject that instead of the raw `string` parameters shown in Tasks 5 and 9 — DI cannot resolve a bare `string`.

- [ ] **Step 2: Write the sample config and shell**

`src/Processor.Sample/SampleConfig.cs`:

```csharp
using BaseProcessor.Core.Configuration;

namespace Processor.Sample;

public sealed record SampleConfig(int Number, string? Label) : ProcessorConfig;
```

`src/Processor.Sample/Program.cs`:

```csharp
using BaseProcessor.Core.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Processor.Sample;

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddBaseProcessor<SampleConfig>(builder.Configuration);

var host = builder.Build();
await host.RunAsync();
```

- [ ] **Step 3: Write the project file with the explicit targets import**

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <OutputType>Exe</OutputType>
  </PropertyGroup>

  <ItemGroup>
    <ProjectReference Include="..\BaseProcessor.Core\BaseProcessor.Core.csproj" />
    <ProjectReference Include="..\Messaging.Contracts\Messaging.Contracts.csproj" />
  </ItemGroup>

  <!-- A ProjectReference does NOT auto-flow build/*.targets, hence the explicit import. The
       attribute must land on this concrete assembly, never on BaseProcessor.Core. -->
  <Import Project="..\BaseProcessor.Core\SourceHash.targets" />

</Project>
```

- [ ] **Step 4: Build and confirm the hash is embedded**

Run: `dotnet sln SK_P.sln add src/Processor.Sample/Processor.Sample.csproj && dotnet build SK_P.sln -c Debug`
Expected: 0 warnings, 0 errors, and a line reading `SourceHash (Processor.Sample): <64 hex chars>`. If that line is absent, `AssemblyMetadataSourceHashProvider` will throw at startup.

- [ ] **Step 5: Run the whole suite**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: PASS, all tests.

- [ ] **Step 6: Manual acceptance against the cluster**

The `skp` namespace currently runs infrastructure only — postgres, redis, rabbitmq, elasticsearch, otel, prometheus, grafana — with every queue and every `skp:` Redis key cleared. Port-forwards needed: postgres `5433`, redis `6380`, rabbitmq `5673`.

1. Start BaseApi locally with `ConnectionStrings__Postgres`, `ConnectionStrings__Redis`, `RabbitMq__Host/Port/Username/Password`, `Service__Name`, `Service__Version`. Confirm the log lines `serving queries on processor-identity-query` and `serving queries on schema-definition-query`.
2. Start `Processor.Sample` with the same broker and Redis settings. Expect a log line reporting no processor registered for its hash, repeating each interval, and **no** `skp:proc:*` key — the pre-identity gap.
3. Insert a `processors` row whose `source_hash` equals the hash printed at build time. Within one interval expect `identity resolved`, then a `skp:proc:{id}:{instance}` key appearing as `Unhealthy`, then `Healthy` once Gate A passes (the sample has no config schema, so coverage is skipped).
4. Confirm `/health/live` is green throughout, including before identity resolved.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add Processor.Sample console with discovery wire-up"
```

---

## Self-Review Notes

**Spec coverage.** §4 startup sequence → Task 9. §5 transport → Tasks 2, 5, 9. §6 loop design → Tasks 3, 4, 9. §7 state ownership → Tasks 4, 5, 9. §8 L2 liveness → Tasks 7, 9. §9 Gate A → Tasks 8, 9. §10 metrics → **not covered by a task**; deferring metric labels until discovery completes needs an observability extension that this slice does not otherwise build, and no console observability code is ported. Treat it as a follow-up, or add it once the metric surface exists. §11 failure policy → Tasks 5, 7, 9. §12 health endpoints → Task 10. §13 testing → Task 1 plus tests in every task.

**Two spec corrections** are recorded in the Scope Notes: `SampleProcessor.cs` cannot port without dispatch, and `BaseProcessorConfigTypeProvider` is replaced by `ConfigTypeProvider<TConfig>`.

**Known rough edges to settle during execution.** `Apply` matches a `SchemaDefinitionFound` to the first outstanding schema id, which is only correct because exactly one schema ask is in flight per tick — if that ever changes, the reply needs to carry its schema id. `IQueueSender` gains an optional `replyTo` parameter in Task 9; if you would rather not touch the shared interface, add a `SendWithReplyToAsync` to `Messaging.Transport` instead.
