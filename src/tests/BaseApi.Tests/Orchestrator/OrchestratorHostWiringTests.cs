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
using StackExchange.Redis;
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
    /// The one orchestrator host this test process ever builds. Every test below reads it, and neither
    /// it nor its container is ever disposed.
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
    /// <b>One host, and never disposed, because Quartz's logging is process-global and this file is
    /// one line away from arming it.</b>
    /// </para>
    /// <para>
    /// <c>Quartz.Logging.LogProvider</c> holds a static provider wrapping an <c>ILoggerFactory</c>,
    /// and what sets it is <b>creating a scheduler</b> — <c>ISchedulerFactory.GetScheduler()</c> —
    /// from some container. Dispose that container afterwards and the next Quartz call anywhere in
    /// the process resolves a logger from a disposed factory and throws
    /// <c>ObjectDisposedException</c>; the blast radius includes <c>WorkflowSchedulerTests</c>, which
    /// shares nothing else with this file.
    /// </para>
    /// <para>
    /// <b>Nothing here creates a scheduler today, and that was measured rather than assumed.</b> A
    /// throwaway probe built this host twice in a row, each time resolving <c>ISchedulerFactory</c>
    /// and enumerating all eight hosted services and disposing: no throw. Adding one
    /// <c>GetScheduler()</c> to the first iteration made the second throw
    /// <c>ObjectDisposedException</c> immediately. That is also the history of this file — the
    /// hazard appeared when the host registered a scheduler by blocking on <c>GetScheduler()</c>,
    /// and went away when <c>WorkflowScheduler&lt;TJob&gt;</c> took the factory instead.
    /// </para>
    /// <para>
    /// So this fixture is one build ahead of a hazard rather than on top of one: any test that starts
    /// the host, or schedules anything, creates a scheduler and arms it. Keeping a single host means
    /// that when that day comes there is no second container to be poisoned. Nothing here needs a
    /// second one anyway — the container is immutable and every assertion below is about what is
    /// registered in it. Do not add a test that builds one.
    /// </para>
    /// <para>
    /// <b>The Redis multiplexer is the one thing that is disposed, and it is not a softening of that
    /// rule.</b> <c>EveryLoopIsHosted</c> enumerates <c>IHostedService</c>, which constructs
    /// <c>L2GateProbe</c>, which resolves an <see cref="IConnectionMultiplexer"/> — and that
    /// constructor connects, so an undisposed one spends the rest of the run reconnecting to a Redis
    /// this suite never intends to reach. Disposing that one object releases the socket without
    /// touching the container, which is what the paragraphs above forbid: the container is what holds
    /// the <c>ILoggerFactory</c> that Quartz's process-global <c>LogProvider</c> would capture.
    /// </para>
    /// </summary>
    public sealed class BuiltHost : IDisposable
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

        /// <summary>
        /// xUnit v3 disposes a class fixture once the last test in the class has run. Only the
        /// multiplexer, and never <c>Host</c> or its container — see the remarks above for what
        /// disposing either would do to an unrelated test file.
        /// </summary>
        public void Dispose() => Host.Services.GetRequiredService<IConnectionMultiplexer>().Dispose();
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
    public void HydrationIsReportedThroughReadiness()
    {
        // Where "this replica has mirrored L2" lives now that the startup gate reports only that the
        // loop is running. `ready` and nothing else: an un-hydrated replica is starting correctly, so
        // `live` would restart it for waiting and `startup` would spend a finite budget on an outage
        // no restart repairs. Nothing routes traffic here, so all this gates is the READY column —
        // which is the point, because 0/1 is then a truthful "not hydrated".
        var registration = Assert.Single(
            _host.Services.GetRequiredService<IOptions<HealthCheckServiceOptions>>().Value.Registrations,
            r => r.Name == OrchestratorHost.HydrationReady);

        Assert.Equal(["ready"], registration.Tags);
        Assert.Equal(HealthStatus.Unhealthy, registration.FailureStatus);
        Assert.IsType<HydrationReadyHealthCheck>(registration.Factory(_host.Services));
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
    public void TopologyIsDeclaredByHoldingTheConnection()
    {
        // The whole point of ConnectionTopologyDeclarer is that "the topology exists" stays a
        // consequence of opening the shared connection. Any other ITopologyDeclarer — a no-op, or a
        // second declaration path — satisfies hydration's await without the queue existing, which is
        // precisely the bug the seam was cut to prevent: hydration reads L2 through a queue that is
        // not there yet, and announcements published in that window are lost to this replica for
        // good. That failure is invisible to every other test here, because a substitute declarer is
        // what the hydration tests deliberately use.
        Assert.IsType<ConnectionTopologyDeclarer>(
            _host.Services.GetRequiredService<ITopologyDeclarer>());
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
        //
        // From a scope, because that is what production does: Quartz's Microsoft DI job factory opens
        // a scope per fire and builds the job inside it. Resolving from the root would be stricter
        // than the real path rather than more faithful to it — the day this job legitimately takes a
        // scoped dependency, a root resolution fails under ValidateScopes while every actual fire is
        // fine.
        using var scope = _host.Services.CreateScope();

        Assert.NotNull(scope.ServiceProvider.GetRequiredService<WorkflowFireJob>());
    }
}
