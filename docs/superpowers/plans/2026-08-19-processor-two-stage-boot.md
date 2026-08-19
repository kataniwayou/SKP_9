# Processor Two-Stage Boot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve a processor's database identity before the host is built, so `ProcessorId`, `service.name` and `service.version` ride the OpenTelemetry resource on both logs and metrics instead of being unavailable or riding per-record.

**Architecture:** A Stage 0 probe listener keeps `/health/startup` and `/health/live` green while a Stage 1 broker round-trip resolves identity with unbounded retry. Stage 2 stops the listener, wires observability with the resolved identity, and builds the host with `IProcessorContext` pre-seeded. `ProcessorStartupOrchestrator` loses Loop A and keeps Loop B.

**Tech Stack:** .NET 8, OpenTelemetry 1.15.3, RabbitMQ.Client, StackExchange.Redis, xUnit v3 under Microsoft.Testing.Platform, kind cluster `desktop` namespace `skp`.

**Spec:** `docs/superpowers/specs/2026-08-19-processor-two-stage-boot-design.md`

## Global Constraints

- Target framework `net8.0`. Central package management — never put a `Version` on a `PackageReference`; add pins to `Directory.Packages.props`.
- No new NuGet packages. Everything needed is already referenced.
- `BaseConsole.Core` must not reference `BaseApi.Core`. `TransportDependencyFirewallTests` enforces the transport boundary — run it after any project-reference change.
- Log attributes are PascalCase; metric attributes are camelCase. This convention is stated in both observability extensions and must hold.
- Only `BaseConsole.Core`'s observability extension changes. `BaseApi.Core`'s keeps `AddService(serviceName: $"{name}_{version}")`.
- Comments in this codebase explain *why*, not *what*, and are written in prose. Match that register.
- The full suite must stay green: `dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj`. Baseline before this plan is **135 passed, 0 failed, exit 0**.
- Live tests must **skip by default**. A trait filter alone is not sufficient — `--filter "Category!=RealStack"` is silently ignored under Microsoft.Testing.Platform. Gate on the `SKP_REALSTACK` environment variable inside the test body.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src/BaseConsole.Core/DependencyInjection/ResourceAttribute.cs` | One resource attribute carrying both casings and its value |
| `src/BaseProcessor.Core/Boot/IIdentityBootstrap.cs` | The substitution seam for Stage 1 |
| `src/BaseProcessor.Core/Boot/BrokerIdentityBootstrap.cs` | Stage 1: its own mini container, unbounded ask loop |
| `src/BaseProcessor.Core/Boot/BootProbeListener.cs` | Stage 0: minimal probe surface |
| `src/BaseProcessor.Core/Boot/ProcessorBoot.cs` | Sequences Stage 0 → 1 → 2 |
| `src/tests/BaseApi.Tests/Boot/BootProbeListenerTests.cs` | Stage 0 unit tests |
| `src/tests/BaseApi.Tests/Boot/BrokerIdentityBootstrapTests.cs` | Stage 1 unit tests |
| `src/tests/BaseApi.Tests/Boot/ProcessorBootTests.cs` | Sequencing unit tests |
| `src/tests/BaseApi.Tests/Live/RealStack.cs` | Env gate + endpoint defaults |
| `src/tests/BaseApi.Tests/Live/ResourceReader.cs` | Reads a provider's frozen `Resource` |
| `src/tests/BaseApi.Tests/Live/RealStackFixture.cs` | Registers/removes a processor row over BaseApi REST |
| `src/tests/BaseApi.Tests/Live/IdentityBootstrapLiveTests.cs` | Live discovery round-trip |
| `src/tests/BaseApi.Tests/Live/TwoStageBootLiveTests.cs` | Live boot ordering + resource contents |
| `src/tests/BaseApi.Tests/Live/CollectorLiveTests.cs` | Live: telemetry reaches the collector |
| `k8s/port-forward-realstack.ps1` | Opens the forwards the live tests expect |

**Modified**

| File | Change |
|---|---|
| `src/BaseConsole.Core/DependencyInjection/BaseConsoleObservabilityExtensions.cs` | Accept explicit name/version/attributes; metrics `service.name` = name only |
| `src/BaseProcessor.Core/DependencyInjection/BaseProcessorServiceCollectionExtensions.cs` | `AddBaseProcessor` overload seeding identity |
| `src/BaseProcessor.Core/Startup/ProcessorStartupOrchestrator.cs` | Remove Loop A and `ISourceHashProvider` |
| `src/Processor.Sample/ProcessorHost.cs` | Two-stage entry point |
| `src/Processor.Sample/Program.cs` | Await the async entry point |
| `src/tests/BaseApi.Tests/Processor/ProcessorStartupOrchestratorTests.cs` | Drop identity-resolution tests, seed identity |
| `src/tests/BaseApi.Tests/Sample/ProcessorSampleTests.cs` | Build through the identity-aware overload |
| `src/tests/BaseApi.Tests/Console/ConsoleObservabilityTests.cs` | Cover the new parameters |
| `k8s/33-processor-sample.yaml` | Document `Service:Name` as fallback only |

---

### Task 1: Resource attributes and identity-aware observability

**Files:**
- Create: `src/BaseConsole.Core/DependencyInjection/ResourceAttribute.cs`
- Modify: `src/BaseConsole.Core/DependencyInjection/BaseConsoleObservabilityExtensions.cs`
- Test: `src/tests/BaseApi.Tests/Console/ConsoleObservabilityTests.cs`

**Interfaces:**
- Produces: `BaseConsole.Core.DependencyInjection.ResourceAttribute(string LogKey, string MetricKey, object Value)`
- Produces: `AddBaseConsoleObservability(this IHostApplicationBuilder builder, IConfiguration cfg, string source, string? serviceName = null, string? serviceVersion = null, IEnumerable<ResourceAttribute>? resourceAttributes = null)`

- [ ] **Step 1: Write the failing tests**

Append to `src/tests/BaseApi.Tests/Console/ConsoleObservabilityTests.cs`:

```csharp
    [Fact]
    public void AnExplicitServiceNameDoesNotNeedTheConfigKey()
    {
        // The two-stage boot knows the name from the database row, so requiring Service:Name as well
        // would make config the authority over a value config cannot know.
        var builder = BuilderWith(("Service:Version", "0.0.0"));

        var returned = builder.AddBaseConsoleObservability(
            builder.Configuration, source: "worker",
            serviceName: "sample-proc", serviceVersion: "1.0.0");

        Assert.Same(builder, returned);
    }

    [Fact]
    public void ExplicitIdentityIsUsedEvenWhenConfigDisagrees()
    {
        var builder = BuilderWith(("Service:Name", "processor"), ("Service:Version", "0.0.0"));

        var returned = builder.AddBaseConsoleObservability(
            builder.Configuration, source: "worker",
            serviceName: "sample-proc", serviceVersion: "1.0.0");

        Assert.Same(builder, returned);
    }

    [Fact]
    public void ResourceAttributesCarryBothCasings()
    {
        // One value, two keys: the log and metric conventions differ and a single key would force one
        // signal to break its own convention.
        var attr = new ResourceAttribute("ProcessorId", "processorId", "9e034ca0");

        Assert.Equal("ProcessorId", attr.LogKey);
        Assert.Equal("processorId", attr.MetricKey);
        Assert.Equal("9e034ca0", attr.Value);
    }

    [Fact]
    public void ExtraResourceAttributesAreAccepted()
    {
        var builder = BuilderWith(("Service:Name", "processor"), ("Service:Version", "0.0.0"));

        var returned = builder.AddBaseConsoleObservability(
            builder.Configuration, source: "worker",
            serviceName: "sample-proc", serviceVersion: "1.0.0",
            resourceAttributes: [new ResourceAttribute("ProcessorId", "processorId", "9e034ca0")]);

        Assert.Same(builder, returned);
    }
```

Add `using BaseConsole.Core.DependencyInjection;` to the file's usings if not already present.

- [ ] **Step 2: Run tests to verify they fail**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q --nologo`
Expected: FAIL — `CS0246: The type or namespace name 'ResourceAttribute' could not be found` and `CS1739: The best overload ... does not have a parameter named 'serviceName'`.

- [ ] **Step 3: Create the record**

`src/BaseConsole.Core/DependencyInjection/ResourceAttribute.cs`:

```csharp
namespace BaseConsole.Core.DependencyInjection;

/// <summary>
/// One resource attribute, carried under both signals' key conventions at once.
/// <para>
/// A single key would not do. Logs use PascalCase and metrics camelCase throughout this codebase, so
/// a caller passing one key would silently break whichever convention it did not match — and the
/// break would only surface in a query nobody runs until an incident.
/// </para>
/// </summary>
/// <param name="LogKey">The PascalCase key stamped on the logs resource.</param>
/// <param name="MetricKey">The camelCase key stamped on the metrics resource.</param>
/// <param name="Value">The value, identical under both keys.</param>
public sealed record ResourceAttribute(string LogKey, string MetricKey, object Value);
```

- [ ] **Step 4: Rewrite the observability extension**

Replace the whole `AddBaseConsoleObservability` method in
`src/BaseConsole.Core/DependencyInjection/BaseConsoleObservabilityExtensions.cs`. Keep the existing
`<param name="source">` documentation block unchanged; replace the signature and body:

```csharp
    /// <param name="serviceName">
    /// The resolved role name. Null falls back to <c>Service:Name</c> in configuration.
    /// <para>
    /// A processor passes the name from its database row, resolved before the host was built. That is
    /// the only way it can reach a resource at all: an OTel resource is materialised once when the
    /// provider is built and is immutable thereafter.
    /// </para>
    /// </param>
    /// <param name="serviceVersion">
    /// The resolved version. Null falls back to <c>Service:Version</c> in configuration.
    /// </param>
    /// <param name="resourceAttributes">
    /// Extra attributes stamped on both resources, each under its own signal's casing. This is where
    /// <c>ProcessorId</c> rides: it is the only value that identifies a processor exactly, because
    /// name and version are unconstrained columns and two different builds can share them.
    /// </param>
    public static IHostApplicationBuilder AddBaseConsoleObservability(
        this IHostApplicationBuilder builder,
        IConfiguration cfg,
        string source,
        string? serviceName = null,
        string? serviceVersion = null,
        IEnumerable<ResourceAttribute>? resourceAttributes = null)
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentNullException.ThrowIfNull(cfg);
        ArgumentException.ThrowIfNullOrWhiteSpace(source);

        // Configuration is the fallback, not the authority. A caller that resolved a real identity
        // knows something configuration cannot, so Require is consulted only when it did not.
        var name    = serviceName    ?? cfg.Require("Service:Name");
        var version = serviceVersion ?? cfg.Require("Service:Version");

        // The same replica identity that names this process's liveness key and reply queue. Sharing
        // one resolver is what lets an operator pivot from an L2 key to that pod's records; two
        // independent answers would decouple them.
        var instanceId = InstanceId.Resolve().Value;

        var extra = (resourceAttributes ?? []).ToList();

        // The application type rides on both resources under each signal's own casing convention:
        // PascalCase on logs, camelCase on metrics. It is resource-level, never per record, because
        // it cannot vary within a process — and neither can anything else stamped here, which is why
        // the caller must already know the identity by the time it calls.
        var logAttrs = new List<KeyValuePair<string, object>>
        {
            new("service.instance.id", instanceId),
            new("Source", source),
        };
        logAttrs.AddRange(extra.Select(a => new KeyValuePair<string, object>(a.LogKey, a.Value)));

        var metricAttrs = new List<KeyValuePair<string, object>>
        {
            new("service.instance.id", instanceId),
            new("source", source),
        };
        metricAttrs.AddRange(extra.Select(a => new KeyValuePair<string, object>(a.MetricKey, a.Value)));

        // Logs must go through builder.Logging.AddOpenTelemetry, not the services-side logging
        // registration: the latter creates a parallel provider that bypasses the logging filters.
        builder.Logging.AddOpenTelemetry(o =>
        {
            o.IncludeFormattedMessage = true;
            // Load-bearing: it is what serializes a BeginScope dictionary — the correlation id among
            // them — as telemetry attributes rather than dropping it.
            o.IncludeScopes           = true;
            o.ParseStateValues        = true;
            o.SetResourceBuilder(ResourceBuilder.CreateDefault()
                .AddService(serviceName: name, serviceVersion: version)
                .AddAttributes(logAttrs));
            o.AddOtlpExporter();
        });

        // The resource is set on the meter provider's own builder via SetResourceBuilder, never via
        // the shared ConfigureResource. In this OpenTelemetry version the shared configuration
        // overrides the logs provider's own resource builder, so anything set there leaks onto logs.
        // A per-provider resource keeps the two independent.
        builder.Services.AddOpenTelemetry()
            .WithMetrics(m => m
                .SetResourceBuilder(ResourceBuilder.CreateDefault()
                    // Name and version as separate attributes, not interpolated into one string. The
                    // interpolation this replaces existed to give a sentinel a single readable label;
                    // with a real identity it only buries the version inside the name and leaves logs
                    // and metrics disagreeing about what service.name means.
                    .AddService(serviceName: name, serviceVersion: version)
                    .AddAttributes(metricAttrs))
                // No ASP.NET Core or HttpClient instrumentation: a worker's only inbound surface is
                // its own health probes, so those would measure nothing but the probing.
                .AddRuntimeInstrumentation()
                .AddOtlpExporter());

        return builder;
    }
```

- [ ] **Step 5: Run the suite**

Run: `dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: PASS, 139 total, 0 failed.

- [ ] **Step 6: Commit**

```bash
git add src/BaseConsole.Core/DependencyInjection src/tests/BaseApi.Tests/Console/ConsoleObservabilityTests.cs
git commit -m "feat: let a console pass a resolved identity to its OTel resource"
```

---

### Task 2: The Stage 0 probe listener

**Files:**
- Create: `src/BaseProcessor.Core/Boot/BootProbeListener.cs`
- Test: `src/tests/BaseApi.Tests/Boot/BootProbeListenerTests.cs`

**Interfaces:**
- Produces: `BaseProcessor.Core.Boot.BootProbeListener` with `static Task<BootProbeListener> StartAsync(int port, CancellationToken ct)`, `Uri Address { get; }`, `ValueTask DisposeAsync()`

`Microsoft.AspNetCore.App` is already available to `BaseProcessor.Core` transitively through
`BaseConsole.Core`, which hosts `EmbeddedHealthEndpointService` on `WebApplication.CreateSlimBuilder`.
No project or package change is needed.

- [ ] **Step 1: Write the failing test**

Create `src/tests/BaseApi.Tests/Boot/BootProbeListenerTests.cs`:

```csharp
using System.Net;
using BaseProcessor.Core.Boot;
using Xunit;

namespace BaseApi.Tests.Boot;

public sealed class BootProbeListenerTests
{
    // Port 0 lets the OS choose, so parallel test runs cannot collide on a fixed number.
    private static Task<BootProbeListener> StartAsync() =>
        BootProbeListener.StartAsync(0, TestContext.Current.CancellationToken);

    [Fact]
    public async Task StartupAndLiveAnswerHealthyWhileDiscoveryRuns()
    {
        // This is the whole reason the listener exists. Without it nothing holds :8081 during Stage 1,
        // the startup budget expires, and the kubelet restarts a pod that is starting correctly.
        await using var listener = await StartAsync();
        using var http = new HttpClient { BaseAddress = listener.Address };

        foreach (var path in new[] { "/health/startup", "/health/live" })
        {
            var response = await http.GetAsync(path, TestContext.Current.CancellationToken);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        }
    }

    [Fact]
    public async Task ReadyAnswersUnavailable()
    {
        // Readiness is the honest signal during discovery: the process is up but cannot serve.
        await using var listener = await StartAsync();
        using var http = new HttpClient { BaseAddress = listener.Address };

        var response = await http.GetAsync("/health/ready", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
    }

    [Fact]
    public async Task TheAddressIsLoopbackSoATestCanReachIt()
    {
        await using var listener = await StartAsync();

        Assert.Equal("127.0.0.1", listener.Address.Host);
        Assert.True(listener.Address.Port > 0);
    }

    [Fact]
    public async Task DisposingReleasesThePortForTheRealListener()
    {
        // Stage 2 binds the same port. If disposal did not actually release it the host would fail to
        // start, which is a far worse failure than the missed probe it is trading against.
        var listener = await StartAsync();
        var port = listener.Address.Port;
        await listener.DisposeAsync();

        await using var second = await BootProbeListener.StartAsync(
            port, TestContext.Current.CancellationToken);

        Assert.Equal(port, second.Address.Port);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q --nologo`
Expected: FAIL — `CS0234: The type or namespace name 'Boot' does not exist in the namespace 'BaseProcessor.Core'`.

- [ ] **Step 3: Implement the listener**

Create `src/BaseProcessor.Core/Boot/BootProbeListener.cs`:

```csharp
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;

namespace BaseProcessor.Core.Boot;

/// <summary>
/// The probe surface for the window before the real host exists: startup and liveness healthy,
/// readiness unavailable.
/// <para>
/// <b>It is what makes an unbounded Stage 1 safe.</b> Identity resolution can take as long as it
/// takes — a processor image may be deployed before anyone registers its row — and the kubelet only
/// tolerates that if something is answering. With nothing bound, the startup probe exhausts its
/// budget and the container is restarted, turning a deployment ordering the operator is allowed to
/// choose into a crash loop.
/// </para>
/// <para>
/// <b>The answers are constants, not checks.</b> There is no dependency worth consulting yet: the
/// only thing that could be reported is whether identity has resolved, and that is precisely what
/// readiness already says by answering 503 for the whole window.
/// </para>
/// </summary>
public sealed class BootProbeListener : IAsyncDisposable
{
    private readonly WebApplication _app;

    private BootProbeListener(WebApplication app, Uri address)
    {
        _app    = app;
        Address = address;
    }

    /// <summary>Where the listener actually bound. With port 0 this is known only after starting.</summary>
    public Uri Address { get; }

    /// <summary>
    /// Binds the probe surface. Port 0 lets the OS choose, which is for tests; production passes the
    /// same <c>ConsoleHealth:Port</c> the real listener will take over.
    /// </summary>
    public static async Task<BootProbeListener> StartAsync(int port, CancellationToken ct)
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.WebHost.UseUrls($"http://0.0.0.0:{port}");
        // Console logging belongs to the boot sequence, which owns its own factory. A second provider
        // here would print every request twice during the one window an operator is actually reading.
        builder.Logging.ClearProviders();

        var app = builder.Build();

        app.MapGet("/health/startup", () => Results.Ok());
        app.MapGet("/health/live",    () => Results.Ok());
        app.MapGet("/health/ready",   () => Results.StatusCode(StatusCodes.Status503ServiceUnavailable));

        await app.StartAsync(ct).ConfigureAwait(false);

        var address = app.Services.GetRequiredService<IServer>()
            .Features.Get<IServerAddressesFeature>()?.Addresses
            .Select(a => new Uri(a.Replace("0.0.0.0", "127.0.0.1", StringComparison.Ordinal)))
            .FirstOrDefault()
            ?? throw new InvalidOperationException("the boot probe listener reported no address");

        return new BootProbeListener(app, address);
    }

    /// <summary>
    /// Stops the listener and waits for the port to be released. Stage 2 binds the same port, so a
    /// disposal that returned before the socket closed would fail the real host's startup.
    /// </summary>
    public async ValueTask DisposeAsync()
    {
        await _app.StopAsync().ConfigureAwait(false);
        await _app.DisposeAsync().ConfigureAwait(false);
    }
}
```

- [ ] **Step 4: Run the suite**

Run: `dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: PASS, 143 total, 0 failed.

- [ ] **Step 5: Commit**

```bash
git add src/BaseProcessor.Core/Boot/BootProbeListener.cs src/tests/BaseApi.Tests/Boot
git commit -m "feat: serve probes during the pre-host identity window"
```

---

### Task 3: The Stage 1 identity bootstrap

**Files:**
- Create: `src/BaseProcessor.Core/Boot/IIdentityBootstrap.cs`
- Create: `src/BaseProcessor.Core/Boot/BrokerIdentityBootstrap.cs`
- Test: `src/tests/BaseApi.Tests/Boot/BrokerIdentityBootstrapTests.cs`

**Interfaces:**
- Consumes: `Messaging.Contracts.ProcessorIdentityFound(Guid Id, Guid? InputSchemaId, Guid? OutputSchemaId, Guid? ConfigSchemaId, string Name, string Version)`, `ProcessorQueues.IdentityQuery`, `MessageTypes.GetProcessorBySourceHash`
- Produces: `BaseProcessor.Core.Boot.IIdentityBootstrap` with `Task<ProcessorIdentityFound> ResolveAsync(CancellationToken ct)`
- Produces: `BaseProcessor.Core.Boot.BrokerIdentityBootstrap(IConfiguration cfg, ILoggerFactory logs, TimeProvider clock)` implementing `IIdentityBootstrap, IAsyncDisposable`

- [ ] **Step 1: Write the failing tests**

Create `src/tests/BaseApi.Tests/Boot/BrokerIdentityBootstrapTests.cs`:

```csharp
using BaseProcessor.Core.Boot;
using Messaging.Contracts;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace BaseApi.Tests.Boot;

public sealed class BrokerIdentityBootstrapTests
{
    private static IConfiguration ConfigWith(params (string Key, string Value)[] settings) =>
        new ConfigurationBuilder()
            .AddInMemoryCollection(settings.Select(s => new KeyValuePair<string, string?>(s.Key, s.Value)))
            .Build();

    [Fact]
    public void FailsFastWhenTheBrokerHostIsMissing()
    {
        // The whole boot hangs on this connection. A missing host must name itself here rather than
        // surface as an unbounded retry against a destination that was never configured.
        var cfg = ConfigWith(("RabbitMq:Username", "guest"), ("RabbitMq:Password", "guest"));

        var ex = Assert.Throws<InvalidOperationException>(
            () => new BrokerIdentityBootstrap(cfg, NullLoggerFactory.Instance, TimeProvider.System));

        Assert.Contains("RabbitMq:Host", ex.Message);
    }

    [Fact]
    public void BuildsWithACompleteBrokerConfiguration()
    {
        // Construction must not connect. The connection belongs to ResolveAsync, which is the part
        // allowed to retry forever.
        var cfg = ConfigWith(
            ("RabbitMq:Host", "localhost"),
            ("RabbitMq:Username", "guest"),
            ("RabbitMq:Password", "guest"));

        using var _ = new CancellationTokenSource();
        var bootstrap = new BrokerIdentityBootstrap(cfg, NullLoggerFactory.Instance, TimeProvider.System);

        Assert.NotNull(bootstrap);
    }

    [Fact]
    public async Task CancellationEndsTheLoopRatherThanReturningNothing()
    {
        // Shutdown during discovery is a cancellation, never a resolved identity. Returning null here
        // would let a half-booted host start with no identity at all.
        var cfg = ConfigWith(
            ("RabbitMq:Host", "127.0.0.1"),
            ("RabbitMq:Port", "1"),           // nothing listens; every attempt fails and retries
            ("RabbitMq:Username", "guest"),
            ("RabbitMq:Password", "guest"),
            ("Processor:BackoffCap", "1"),
            ("Processor:RequestTimeout", "1"));

        await using var bootstrap = new BrokerIdentityBootstrap(
            cfg, NullLoggerFactory.Instance, TimeProvider.System);

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => bootstrap.ResolveAsync(cts.Token));
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q --nologo`
Expected: FAIL — `CS0246: The type or namespace name 'BrokerIdentityBootstrap' could not be found`.

- [ ] **Step 3: Create the seam**

`src/BaseProcessor.Core/Boot/IIdentityBootstrap.cs`:

```csharp
using Messaging.Contracts;

namespace BaseProcessor.Core.Boot;

/// <summary>
/// Stage 1 of the boot: resolve who this process is, before anything that needs the answer exists.
/// <para>
/// An interface rather than a virtual method, because the substitution a test needs is total — it
/// replaces the broker, the reply queue and the loop at once — and because the boot sequence should
/// be exercisable without a broker at all.
/// </para>
/// </summary>
public interface IIdentityBootstrap
{
    /// <summary>
    /// Resolves the identity, retrying without limit until it does.
    /// <para>
    /// It never returns without an answer. A processor image may be deployed before its row is
    /// registered, so "not found" is an ordinary early answer rather than a failure, and the only
    /// thing that ends the wait is cancellation — which throws.
    /// </para>
    /// </summary>
    /// <exception cref="OperationCanceledException">Shutdown was requested while still resolving.</exception>
    Task<ProcessorIdentityFound> ResolveAsync(CancellationToken ct);
}
```

- [ ] **Step 4: Implement the broker bootstrap**

`src/BaseProcessor.Core/Boot/BrokerIdentityBootstrap.cs`:

```csharp
using BaseConsole.Core.Configuration;
using BaseConsole.Core.DependencyInjection;
using BaseConsole.Core.Messaging;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace BaseProcessor.Core.Boot;

/// <summary>
/// Stage 1 over the real broker. It stands up the smallest container that can ask a question —
/// connection, sender, reply queue, slot — asks it until answered, and takes the whole thing down
/// again.
/// <para>
/// <b>The container is disposed before the host builds its own.</b> The two connections never
/// overlap. Handing this one across would save a reconnect and cost a lifetime that spans two
/// containers, and the reply queue is exclusive and auto-delete precisely so that dropping the
/// connection cleans up after itself.
/// </para>
/// <para>
/// <b>Redis is deliberately absent.</b> Nothing is written to L2 before identity resolves — there is
/// no processor id to key on — so requiring a store here would add a dependency to the one window
/// that must be able to wait out everything else.
/// </para>
/// </summary>
public sealed class BrokerIdentityBootstrap : IIdentityBootstrap, IAsyncDisposable
{
    private readonly ServiceProvider _services;
    private readonly ILogger<BrokerIdentityBootstrap> _logger;
    private readonly TimeProvider _clock;
    private readonly int _requestTimeoutSeconds;
    private readonly int _backoffCapSeconds;

    public BrokerIdentityBootstrap(IConfiguration cfg, ILoggerFactory logs, TimeProvider clock)
    {
        ArgumentNullException.ThrowIfNull(cfg);
        ArgumentNullException.ThrowIfNull(logs);
        ArgumentNullException.ThrowIfNull(clock);

        _clock  = clock;
        _logger = logs.CreateLogger<BrokerIdentityBootstrap>();

        _requestTimeoutSeconds = cfg.GetValue<int?>("Processor:RequestTimeout") ?? 8;
        _backoffCapSeconds     = cfg.GetValue<int?>("Processor:BackoffCap") ?? 30;

        var services = new ServiceCollection();
        services.AddSingleton(logs);
        services.AddLogging();
        // Reuses the console registration rather than restating it, so the boot connects with exactly
        // the settings the host will use — including the eager Require checks that name a missing key.
        services.AddBaseConsoleMessaging(cfg);
        services.AddSingleton(InstanceId.Resolve());
        services.AddSingleton<ReplySlot<object>>();
        services.AddSingleton<ReplyQueueConsumer>();
        services.AddSingleton<IReplyEndpoint>(sp => sp.GetRequiredService<ReplyQueueConsumer>());
        services.AddSingleton<ISourceHashProvider, Identity.AssemblyMetadataSourceHashProvider>();

        _services = services.BuildServiceProvider();
    }

    /// <inheritdoc/>
    public async Task<ProcessorIdentityFound> ResolveAsync(CancellationToken ct)
    {
        var hash     = _services.GetRequiredService<ISourceHashProvider>().Get();
        var sender   = _services.GetRequiredService<IQueueSender>();
        var replies  = _services.GetRequiredService<IReplyEndpoint>();
        var slot     = _services.GetRequiredService<ReplySlot<object>>();
        var delay    = TimeSpan.FromSeconds(1);

        while (true)
        {
            ct.ThrowIfCancellationRequested();

            var reply = await AskAsync(sender, replies, slot, hash, ct).ConfigureAwait(false);

            switch (reply)
            {
                case ProcessorIdentityFound found:
                    _logger.LogInformation(
                        "identity resolved: processor {ProcessorId} ({Name} {Version})",
                        found.Id, found.Name, found.Version);
                    return found;
                case ProcessorIdentityNotFound:
                    _logger.LogInformation(
                        "no processor registered for source hash {Hash}; retrying in {Delay}", hash, delay);
                    break;
                default:
                    _logger.LogWarning("identity request went unanswered; retrying in {Delay}", delay);
                    break;
            }

            // Task.Delay(delay, clock, ct) rather than an instance method — this is the form the
            // orchestrator's own BackoffAsync already uses, and TimeProvider has no Delay of its own.
            await Task.Delay(delay, _clock, ct).ConfigureAwait(false);
            delay = TimeSpan.FromSeconds(
                Math.Min(delay.TotalSeconds * 2, _backoffCapSeconds));
        }
    }

    /// <summary>
    /// One ask and its bounded wait, mirroring the orchestrator's: the reply endpoint is ensured live
    /// on every attempt because the queue dies with its connection, and the slot is drained first so a
    /// leftover from a previous attempt cannot be mistaken for this one's answer.
    /// </summary>
    private async Task<object?> AskAsync(
        IQueueSender sender, IReplyEndpoint replies, ReplySlot<object> slot, string hash,
        CancellationToken ct)
    {
        try
        {
            await replies.EnsureStartedAsync(ct).ConfigureAwait(false);
            slot.Take();
            await sender.SendAsync(
                ProcessorQueues.IdentityQuery,
                MessageTypes.GetProcessorBySourceHash,
                new GetProcessorBySourceHash(hash),
                ct,
                replies.QueueName).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // A broker that is down or mid-reconnect is the same situation as an unanswered ask: wait
            // and try again. This is the window the design exists to let a processor ride out.
            _logger.LogWarning(ex, "could not send the identity request; will retry");
            return null;
        }

        await slot.WaitAsync(TimeSpan.FromSeconds(_requestTimeoutSeconds), ct).ConfigureAwait(false);
        return slot.Take();
    }

    public async ValueTask DisposeAsync()
    {
        if (_services.GetService<ReplyQueueConsumer>() is { } consumer)
        {
            await consumer.DisposeAsync().ConfigureAwait(false);
        }

        await _services.DisposeAsync().ConfigureAwait(false);
    }
}
```

If `ISourceHashProvider` / `AssemblyMetadataSourceHashProvider` do not resolve by that namespace,
add `using BaseProcessor.Core.Identity;` and drop the `Identity.` prefix.

- [ ] **Step 5: Run the suite**

Run: `dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: PASS, 146 total, 0 failed. The cancellation test takes ~2s.

- [ ] **Step 6: Commit**

```bash
git add src/BaseProcessor.Core/Boot src/tests/BaseApi.Tests/Boot/BrokerIdentityBootstrapTests.cs
git commit -m "feat: resolve processor identity before the host exists"
```

---

### Task 4: Sequencing the three stages

**Files:**
- Create: `src/BaseProcessor.Core/Boot/ProcessorBoot.cs`
- Test: `src/tests/BaseApi.Tests/Boot/ProcessorBootTests.cs`

**Interfaces:**
- Consumes: `IIdentityBootstrap`, `BootProbeListener`
- Produces: `BaseProcessor.Core.Boot.ProcessorBoot.StartAsync(int probePort, IIdentityBootstrap bootstrap, Func<ProcessorIdentityFound, IHost> buildHost, CancellationToken ct)` returning `Task<IHost>`

- [ ] **Step 1: Write the failing tests**

Create `src/tests/BaseApi.Tests/Boot/ProcessorBootTests.cs`:

```csharp
using System.Net;
using BaseProcessor.Core.Boot;
using Messaging.Contracts;
using Microsoft.Extensions.Hosting;
using Xunit;

namespace BaseApi.Tests.Boot;

public sealed class ProcessorBootTests
{
    private static readonly ProcessorIdentityFound Identity = new(
        Guid.Parse("9e034ca0-144b-44d5-ab90-7ed53b64a728"),
        InputSchemaId: null, OutputSchemaId: null, ConfigSchemaId: null,
        Name: "sample-proc", Version: "1.0.0");

    /// <summary>A bootstrap that answers immediately, so the sequencing is what is under test.</summary>
    private sealed class Immediate : IIdentityBootstrap
    {
        public Task<ProcessorIdentityFound> ResolveAsync(CancellationToken ct)
            => Task.FromResult(Identity);
    }

    /// <summary>A bootstrap that reports what the probes said while it was still working.</summary>
    private sealed class ProbesWhileResolving : IIdentityBootstrap
    {
        private readonly int _port;
        public HttpStatusCode Startup { get; private set; }
        public HttpStatusCode Ready { get; private set; }

        public ProbesWhileResolving(int port) => _port = port;

        public async Task<ProcessorIdentityFound> ResolveAsync(CancellationToken ct)
        {
            using var http = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{_port}") };
            Startup = (await http.GetAsync("/health/startup", ct)).StatusCode;
            Ready   = (await http.GetAsync("/health/ready", ct)).StatusCode;
            return Identity;
        }
    }

    private static int FreePort()
    {
        var l = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        l.Start();
        var port = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return port;
    }

    [Fact]
    public async Task TheResolvedIdentityReachesTheHostBuilder()
    {
        // The identity is the entire point of the sequence: it exists so the builder can put it on a
        // resource that freezes the moment the host is built.
        ProcessorIdentityFound? seen = null;

        using var host = await ProcessorBoot.StartAsync(
            FreePort(),
            new Immediate(),
            id => { seen = id; return new HostBuilder().Build(); },
            TestContext.Current.CancellationToken);

        Assert.Equal(Identity, seen);
    }

    [Fact]
    public async Task ProbesAnswerThroughoutTheIdentityWindow()
    {
        // If these ever stop answering, an unregistered processor crash-loops instead of waiting.
        var port = FreePort();
        var bootstrap = new ProbesWhileResolving(port);

        using var host = await ProcessorBoot.StartAsync(
            port, bootstrap, _ => new HostBuilder().Build(),
            TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, bootstrap.Startup);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, bootstrap.Ready);
    }

    [Fact]
    public async Task TheProbePortIsFreeOnceTheHostIsBuilt()
    {
        // Stage 2's own listener takes this port. A listener still holding it would fail host startup.
        var port = FreePort();

        using var host = await ProcessorBoot.StartAsync(
            port, new Immediate(), _ => new HostBuilder().Build(),
            TestContext.Current.CancellationToken);

        await using var rebind = await BootProbeListener.StartAsync(
            port, TestContext.Current.CancellationToken);

        Assert.Equal(port, rebind.Address.Port);
    }

    [Fact]
    public async Task ANeverResolvingBootstrapIsCancellable()
    {
        var port = FreePort();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(1));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => ProcessorBoot.StartAsync(
                port,
                new NeverResolves(),
                _ => new HostBuilder().Build(),
                cts.Token));

        // And the port must not be left held by a listener nobody can reach any more.
        await using var rebind = await BootProbeListener.StartAsync(
            port, TestContext.Current.CancellationToken);
        Assert.Equal(port, rebind.Address.Port);
    }

    private sealed class NeverResolves : IIdentityBootstrap
    {
        public async Task<ProcessorIdentityFound> ResolveAsync(CancellationToken ct)
        {
            await Task.Delay(Timeout.Infinite, ct);
            throw new UnreachableException();
        }
    }
}
```

Add `using System.Diagnostics;` for `UnreachableException`.

- [ ] **Step 2: Run to verify it fails**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q --nologo`
Expected: FAIL — `CS0117: 'ProcessorBoot' does not contain a definition for 'StartAsync'`.

- [ ] **Step 3: Implement the sequence**

`src/BaseProcessor.Core/Boot/ProcessorBoot.cs`:

```csharp
using Messaging.Contracts;
using Microsoft.Extensions.Hosting;

namespace BaseProcessor.Core.Boot;

/// <summary>
/// The three-stage boot: probes up, identity resolved, host built with the answer.
/// <para>
/// <b>Why the order cannot be otherwise.</b> An OpenTelemetry resource is materialised when its
/// provider is built and is immutable afterwards — verified, including through
/// <c>IResourceDetector</c>, which is the latest hook the SDK offers and still fires before the first
/// hosted service runs. A processor's identity is a database row reached over the bus, so it can only
/// reach a resource by being known before the host is built. That is this method.
/// </para>
/// </summary>
public static class ProcessorBoot
{
    /// <summary>
    /// Serves probes on <paramref name="probePort"/>, resolves identity, releases the port, then hands
    /// the identity to <paramref name="buildHost"/> and starts what it returns.
    /// </summary>
    /// <param name="probePort">
    /// The port the real health listener will take over. The same number deliberately: the kubelet is
    /// pointed at one port and must not have to know which stage is answering.
    /// </param>
    /// <param name="bootstrap">Stage 1. Retries without limit; only cancellation ends it.</param>
    /// <param name="buildHost">
    /// Builds the real host from the resolved identity. It is a callback rather than a prebuilt host
    /// because the identity has to be in hand before the builder runs — that is the whole ordering
    /// this method exists to enforce.
    /// </param>
    public static async Task<IHost> StartAsync(
        int probePort,
        IIdentityBootstrap bootstrap,
        Func<ProcessorIdentityFound, IHost> buildHost,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(bootstrap);
        ArgumentNullException.ThrowIfNull(buildHost);

        ProcessorIdentityFound identity;

        var probes = await BootProbeListener.StartAsync(probePort, ct).ConfigureAwait(false);
        try
        {
            identity = await bootstrap.ResolveAsync(ct).ConfigureAwait(false);
        }
        finally
        {
            // Released even on cancellation. A listener surviving a failed boot would hold the port
            // against the next attempt, turning one failure into a permanent one.
            await probes.DisposeAsync().ConfigureAwait(false);
        }

        var host = buildHost(identity);
        await host.StartAsync(ct).ConfigureAwait(false);
        return host;
    }
}
```

- [ ] **Step 4: Run the suite**

Run: `dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: PASS, 150 total, 0 failed.

- [ ] **Step 5: Commit**

```bash
git add src/BaseProcessor.Core/Boot/ProcessorBoot.cs src/tests/BaseApi.Tests/Boot/ProcessorBootTests.cs
git commit -m "feat: sequence probes, identity and host construction"
```

---

### Task 5: Seed identity into the container and drop Loop A

**Files:**
- Modify: `src/BaseProcessor.Core/DependencyInjection/BaseProcessorServiceCollectionExtensions.cs`
- Modify: `src/BaseProcessor.Core/Startup/ProcessorStartupOrchestrator.cs`
- Test: `src/tests/BaseApi.Tests/Processor/ProcessorStartupOrchestratorTests.cs`

**Interfaces:**
- Produces: `AddBaseProcessor(this IServiceCollection services, IConfiguration cfg, ProcessorIdentityFound identity)`
- Changes: `ProcessorStartupOrchestrator` loses its `ISourceHashProvider` constructor parameter; `RunStartupAsync` no longer resolves identity.

- [ ] **Step 1: Add the seeding overload**

In `src/BaseProcessor.Core/DependencyInjection/BaseProcessorServiceCollectionExtensions.cs`, add
above the existing `AddBaseProcessor`:

```csharp
    /// <summary>
    /// The two-stage boot's registration: the same graph, with <see cref="IProcessorContext"/> already
    /// carrying the identity Stage 1 resolved.
    /// <para>
    /// Seeding rather than resolving is what lets the OTel resource carry the identity at all. By the
    /// time this runs the answer is known, so the in-host retry that used to find it has nothing left
    /// to do — see <see cref="Startup.ProcessorStartupOrchestrator"/>, which now begins at Loop B.
    /// </para>
    /// </summary>
    public static IServiceCollection AddBaseProcessor(
        this IServiceCollection services, IConfiguration cfg, ProcessorIdentityFound identity)
    {
        ArgumentNullException.ThrowIfNull(identity);

        // Registered before AddBaseProcessor's TryAddSingleton, so this pre-seeded instance wins.
        services.AddSingleton<IProcessorContext>(_ =>
        {
            var context = new ProcessorContext();
            context.SetIdentity(identity);
            return context;
        });

        return services.AddBaseProcessor(cfg);
    }
```

Add `using Messaging.Contracts;` to the file if absent.

- [ ] **Step 2: Write the failing orchestrator tests**

In `src/tests/BaseApi.Tests/Processor/ProcessorStartupOrchestratorTests.cs`:

Delete these four tests, whose behaviour now belongs to `BrokerIdentityBootstrap`:
`KeepsAskingWhileTheProcessorRowIsNotRegistered`, `WritesNothingToL2BeforeIdentityResolves`,
`PublishesUnhealthyAsSoonAsIdentityResolves`, `EveryAskCarriesTheReplyAddress`.

Rename `ResolvesIdentityThenDefinitionsAndReachesHealthy` to `ResolvesDefinitionsAndReachesHealthy`,
and add:

```csharp
    [Fact]
    public async Task StartsFromASeededIdentityWithoutAsking()
    {
        // Loop A is gone. If the orchestrator still asked, a processor whose identity was already
        // resolved would send a pointless query on every boot — and worse, could disagree with it.
        var harness = NewHarness();

        await harness.Orchestrator.RunStartupAsync(TestContext.Current.CancellationToken);

        Assert.DoesNotContain(
            harness.Sent, s => s.Queue == ProcessorQueues.IdentityQuery);
    }

    [Fact]
    public async Task PublishesUnhealthyBeforeResolvingAnyDefinition()
    {
        // The replica must be visible as unhealthy rather than absent from the first moment, and now
        // that identity arrives pre-seeded that moment is host start.
        var harness = NewHarness();

        await harness.Orchestrator.RunStartupAsync(TestContext.Current.CancellationToken);

        Assert.NotEmpty(harness.Writes);
    }
```

Adjust the existing harness so the substituted `IProcessorContext` is pre-seeded with an identity
before the orchestrator is constructed, and remove the `ISourceHashProvider` argument from the
constructor call. Keep every remaining test's intent unchanged.

- [ ] **Step 3: Run to verify it fails**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q --nologo`
Expected: FAIL — the orchestrator constructor still takes `ISourceHashProvider`.

- [ ] **Step 4: Remove Loop A from the orchestrator**

In `src/BaseProcessor.Core/Startup/ProcessorStartupOrchestrator.cs`:

Delete the `_sourceHash` field, its constructor parameter and assignment, and the whole
`ResolveIdentityAsync` method. Replace `RunStartupAsync` with:

```csharp
    /// <summary>
    /// Resolves the schema definitions for an identity that is already in hand, then flips the healthy
    /// latch. Returns early and without flipping it if shutdown is requested — a half-resolved
    /// processor must never publish itself healthy.
    /// </summary>
    public async Task RunStartupAsync(CancellationToken ct)
    {
        // Identity arrived before this host existed: Stage 1 resolved it so the OTel resource could
        // carry it, and the container was seeded with the answer. What used to be Loop A is gone.
        var identity = _context.Identity
            ?? throw new InvalidOperationException(
                "the orchestrator started without a seeded identity — AddBaseProcessor(cfg, identity) " +
                "is what supplies it, and the two-stage boot is what calls that overload.");

        // The first write. From here the replica is visible as unhealthy rather than absent, for as
        // long as it takes Loop B to finish.
        await WriteUnhealthyAsync().ConfigureAwait(false);

        if (!await ResolveDefinitionsAsync(ct).ConfigureAwait(false))
        {
            return;   // shutdown
        }

        _logger.LogInformation("all schema definitions resolved");

        // NOTE: the dispatch endpoint bind belongs here, before the latch flips. See the type remarks.
        _context.MarkHealthy();

        // The loop is finished, so its heartbeat must stop being watched — otherwise it reads as stale
        // one window from now and restarts a perfectly healthy processor.
        _heartbeat.Retire();
        _logger.LogInformation("processor healthy; startup loops retired");
    }
```

Update the class-level `<summary>`: the numbered list now has one entry, Loop B, and the paragraph
about both loops retrying should say that Loop B retries without limit and that identity is resolved
before the host is built.

- [ ] **Step 5: Run the suite**

Run: `dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: PASS, 148 total, 0 failed (four tests removed, two added).

- [ ] **Step 6: Commit**

```bash
git add src/BaseProcessor.Core src/tests/BaseApi.Tests/Processor/ProcessorStartupOrchestratorTests.cs
git commit -m "refactor: start the orchestrator from a seeded identity"
```

---

### Task 6: Wire Processor.Sample to the two-stage boot

**Files:**
- Modify: `src/Processor.Sample/ProcessorHost.cs`
- Modify: `src/Processor.Sample/Program.cs`
- Modify: `src/tests/BaseApi.Tests/Sample/ProcessorSampleTests.cs`
- Modify: `k8s/33-processor-sample.yaml`

**Interfaces:**
- Produces: `ProcessorHost.Create(string[] args, ProcessorIdentityFound identity, Action<IConfigurationBuilder>? configure = null)` returning `IHost`
- Produces: `ProcessorHost.StartAsync(string[] args, CancellationToken ct, Action<IConfigurationBuilder>? configure = null, IIdentityBootstrap? bootstrap = null)` returning `Task<IHost>`

- [ ] **Step 1: Write the failing test**

Replace the `Build()` helper in `src/tests/BaseApi.Tests/Sample/ProcessorSampleTests.cs`:

```csharp
    private static readonly ProcessorIdentityFound Identity = new(
        Guid.Parse("9e034ca0-144b-44d5-ab90-7ed53b64a728"),
        InputSchemaId: null, OutputSchemaId: null, ConfigSchemaId: null,
        Name: "sample-proc", Version: "1.0.0");

    private static IHost Build() => ProcessorHost.Create(
        // Development turns on the container's build-time validation, which is the whole point of
        // this test: every registration is checked for constructibility without anything being
        // instantiated, so no broker or store is contacted.
        ["--environment", "Development"],
        Identity,
        cfg => cfg.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Service:Name"]            = "processor",
            ["Service:Version"]         = "0.0.0",
            ["ConnectionStrings:Redis"] = "localhost:6379,abortConnect=false",
            ["RabbitMq:Host"]           = "localhost",
            ["RabbitMq:Username"]       = "guest",
            ["RabbitMq:Password"]       = "guest",
        }));
```

And add:

```csharp
    [Fact]
    public void TheSeededIdentityIsWhatTheContextReports()
    {
        // The host is built from the row, not from configuration. If this ever read "processor" the
        // resource would be carrying a sentinel and the whole two-stage boot would be pointless.
        using var host = Build();

        var context = host.Services.GetRequiredService<IProcessorContext>();

        Assert.Equal(Identity.Id, context.Identity?.Id);
        Assert.Equal("sample-proc", context.Identity?.Name);
    }
```

Add `using BaseProcessor.Core.Identity;` and `using Messaging.Contracts;`.

- [ ] **Step 2: Run to verify it fails**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q --nologo`
Expected: FAIL — no `Create` overload takes a `ProcessorIdentityFound`.

- [ ] **Step 3: Rewrite the host**

Replace the body of `src/Processor.Sample/ProcessorHost.cs`:

```csharp
using BaseConsole.Core.DependencyInjection;
using BaseProcessor.Core.Boot;
using BaseProcessor.Core.DependencyInjection;
using Messaging.Contracts;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Processor.Sample;

/// <summary>
/// The composition root, as methods rather than inline in <c>Program</c> so that the one thing worth
/// asserting about a shell — that its service graph actually resolves — can be asserted without
/// starting a process.
/// </summary>
public static class ProcessorHost
{
    /// <summary>
    /// The production entry point: probes, then identity, then a host built around the answer.
    /// </summary>
    /// <param name="bootstrap">
    /// Stage 1. Null uses the real broker; a test passes its own so the sequence can be exercised
    /// without one.
    /// </param>
    public static async Task<IHost> StartAsync(
        string[] args,
        CancellationToken ct,
        Action<IConfigurationBuilder>? configure = null,
        IIdentityBootstrap? bootstrap = null)
    {
        // Configuration is read twice — once for the boot, once by the host builder — because the boot
        // has to know where the broker is before a host exists to tell it.
        var bootConfig = new ConfigurationBuilder()
            .AddJsonFile("appsettings.json", optional: true)
            .AddEnvironmentVariables()
            .Build();

        // Console only. This is the whole logging surface for the identity window, which is exactly
        // where an operator is already looking: kubectl logs on a pod that is not ready yet.
        using var bootLogs = LoggerFactory.Create(b => b.AddConsole());

        var owned = bootstrap is null;
        var resolver = bootstrap ?? new BrokerIdentityBootstrap(
            bootConfig, bootLogs, TimeProvider.System);

        try
        {
            return await ProcessorBoot.StartAsync(
                bootConfig.GetValue<int?>("ConsoleHealth:Port") ?? 8081,
                resolver,
                identity => Create(args, identity, configure),
                ct).ConfigureAwait(false);
        }
        finally
        {
            if (owned && resolver is IAsyncDisposable disposable)
            {
                await disposable.DisposeAsync().ConfigureAwait(false);
            }
        }
    }

    /// <summary>
    /// Builds the host around an identity that is already known. Separate from
    /// <see cref="StartAsync"/> so a test can assert the graph resolves without a broker.
    /// </summary>
    public static IHost Create(
        string[] args, ProcessorIdentityFound identity, Action<IConfigurationBuilder>? configure = null)
    {
        ArgumentNullException.ThrowIfNull(identity);

        var builder = Host.CreateApplicationBuilder(args);
        configure?.Invoke(builder.Configuration);

        // The identity from the database row, not from configuration. It reaches the OTel resource
        // only because it was resolved before this line ran: a resource is materialised when its
        // provider is built and is immutable afterwards, so there is no later opportunity.
        //
        // ProcessorId rides alongside because it is the only exact identifier — name and version are
        // unconstrained columns, and two different builds can carry the same pair.
        builder.AddBaseConsoleObservability(
            builder.Configuration,
            source: "worker",
            serviceName: identity.Name,
            serviceVersion: identity.Version,
            resourceAttributes: [new ResourceAttribute("ProcessorId", "processorId", identity.Id.ToString())]);

        // Everything else: broker, Redis, health probes, the schema loop and the liveness loop.
        builder.Services.AddBaseProcessor(builder.Configuration, identity);

        return builder.Build();
    }
}
```

- [ ] **Step 4: Update Program**

Replace `src/Processor.Sample/Program.cs` with:

```csharp
using Processor.Sample;

// The boot resolves identity before building anything, so this is the one place the process can be
// cancelled while it is still deciding who it is.
using var lifetime = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; lifetime.Cancel(); };

using var host = await ProcessorHost.StartAsync(args, lifetime.Token);
await host.WaitForShutdownAsync();
```

- [ ] **Step 5: Document the fallback in the manifest**

In `k8s/33-processor-sample.yaml`, replace the `Service__Name` comment block:

```yaml
            # Fallback only. The real service name and version come from the processor's database row,
            # resolved before the host is built so they can reach the OTel resource. These values are
            # used only if a host is started without that resolution — which the sample never does.
            - name: Service__Name
              value: processor
```

- [ ] **Step 6: Run the suite**

Run: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -v q --nologo && dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: PASS, 149 total, 0 failed.

- [ ] **Step 7: Commit**

```bash
git add src/Processor.Sample src/tests/BaseApi.Tests/Sample/ProcessorSampleTests.cs k8s/33-processor-sample.yaml
git commit -m "feat: boot the sample processor identity-first"
```

---

### Task 7: Live test harness

**Files:**
- Create: `src/tests/BaseApi.Tests/Live/RealStack.cs`
- Create: `src/tests/BaseApi.Tests/Live/ResourceReader.cs`
- Create: `src/tests/BaseApi.Tests/Live/RealStackFixture.cs`
- Create: `k8s/port-forward-realstack.ps1`

**Interfaces:**
- Produces: `BaseApi.Tests.Live.RealStack` with `static bool Enabled`, `static void SkipUnlessEnabled()`, `static string RabbitHost/BaseApiUrl/OtlpEndpoint/CollectorMetricsUrl`, `static int RabbitPort`
- Produces: `BaseApi.Tests.Live.ResourceReader.Read(object provider)` returning `IReadOnlyDictionary<string, object>`
- Produces: `BaseApi.Tests.Live.RealStackFixture` (an `IAsyncLifetime` fixture) with `Guid ProcessorId`, `string Name`, `string Version`, `string SourceHash`

- [ ] **Step 1: Write the gate and a test proving it skips**

Create `src/tests/BaseApi.Tests/Live/RealStack.cs`:

```csharp
namespace BaseApi.Tests.Live;

/// <summary>
/// The switch and the addresses for tests that talk to the real cluster.
/// <para>
/// <b>The gate is an environment variable read inside the test, not a trait filter.</b> Under
/// Microsoft.Testing.Platform a <c>--filter "Category!=RealStack"</c> is accepted and silently
/// ignored, so a filter-only guard would let every live test run in what looked like a hermetic
/// pass — and fail against infrastructure that is not there. The trait is kept as well, for
/// selecting these tests deliberately, but it is not what makes them safe.
/// </para>
/// </summary>
public static class RealStack
{
    public const string Category = "RealStack";

    /// <summary>True only when an operator has opened the port-forwards and said so.</summary>
    public static bool Enabled =>
        Environment.GetEnvironmentVariable("SKP_REALSTACK") == "1";

    /// <summary>Skips the calling test unless the real stack was explicitly enabled.</summary>
    public static void SkipUnlessEnabled() =>
        Assert.SkipUnless(Enabled,
            "set SKP_REALSTACK=1 and run k8s/port-forward-realstack.ps1 to run the live tests");

    // Defaults match k8s/port-forward-realstack.ps1. Every port is offset from its in-cluster number
    // so a forward can never collide with a local service on the standard one.
    public static string RabbitHost => Get("SKP_RABBIT_HOST", "localhost");
    public static int RabbitPort => int.Parse(Get("SKP_RABBIT_PORT", "5673"));
    public static string BaseApiUrl => Get("SKP_BASEAPI_URL", "http://localhost:18080");
    public static string OtlpEndpoint => Get("SKP_OTLP_ENDPOINT", "http://localhost:14317");
    public static string CollectorMetricsUrl => Get("SKP_COLLECTOR_METRICS_URL", "http://localhost:18889/metrics");

    private static string Get(string key, string fallback) =>
        Environment.GetEnvironmentVariable(key) is { Length: > 0 } v ? v : fallback;
}
```

Add `using Xunit;`.

- [ ] **Step 2: Verify the skip API exists**

Run:
```bash
cd src/tests/BaseApi.Tests && dotnet build -v q --nologo
```
Expected: PASS. If it fails with `CS0117: 'Assert' does not contain a definition for 'SkipUnless'`,
replace the body of `SkipUnlessEnabled` with `if (!Enabled) Assert.Skip("...");` and rebuild. If
neither exists, pin a newer `xunit.v3.assert` in `Directory.Packages.props` — do not fall back to a
static `[Fact(Skip=…)]`, which cannot read an environment variable.

- [ ] **Step 3: Write the resource reader**

Create `src/tests/BaseApi.Tests/Live/ResourceReader.cs`:

```csharp
using System.Reflection;
using OpenTelemetry.Resources;

namespace BaseApi.Tests.Live;

/// <summary>
/// Reads the <see cref="Resource"/> a provider froze at build time.
/// <para>
/// Reflection because the SDK exposes no public accessor, and asserting on the frozen resource is the
/// only way to prove the two-stage boot did what it exists to do. Asserting on what was *passed* to
/// the wiring would pass just as happily if the SDK ignored it.
/// </para>
/// <para>
/// The property is declared on a base type, so the walk is up the hierarchy with
/// <c>DeclaredOnly</c> rather than a single lookup — verified against OpenTelemetry 1.15.3.
/// </para>
/// </summary>
public static class ResourceReader
{
    public static IReadOnlyDictionary<string, object> Read(object provider)
    {
        ArgumentNullException.ThrowIfNull(provider);

        for (var t = provider.GetType(); t is not null; t = t.BaseType)
        {
            var property = t.GetProperty("Resource",
                BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public |
                BindingFlags.DeclaredOnly);

            if (property?.GetValue(provider) is Resource resource)
            {
                return resource.Attributes.ToDictionary(a => a.Key, a => a.Value);
            }
        }

        throw new InvalidOperationException(
            $"no Resource property found on {provider.GetType().FullName} or its base types");
    }
}
```

- [ ] **Step 4: Write the fixture**

Create `src/tests/BaseApi.Tests/Live/RealStackFixture.cs`:

```csharp
using System.Net.Http.Json;
using System.Text.Json;
using Xunit;

namespace BaseApi.Tests.Live;

/// <summary>
/// Registers a throwaway processor row over BaseApi's REST surface and removes it afterwards, so the
/// live tests have a row to resolve without depending on whatever happens to be in the database.
/// <para>
/// The source hash is derived from the fixture's own run rather than from assembly metadata: these
/// tests must not resolve to the sample processor's real row, because deleting that afterwards would
/// break the running deployment.
/// </para>
/// </summary>
public sealed class RealStackFixture : IAsyncLifetime
{
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(20) };

    public Guid ProcessorId { get; private set; }
    public string SourceHash { get; private set; } = string.Empty;
    public string Name { get; private set; } = string.Empty;
    public string Version => "1.0.0";

    public async ValueTask InitializeAsync()
    {
        if (!RealStack.Enabled)
        {
            return;
        }

        // A fresh 64-hex hash per run, so concurrent runs cannot collide on uq_processor_source_hash.
        SourceHash = Convert.ToHexString(Guid.NewGuid().ToByteArray().Concat(
            Guid.NewGuid().ToByteArray()).ToArray()).ToLowerInvariant();
        Name = $"live-test-{Guid.NewGuid():N}";

        var response = await _http.PostAsJsonAsync(
            $"{RealStack.BaseApiUrl}/api/v1/processors",
            new { SourceHash, Name, Version });

        response.EnsureSuccessStatusCode();

        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        ProcessorId = body.RootElement.GetProperty("id").GetGuid();
    }

    public async ValueTask DisposeAsync()
    {
        if (RealStack.Enabled && ProcessorId != Guid.Empty)
        {
            // Best effort. A leftover row is noise in a dev cluster, not a failure worth masking a
            // real assertion behind.
            try
            {
                await _http.DeleteAsync($"{RealStack.BaseApiUrl}/api/v1/processors/{ProcessorId}");
            }
            catch (HttpRequestException)
            {
            }
        }

        _http.Dispose();
    }
}

[CollectionDefinition(Name)]
public sealed class RealStackCollection : ICollectionFixture<RealStackFixture>
{
    public const string Name = "RealStack";
}
```

If the create response's id property is not lowercase `id`, adjust to what
`ProcessorReadDto` actually serialises — check `MessagingJson.Options` / the controller's
`CreatedAtAction` body before assuming.

- [ ] **Step 5: Write the port-forward script**

Create `k8s/port-forward-realstack.ps1`:

```powershell
# Opens the forwards the RealStack tests expect. Every local port is offset from its in-cluster
# number so a forward can never be mistaken for, or collide with, a local service.
#
# Usage:  ./k8s/port-forward-realstack.ps1
#         $env:SKP_REALSTACK = "1"
#         dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj
$ns = "skp"
$forwards = @(
    @{ svc = "rabbitmq";       local = 5673;  remote = 5672 },
    @{ svc = "baseapi-service";local = 18080; remote = 8080 },
    @{ svc = "otel-collector"; local = 14317; remote = 4317 },
    @{ svc = "otel-collector"; local = 18889; remote = 8889 },
    @{ svc = "redis";          local = 6380;  remote = 6379 }
)

foreach ($f in $forwards) {
    Start-Process -NoNewWindow -FilePath "kubectl" -ArgumentList @(
        "-n", $ns, "port-forward", "svc/$($f.svc)", "$($f.local):$($f.remote)"
    )
    Write-Output "forwarding $($f.svc) $($f.local) -> $($f.remote)"
}

Write-Output ""
Write-Output "Forwards die when their pod restarts. If live tests start failing, check these first."
```

- [ ] **Step 6: Run the suite (live tests still absent, nothing should change)**

Run: `dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: PASS, 149 total, 0 failed.

- [ ] **Step 7: Commit**

```bash
git add src/tests/BaseApi.Tests/Live k8s/port-forward-realstack.ps1
git commit -m "test: add the real-stack harness and its port-forward script"
```

---

### Task 8: Live test — identity resolves over the real broker

**Files:**
- Create: `src/tests/BaseApi.Tests/Live/IdentityBootstrapLiveTests.cs`

**Interfaces:**
- Consumes: `RealStack`, `RealStackFixture`, `BrokerIdentityBootstrap`

- [ ] **Step 1: Write the test**

```csharp
using BaseProcessor.Core.Boot;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace BaseApi.Tests.Live;

[Collection(RealStackCollection.Name)]
[Trait("Category", RealStack.Category)]
public sealed class IdentityBootstrapLiveTests
{
    private readonly RealStackFixture _stack;

    public IdentityBootstrapLiveTests(RealStackFixture stack) => _stack = stack;

    private IConfiguration ConfigFor(string sourceHash) =>
        new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["RabbitMq:Host"]           = RealStack.RabbitHost,
            ["RabbitMq:Port"]           = RealStack.RabbitPort.ToString(),
            ["RabbitMq:Username"]       = "guest",
            ["RabbitMq:Password"]       = "guest",
            ["Processor:RequestTimeout"] = "8",
            ["Processor:BackoffCap"]     = "5",
            ["SourceHashOverride"]       = sourceHash,
        }).Build();

    [Fact]
    public async Task ResolvesTheRegisteredRowOverTheRealBroker()
    {
        // The end-to-end claim the whole design rests on: a real RabbitMQ round-trip to a real BaseApi
        // reading a real Postgres row, completing before any host is built.
        RealStack.SkipUnlessEnabled();

        await using var bootstrap = new TestHashBootstrap(
            ConfigFor(_stack.SourceHash), _stack.SourceHash);

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(60));
        var identity = await bootstrap.ResolveAsync(cts.Token);

        Assert.Equal(_stack.ProcessorId, identity.Id);
        Assert.Equal(_stack.Name, identity.Name);
        Assert.Equal(_stack.Version, identity.Version);
    }

    [Fact]
    public async Task KeepsWaitingWhenNoRowIsRegistered()
    {
        // "Not found" is an ordinary early answer, not a failure — a processor image may legitimately
        // be deployed before anyone registers its row. The loop must outlast the wait, not give up.
        RealStack.SkipUnlessEnabled();

        var unregistered = new string('a', 64);
        await using var bootstrap = new TestHashBootstrap(ConfigFor(unregistered), unregistered);

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(12));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => bootstrap.ResolveAsync(cts.Token));
    }
}
```

- [ ] **Step 2: Add the source-hash override seam**

`BrokerIdentityBootstrap` reads its hash from assembly metadata, which in a test process is the test
assembly's. Add to `src/BaseProcessor.Core/Boot/BrokerIdentityBootstrap.cs`, replacing the
`ISourceHashProvider` registration:

```csharp
        // A configured hash wins over the assembly's. Production never sets it; a live test must, so
        // it can resolve a row it created rather than whatever hash the test host happens to carry.
        var configured = cfg["SourceHashOverride"];
        if (string.IsNullOrWhiteSpace(configured))
        {
            services.AddSingleton<ISourceHashProvider, Identity.AssemblyMetadataSourceHashProvider>();
        }
        else
        {
            services.AddSingleton<ISourceHashProvider>(new FixedSourceHashProvider(configured));
        }
```

And add, in the same file's namespace:

```csharp
/// <summary>
/// A source hash supplied by configuration rather than read from the assembly. Exists for the live
/// tests, which must resolve a row they created rather than the test host's own hash.
/// </summary>
internal sealed class FixedSourceHashProvider(string hash) : ISourceHashProvider
{
    public string Get() => hash;
}
```

Then delete the `TestHashBootstrap` references from the test and use `BrokerIdentityBootstrap`
directly with `NullLoggerFactory.Instance` and `TimeProvider.System`:

```csharp
        await using var bootstrap = new BrokerIdentityBootstrap(
            ConfigFor(_stack.SourceHash), NullLoggerFactory.Instance, TimeProvider.System);
```

- [ ] **Step 3: Run hermetically — the live tests must skip**

Run: `dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: PASS, 151 total, 2 skipped, 0 failed. **If the two live tests run instead of skipping, the
gate is broken — stop and fix it before continuing.**

- [ ] **Step 4: Run against the real stack**

```powershell
./k8s/port-forward-realstack.ps1
$env:SKP_REALSTACK = "1"
dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj
$env:SKP_REALSTACK = ""
```
Expected: PASS, 151 total, 0 skipped, 0 failed.

- [ ] **Step 5: Commit**

```bash
git add src/tests/BaseApi.Tests/Live/IdentityBootstrapLiveTests.cs src/BaseProcessor.Core/Boot/BrokerIdentityBootstrap.cs
git commit -m "test: resolve a real processor row over the live broker"
```

---

### Task 9: Live test — the boot puts identity on the resource

**Files:**
- Create: `src/tests/BaseApi.Tests/Live/TwoStageBootLiveTests.cs`

**Interfaces:**
- Consumes: `RealStack`, `RealStackFixture`, `ResourceReader`, `ProcessorHost`

- [ ] **Step 1: Write the test**

```csharp
using System.Net;
using BaseProcessor.Core.Identity;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using OpenTelemetry.Metrics;
using Xunit;

namespace BaseApi.Tests.Live;

[Collection(RealStackCollection.Name)]
[Trait("Category", RealStack.Category)]
public sealed class TwoStageBootLiveTests
{
    private readonly RealStackFixture _stack;

    public TwoStageBootLiveTests(RealStackFixture stack) => _stack = stack;

    private static int FreePort()
    {
        var l = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        l.Start();
        var port = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return port;
    }

    private Action<IConfigurationBuilder> Settings(int probePort) => cfg =>
        cfg.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Service:Name"]             = "processor",
            ["Service:Version"]          = "0.0.0",
            ["ConsoleHealth:Port"]       = probePort.ToString(),
            ["ConnectionStrings:Redis"]  = $"localhost:6380,abortConnect=false",
            ["RabbitMq:Host"]            = RealStack.RabbitHost,
            ["RabbitMq:Port"]            = RealStack.RabbitPort.ToString(),
            ["RabbitMq:Username"]        = "guest",
            ["RabbitMq:Password"]        = "guest",
            ["SourceHashOverride"]       = _stack.SourceHash,
        });

    [Fact]
    public async Task TheMetricsResourceCarriesTheRowIdentityNotTheSentinel()
    {
        // The claim this whole change exists to make true. If service.name is still "processor" here,
        // the boot resolved an identity and then failed to get it onto the resource — which is the
        // exact failure the SDK's immutable resource makes silent.
        RealStack.SkipUnlessEnabled();

        var probePort = FreePort();
        Environment.SetEnvironmentVariable("SKP_LIVE_PROBE_PORT", probePort.ToString());
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(90));

        using var host = await Processor.Sample.ProcessorHost.StartAsync(
            ["--environment", "Development"], cts.Token, Settings(probePort));

        var resource = ResourceReader.Read(host.Services.GetRequiredService<MeterProvider>());

        Assert.Equal(_stack.Name, resource["service.name"]);
        Assert.Equal(_stack.Version, resource["service.version"]);
        Assert.Equal(_stack.ProcessorId.ToString(), resource["processorId"]);
        Assert.Equal("worker", resource["source"]);

        await host.StopAsync(cts.Token);
    }

    [Fact]
    public async Task ServiceNameIsTheNameAloneWithNoVersionSuffix()
    {
        // The interpolated {name}_{version} form is deliberately gone: it buried the version inside the
        // name and left logs and metrics disagreeing about what service.name meant.
        RealStack.SkipUnlessEnabled();

        var probePort = FreePort();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(90));

        using var host = await Processor.Sample.ProcessorHost.StartAsync(
            ["--environment", "Development"], cts.Token, Settings(probePort));

        var resource = ResourceReader.Read(host.Services.GetRequiredService<MeterProvider>());

        Assert.DoesNotContain("_", (string)resource["service.name"]);

        await host.StopAsync(cts.Token);
    }

    [Fact]
    public async Task TheContextIsSeededSoTheOrchestratorNeverAsks()
    {
        RealStack.SkipUnlessEnabled();

        var probePort = FreePort();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(90));

        using var host = await Processor.Sample.ProcessorHost.StartAsync(
            ["--environment", "Development"], cts.Token, Settings(probePort));

        var context = host.Services.GetRequiredService<IProcessorContext>();

        Assert.Equal(_stack.ProcessorId, context.Identity?.Id);

        await host.StopAsync(cts.Token);
    }
}
```

- [ ] **Step 2: Run hermetically**

Run: `dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: PASS, 154 total, 5 skipped, 0 failed.

- [ ] **Step 3: Run against the real stack**

```powershell
$env:SKP_REALSTACK = "1"
dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj
$env:SKP_REALSTACK = ""
```
Expected: PASS, 154 total, 0 skipped, 0 failed.

- [ ] **Step 4: Commit**

```bash
git add src/tests/BaseApi.Tests/Live/TwoStageBootLiveTests.cs
git commit -m "test: assert the live boot puts the row identity on the resource"
```

---

### Task 10: Live test — the identity reaches the collector

**Files:**
- Create: `src/tests/BaseApi.Tests/Live/CollectorLiveTests.cs`

**Interfaces:**
- Consumes: `RealStack`, `RealStackFixture`, `ProcessorHost`

- [ ] **Step 1: Write the test**

```csharp
using System.Net;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using OpenTelemetry.Metrics;
using Xunit;

namespace BaseApi.Tests.Live;

[Collection(RealStackCollection.Name)]
[Trait("Category", RealStack.Category)]
public sealed class CollectorLiveTests
{
    private readonly RealStackFixture _stack;

    public CollectorLiveTests(RealStackFixture stack) => _stack = stack;

    private static int FreePort()
    {
        var l = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        l.Start();
        var port = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return port;
    }

    [Fact]
    public async Task ThisProcessorsSeriesAppearAtTheCollectorTaggedWithItsProcessorId()
    {
        // The final link. Everything before this proves the resource is right in-process; this proves
        // the collector actually receives it, which is what a dashboard queries.
        RealStack.SkipUnlessEnabled();

        var probePort = FreePort();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(120));

        using var host = await Processor.Sample.ProcessorHost.StartAsync(
            ["--environment", "Development"], cts.Token,
            cfg => cfg.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Service:Name"]                 = "processor",
                ["Service:Version"]              = "0.0.0",
                ["ConsoleHealth:Port"]           = probePort.ToString(),
                ["ConnectionStrings:Redis"]      = "localhost:6380,abortConnect=false",
                ["RabbitMq:Host"]                = RealStack.RabbitHost,
                ["RabbitMq:Port"]                = RealStack.RabbitPort.ToString(),
                ["RabbitMq:Username"]            = "guest",
                ["RabbitMq:Password"]            = "guest",
                ["SourceHashOverride"]           = _stack.SourceHash,
                ["OTEL_EXPORTER_OTLP_ENDPOINT"]  = RealStack.OtlpEndpoint,
            }));

        // ForceFlush rather than waiting out the periodic reader's default minute — the export is what
        // is under test, not the SDK's schedule.
        Assert.True(host.Services.GetRequiredService<MeterProvider>().ForceFlush(10_000));

        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        var needle = $"processorId=\"{_stack.ProcessorId}\"";
        var deadline = DateTime.UtcNow.AddSeconds(60);
        var found = false;

        while (DateTime.UtcNow < deadline && !found)
        {
            var body = await http.GetStringAsync(RealStack.CollectorMetricsUrl, cts.Token);
            found = body.Contains(needle, StringComparison.Ordinal);

            if (!found)
            {
                await Task.Delay(TimeSpan.FromSeconds(3), cts.Token);
            }
        }

        Assert.True(found,
            $"no series at {RealStack.CollectorMetricsUrl} carried {needle} within 60s");

        await host.StopAsync(cts.Token);
    }
}
```

The `OTEL_EXPORTER_OTLP_ENDPOINT` key works through configuration because the OTLP exporter reads it
from `IConfiguration` when one is present in the container, which `Host.CreateApplicationBuilder`
guarantees. If the export does not land, set the process environment variable instead:
`Environment.SetEnvironmentVariable("OTEL_EXPORTER_OTLP_ENDPOINT", RealStack.OtlpEndpoint)` before
`StartAsync`, and restore it afterwards.

- [ ] **Step 2: Run hermetically**

Run: `dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: PASS, 155 total, 6 skipped, 0 failed.

- [ ] **Step 3: Run against the real stack**

```powershell
$env:SKP_REALSTACK = "1"
dotnet run --project src/tests/BaseApi.Tests/BaseApi.Tests.csproj
$env:SKP_REALSTACK = ""
```
Expected: PASS, 155 total, 0 skipped, 0 failed.

- [ ] **Step 4: Verify by hand what the collector now shows**

```bash
curl -s http://localhost:18889/metrics | grep -o 'processorId="[^"]*"' | sort | uniq -c
curl -s http://localhost:18889/metrics | grep -o 'job="[^"]*"' | sort | uniq -c
```
Expected: a `processorId` matching the fixture's row, and a `job` carrying the fixture's `Name`
rather than `unresolved_0.0.0` or `processor_0.0.0`.

- [ ] **Step 5: Commit**

```bash
git add src/tests/BaseApi.Tests/Live/CollectorLiveTests.cs
git commit -m "test: assert the row identity reaches the collector"
```

---

### Task 11: Deploy the rebuilt image and confirm against the cluster

**Files:**
- Modify: `docs/superpowers/specs/2026-08-19-processor-two-stage-boot-design.md` (status note only)

The processor image currently running in `skp` is built from `references/`, not `src/` — its log
scopes name `BaseProcessor.Core.Processing.*`, which does not exist in `src/`. Nothing in this plan
is observable in the cluster until that is replaced.

- [ ] **Step 1: Build and load the image**

The build context is the repo root, not the project directory — the Dockerfile says so in its first
line, and the `SourceHash` MSBuild target runs inside its publish step.

```bash
docker build -f src/Processor.Sample/Dockerfile -t processor-sample:local .
kind load docker-image processor-sample:local --name desktop
kubectl -n skp rollout restart deploy/processor-sample
kubectl -n skp rollout status deploy/processor-sample --timeout=180s
```

The hash the container claims must match the row registered for it, or Stage 1 waits forever. That is
not a new exposure and not hard to spot: `BrokerIdentityBootstrap` logs `no processor registered for
source hash {Hash}` with the actual hash on every retry, to stdout, and the pod keeps its probes
green so it never restarts and never loses those logs. `kubectl logs` names the problem outright.

Read the `identity resolved` line before concluding the rollout worked — as the fastest confirmation
it did, not as a guard against something subtle.

- [ ] **Step 2: Confirm the probes survived the boot**

```bash
kubectl -n skp get pods -l app=processor-sample
kubectl -n skp logs -l app=processor-sample --tail=40
```
Expected: `Running`, `0` restarts, and a log line `identity resolved: processor <guid> (<name> <version>)`
from `BrokerIdentityBootstrap` printed to stdout before any OTel wiring.

- [ ] **Step 3: Confirm the resource in the collector**

```bash
kubectl -n skp port-forward svc/otel-collector 18889:8889 &
curl -s http://127.0.0.1:18889/metrics | grep -o 'job="[^"]*"' | sort | uniq -c
curl -s http://127.0.0.1:18889/metrics | grep -o 'processorId="[^"]*"' | sort | uniq -c
```
Expected: no `unresolved_0.0.0` and no `processor_0.0.0` for the processor; a real name, and a
`processorId` matching its row.

- [ ] **Step 4: Confirm the logs in Elasticsearch**

```bash
kubectl -n skp port-forward svc/elasticsearch 19200:9200 &
curl -s 'http://127.0.0.1:19200/logs-generic.otel-default/_search?size=1' \
  -H 'Content-Type: application/json' \
  -d '{"query":{"bool":{"filter":[{"term":{"resource.attributes.Source":"worker"}}]}},"sort":[{"@timestamp":"desc"}]}'
```
Expected: `resource.attributes.service.name` is the row's name, `service.version` its version,
`ProcessorId` present, `Source` = `worker`, and no `IdentityName` attribute anywhere.

- [ ] **Step 5: Record the outcome and commit**

Add a `## 6. Verified` section to the spec naming the date, the image digest, and the observed
`service.name` / `processorId`.

```bash
git add docs/superpowers/specs/2026-08-19-processor-two-stage-boot-design.md
git commit -m "docs: record the two-stage boot verified against the cluster"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| §2 Stage 0 probe listener | 2 |
| §2 Stage 1 unbounded resolution | 3 |
| §2 Stage 2 wiring with identity | 1, 6 |
| §2.1 probes keep the pod alive | 2, 4 |
| §2.2 Redis absent from Stage 1 | 3 (no Redis registration in the bootstrap container) |
| §2.3 Loop A removed | 5 |
| §3 resource contract | 1, 6, 9 |
| §3 metrics `service.name` = name only | 1, 9 |
| §3.1 `ProcessorId` on both signals | 1, 6, 9, 10 |
| §3.2 what lands in Prometheus | 10, 11 |
| §4 one extra broker connect | 3 (bootstrap disposes before the host builds) |
| §4 sub-second probe gap | 4 (port released in `finally`) |

**Known gaps, deliberate:** §4's two optional mitigations (collector `filelog` receiver, BaseApi miss
counter) are listed as out of scope in the spec and have no task. §5's items are out of scope.

**Placeholder scan:** every code step carries the actual code. Three steps carry a conditional
fallback rather than a single answer — Task 7 Step 2 (`Assert.SkipUnless` availability), Task 7
Step 4 (the create response's id property), Task 10 Step 1 (`OTEL_EXPORTER_OTLP_ENDPOINT` via
configuration versus environment). Each names the exact check and the exact alternative, because each
depends on a version or serialisation detail that must be observed rather than assumed.

**Type consistency:** `ProcessorIdentityFound` is used with its real six-parameter shape throughout.
`AddBaseConsoleObservability`'s new parameters are named identically in Tasks 1, 6 and their tests.
`IIdentityBootstrap.ResolveAsync` has one signature everywhere. `BootProbeListener.StartAsync(int,
CancellationToken)` matches its four call sites. `ProcessorHost.Create` takes
`(string[], ProcessorIdentityFound, Action<IConfigurationBuilder>?)` in Tasks 6, 9 and 10.

**Test-count arithmetic:** 135 baseline → 139 (T1) → 143 (T2) → 146 (T3) → 150 (T4) → 148 (T5, four
removed two added) → 149 (T6) → 151 (T8) → 154 (T9) → 155 (T10). Treat these as expectations to
check, not as assertions — if a count differs, find out why before proceeding.
