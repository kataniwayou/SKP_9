using BaseApi.Tests.Orchestrator;
using BaseConsole.Core.DependencyInjection;
using BaseConsole.Core.Health;
using BaseConsole.Core.Loop;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using Orchestrator.Hydration;
using Orchestrator.L1;
using Orchestrator.Messaging;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Live;

/// <summary>
/// The one link in the orchestrator's outage story that no hermetic test can reach: that the
/// <see cref="IConnectionMultiplexer"/> the process built against a dead Redis starts answering on its
/// own once Redis returns, without being disposed, rebuilt, or restarted around.
/// <para>
/// <b>Why the hermetic suite cannot cover this.</b> <c>HydrationServiceTests</c> proves the loop
/// recovers — <c>StopsRetryingOnTheFirstAttemptThatSucceeds</c> drives two store faults and then a
/// success — but it does so through a substituted <see cref="IDatabase"/> that is simply told to stop
/// throwing. A substitute cannot be wrong about reconnection, so that assertion is about the loop and
/// nothing else. Everything downstream of the loop rests instead on a property of StackExchange.Redis:
/// that <c>Connect</c> with <see cref="ConfigurationOptions.AbortOnConnectFail"/> <c>false</c> returns
/// a multiplexer which keeps reconnecting in the background. <c>ConsoleRedisConnectionOptions</c>
/// states that assumption in prose — "the multiplexer always exists and may simply be disconnected" —
/// and this is what makes it a checked claim. Were it false, no amount of retrying would help and the
/// only repair would be the pod restart the whole design exists to avoid.
/// </para>
/// <para>
/// <b>Outside <c>RealStackCollection</c>, deliberately.</b> That collection's fixture registers a
/// processor row over BaseApi, which couples anything joining it to BaseApi and Postgres being up.
/// This test needs Redis and nothing else, and a failure here should mean Redis — so it takes the
/// fixture's absence over a second way to go red. It reads L2 and never writes it (spec invariant 1),
/// and it owns its own loopback port, so running beside the rest of the suite is safe.
/// </para>
/// </summary>
[Trait("Category", RealStack.Category)]
public sealed class RedisReconnectLiveTests
{
    /// <summary>
    /// How long to wait for hydration to complete after Redis comes back. Generous against the loop's
    /// own 30s backoff cap: the endpoint is opened after only the second attempt, when the delay is
    /// still a few seconds, so the real wait is far shorter. This bound is what turns a multiplexer
    /// that never reconnects into a failure carrying a reason rather than a hung run.
    /// </summary>
    private static readonly TimeSpan RecoveryBudget = TimeSpan.FromSeconds(90);

    [Fact]
    public async Task TheMultiplexerReconnectsAndHydrationCompletesWithoutARestart()
    {
        RealStack.SkipUnlessEnabled();

        // Closed to begin with, so the multiplexer below is built against an endpoint that refuses —
        // the state a replica actually boots into when Redis is down, and not the same thing as a
        // connection that was once healthy and then dropped.
        await using var redisEndpoint =
            TcpForwarder.ReserveClosed(RealStack.RedisHost, RealStack.RedisPort);

        // The production parse path, not a hand-built ConfigurationOptions: forcing AbortOnConnectFail
        // to false is what makes a multiplexer exist at all here, so the test has to go through the
        // code that forces it or it is exercising a configuration nothing ships.
        var options = ConsoleRedisConnectionOptions.ParseForcingNonAborting(
            $"{redisEndpoint.Endpoint},connectTimeout=1000");

        using var redis = ConnectionMultiplexer.Connect(options);

        // The premise. If this were already connected, the reserved port leaked to something else and
        // every assertion below would be vacuous.
        Assert.False(redis.IsConnected);

        var store = new WorkflowL1Store();
        var reader = new L2WorkflowReader(redis, NullLogger<L2WorkflowReader>.Instance);
        var admission = new HydrationAdmission();
        var startupGate = new StartupGate();
        var heartbeat = new LoopHeartbeat(TimeProvider.System);

        var hydration = new HydrationService(
            // A substitute declarer: the broker is a second live dependency, and a test taking both
            // could go red for either. The declare-before-read ordering it stands in for is asserted
            // hermetically by HydrationServiceTests.DeclaresThisReplicasTopologyBeforeItReadsL2.
            Substitute.For<ITopologyDeclarer>(),
            reader,
            new WorkflowActivator(
                reader, store, new RecordingWorkflowScheduler(),
                NullLogger<WorkflowActivator>.Instance),
            admission,
            startupGate,
            // The real clock. The backoff waited out here is a real wait against a real socket, and a
            // FakeTimeProvider would skip the very interval the multiplexer reconnects during.
            TimeProvider.System,
            heartbeat,
            NullLogger<HydrationService>.Instance);

        using var cts = new CancellationTokenSource();
        var run = hydration.RunUntilHydratedAsync(cts.Token);

        try
        {
            await WaitUntilAsync(
                () => heartbeat.Last is not null,
                TimeSpan.FromSeconds(30),
                "the hydration loop never took its first pass");

            var firstPass = heartbeat.Last!.Value;

            // A second stamp is the only evidence available that the loop came back round rather than
            // beating once and wedging against the dead endpoint.
            await WaitUntilAsync(
                () => heartbeat.Last > firstPass,
                TimeSpan.FromSeconds(30),
                "the hydration loop stopped beating while Redis was unreachable");

            // The outage-survival properties, now against a real multiplexer rather than a substitute
            // told to throw: un-admitted, so /health/ready is red and nothing is consumed against a
            // half-built L1 — but startable, so the kubelet's finite startup budget never fires and
            // all three replicas are not killed for a fault a restart cannot repair.
            Assert.False(admission.IsOpen);
            Assert.True(startupGate.IsReady);

            // Redis comes back. Nothing else changes: same process, same multiplexer instance, same
            // loop still sitting in its backoff.
            redisEndpoint.Open();

            await WaitUntilAsync(
                () => admission.IsOpen,
                RecoveryBudget,
                "hydration never completed after the Redis endpoint came back — the multiplexer did "
                + "not reconnect on its own, so a pod restart would be the only repair");

            // The claim in full: the loop finished and retired its heartbeat (without which a healthy
            // pod fails liveness one window later), and the multiplexer now answering is the one that
            // was built against a dead endpoint.
            Assert.True(heartbeat.IsRetired);
            Assert.True(redis.IsConnected);

            // And the loop actually returned rather than merely opening admission. An empty parent
            // index is a legitimate answer on a fresh cluster, so no count is asserted — the read
            // completing against real L2 is the property.
            await run.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        }
        finally
        {
            cts.Cancel();
        }
    }

    /// <summary>
    /// Polls <paramref name="condition"/> until it holds or <paramref name="budget"/> expires, failing
    /// with <paramref name="because"/> rather than a bare timeout — a run that ends on the clock
    /// should say which of the several waits here it was.
    /// </summary>
    private static async Task WaitUntilAsync(Func<bool> condition, TimeSpan budget, string because)
    {
        var deadline = DateTime.UtcNow + budget;

        while (DateTime.UtcNow < deadline)
        {
            if (condition())
            {
                return;
            }

            await Task.Delay(TimeSpan.FromMilliseconds(200), TestContext.Current.CancellationToken);
        }

        Assert.Fail($"{because} (waited {budget})");
    }
}
