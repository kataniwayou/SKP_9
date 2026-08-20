using BaseConsole.Core.DependencyInjection;
using BaseConsole.Core.Gating;
using BaseConsole.Core.Health;
using BaseConsole.Core.Loop;
using BaseConsole.Core.Messaging;
using Orchestrator;
using Orchestrator.Hydration;
using Orchestrator.Messaging;
using Orchestrator.Scheduling;
using Messaging.Transport;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using Xunit;

namespace BaseApi.Tests.Orchestrator;

/// <summary>
/// A composition root fails at resolution time, not compile time, so the graph actually building is
/// the one thing worth asserting about a shell — the same idiom as <c>ProcessorSampleTests</c> on the
/// processor side.
/// </summary>
public sealed class OrchestratorHostWiringTests : IClassFixture<OrchestratorHostWiringTests.BuiltHost>
{
    /// <summary>
    /// The one orchestrator host this test process ever builds. Every test below reads it, and it is
    /// deliberately never disposed.
    /// <para>
    /// <b>Development, so that both validations run.</b> .NET 8's <c>HostApplicationBuilder</c> derives
    /// both <c>ServiceProviderOptions.ValidateOnBuild</c> <i>and</i> <c>ValidateScopes</c> from
    /// <c>IsDevelopment()</c>, and nothing in <c>src/</c> overrides that. So this one word buys the
    /// constructor-graph walk over every registered service <i>and</i> the check that no singleton
    /// captures a scoped service — which matters because this host has scoped registrations
    /// (<c>ApplyStartHandler</c>/<c>ApplyStopHandler</c>) sitting beside singletons that could
    /// plausibly reach them. If either check fails, constructing this fixture throws and every test in
    /// the class reports it. This file built leniently, under Production, for exactly as long as
    /// <c>IWorkflowScheduler</c> had no registration; that hole is closed and the narrowing is gone
    /// with it.
    /// </para>
    /// <para>
    /// <b>One host, and never disposed, because Quartz's logging is process-global.</b>
    /// <c>Quartz.Logging.LogProvider</c> holds a static provider wrapping an <c>ILoggerFactory</c>,
    /// and Quartz's DI integration sets it from the container that first resolves a scheduler
    /// factory. Dispose that container and every later Quartz call in the process —
    /// including <c>WorkflowSchedulerTests</c>' own schedulers, which share nothing else with this
    /// file — resolves a logger from a disposed factory and throws <c>ObjectDisposedException</c>.
    /// Building once and leaving it alive is what keeps that static pointing at a factory that is
    /// still there. A test that builds and disposes a second host would put the hazard back, so do
    /// not add one; nothing here needs it, since the container is immutable and every assertion below
    /// is about what is registered in it.
    /// </para>
    /// </summary>
    public sealed class BuiltHost
    {
        public IHost Host { get; } = OrchestratorHost.Create(
            ["--environment", "Development"],
            cfg => cfg.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Service:Name"]            = "orchestrator",
                ["Service:Version"]         = "0.0.0",
                ["ConnectionStrings:Redis"] = "localhost:6379,abortConnect=false",
                ["RabbitMq:Host"]           = "localhost",
                ["RabbitMq:Username"]       = "guest",
                ["RabbitMq:Password"]       = "guest",
            }));
    }

    private readonly IHost _host;

    public OrchestratorHostWiringTests(BuiltHost fixture)
    {
        ArgumentNullException.ThrowIfNull(fixture);
        _host = fixture.Host;
    }

    [Fact]
    public void TheHostGraphResolves()
    {
        // Everything this test claims happened inside Create, in the fixture above: ValidateOnBuild
        // walked every registered service's constructor graph and threw an AggregateException naming
        // each one it could not satisfy, and ValidateScopes rejected any singleton taking a scoped
        // dependency. Having a host to assert on at all is the result.
        Assert.NotNull(_host);
    }

    [Fact]
    public void TheReplicaIdentityResolves()
    {
        Assert.NotNull(_host.Services.GetRequiredService<InstanceId>());
    }

    [Fact]
    public void TheTopologyIsRegistered()
    {
        Assert.Contains(_host.Services.GetServices<IRabbitMqTopology>(), t => t is OrchestratorTopology);
    }

    [Fact]
    public void AdmissionIsTheHydrationLatchAndNotTheAlwaysOpenDefault()
    {
        // The one wiring mistake in this host that fails in complete silence. AddBaseConsoleGating
        // TryAdds AlwaysOpenAdmission as the default IConsumerAdmission, so any registration that
        // fails to beat it — dropped, or written as a TryAdd below that call — leaves the default in
        // place with no error and no log, and the replica consumes announcements before it has
        // mirrored L2. Nothing else in the suite can see that happen.
        //
        // Both of those were checked by mutation rather than assumed, and the second corrected a
        // claim this file and two others used to make: moving the plain AddSingleton below gating
        // does NOT break the latch, because a single-service lookup returns the LAST registration.
        // It is a TryAdd below gating that loses, and that is the case this test catches.
        Assert.IsType<HydrationAdmission>(_host.Services.GetRequiredService<IConsumerAdmission>());
    }

    [Fact]
    public void TheAdmissionTheLoopOpensIsTheOneTheConsumerReads()
    {
        // Two registrations, one instance. Registering the concrete type and the interface separately
        // would give the hydration loop a latch of its own to open while the gated consumer went on
        // reading a second one that never opens — a deadlock in which the queue fills forever.
        Assert.Same(
            _host.Services.GetRequiredService<HydrationAdmission>(),
            _host.Services.GetRequiredService<IConsumerAdmission>());
    }

    [Fact]
    public void TheHydrationLoopIsWatchedForLiveness()
    {
        // A heartbeat nobody reads proves nothing. A wedged hydration loop never opens the admission,
        // so the queue fills forever while every probe stays green — and nothing inside the process
        // can restart a loop that is gone, which is why `live` is the tag and the only one.
        var registration = Assert.Single(
            _host.Services.GetRequiredService<IOptions<HealthCheckServiceOptions>>().Value.Registrations,
            r => r.Name == OrchestratorHost.HydrationLoop);

        Assert.Equal(["live"], registration.Tags);
        Assert.Equal(HealthStatus.Unhealthy, registration.FailureStatus);

        // Constructing it is what proves the keyed heartbeat resolves. An unkeyed lookup here would
        // fail to resolve at startup, and this is the only place that would say so.
        Assert.IsType<LoopLivenessHealthCheck>(registration.Factory(_host.Services));
    }

    [Fact]
    public void EachLoopHasItsOwnHeartbeatHolder()
    {
        // Both heartbeats are keyed, and they must be two holders rather than one. A holder shared
        // between two loops lets the live loop's beat refresh the stamp the dead loop's liveness check
        // reads, so a stopped loop stays invisible for as long as any other loop is turning. Both keys
        // are read from the code that owns them, never restated as literals here.
        var gate = _host.Services.GetRequiredKeyedService<ILoopHeartbeat>(
            ConsoleRedisServiceCollectionExtensions.GateLoop);
        var hydration = _host.Services.GetRequiredKeyedService<ILoopHeartbeat>(
            OrchestratorHost.HydrationLoop);

        Assert.NotSame(gate, hydration);
    }

    [Fact]
    public void EveryLoopIsHosted()
    {
        // Enumerating IHostedService constructs every one of them, which is why this could not be
        // asserted while the scheduling stack was incomplete: the hydration loop reaches
        // WorkflowActivator, and WorkflowActivator reaches IWorkflowScheduler. It is back because the
        // graph is startable now, and it is the only test that proves the loops are actually started
        // rather than merely resolvable — a HydrationService that resolved but was never hosted would
        // leave the admission shut for the life of the process, with every probe green.
        var hosted = _host.Services.GetServices<IHostedService>().ToList();

        Assert.Contains(hosted, s => s is HydrationService);
        Assert.Contains(hosted, s => s is L2GateProbe);
        Assert.Contains(hosted, s => s is EmbeddedHealthEndpointService);
    }

    [Fact]
    public void TheHealthSurfaceIsRegistered()
    {
        var registrations = _host.Services
            .GetRequiredService<IOptions<HealthCheckServiceOptions>>().Value.Registrations;

        Assert.NotNull(_host.Services.GetRequiredService<IStartupGate>());
        Assert.Contains(registrations, r => r.Name == "self");
        Assert.Contains(registrations, r => r.Name == "startup");
    }

    [Fact]
    public void BothApplyHandlersAreRegisteredPerDelivery()
    {
        // Resolved from a scope, not the root: the handlers are scoped so each delivery gets its own,
        // and under ValidateScopes a root resolution of a scoped service throws. Both must be present
        // — the consumer dispatches by message type across whatever this enumeration yields, so a
        // handler missing from it means announcements of that type are refused rather than applied,
        // and the replica silently stops tracking one half of the workflow lifecycle.
        using var scope = _host.Services.CreateScope();

        var handlers = scope.ServiceProvider.GetServices<IQueueMessageHandler>().ToList();

        Assert.Contains(handlers, h => h is ApplyStartHandler);
        Assert.Contains(handlers, h => h is ApplyStopHandler);
    }

    [Fact]
    public void TheSchedulerIsClosedOverTheFireJob()
    {
        // WorkflowScheduler<TJob> leaves the job type open so the scheduling mechanics can be tested
        // against an inert job. The host is the one place that closes it, and closing it over anything
        // other than WorkflowFireJob would leave every trigger firing a job that dispatches nothing —
        // schedules intact, workflows silently dead.
        Assert.IsType<WorkflowScheduler<WorkflowFireJob>>(
            _host.Services.GetRequiredService<IWorkflowScheduler>());
    }

    [Fact]
    public void TheFireJobResolvesWithEveryDependency()
    {
        // Quartz builds the job from this container on every fire. An unregistered dependency of it
        // would surface on the first trigger, on a background thread, long after start — so it is
        // resolved here instead, where the gap is a test failure rather than a workflow that quietly
        // never fires.
        Assert.NotNull(_host.Services.GetRequiredService<WorkflowFireJob>());
    }
}
