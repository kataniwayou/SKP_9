using System.Text.Json;
using BaseConsole.Core.Health;
using BaseConsole.Core.Loop;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using NSubstitute;
using NSubstitute.ExceptionExtensions;
using Orchestrator.Hydration;
using Orchestrator.L1;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Orchestrator;

/// <summary>
/// Loop 2. Three claims, and they are the three things that go wrong silently if this loop is written
/// carelessly: that every workflow L2 lists actually reaches L1, that an unreachable L2 leaves the pod
/// alive and still beating rather than restarting into the same outage, and that the admission latch
/// and the heartbeat's retirement happen together with success and never before it.
/// </summary>
public sealed class HydrationServiceTests
{
    private static readonly Guid W1 = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid W2 = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid S = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid P = Guid.Parse("44444444-4444-4444-4444-444444444444");

    private sealed class Harness
    {
        private readonly List<RedisValue> _index = [];
        private readonly L2WorkflowReader _reader;

        public IDatabase Db { get; } = Substitute.For<IDatabase>();

        public WorkflowL1Store Store { get; } = new();

        public RecordingWorkflowScheduler Scheduler { get; } = new();

        public HydrationAdmission Admission { get; } = new();

        public StartupGate StartupGate { get; } = new();

        public FakeTimeProvider Clock { get; } = new();

        public LoopHeartbeat Heartbeat { get; }

        public CancellationTokenSource Cts { get; } = new();

        public Harness()
        {
            var redis = Substitute.For<IConnectionMultiplexer>();
            redis.GetDatabase().Returns(Db);

            _reader = new L2WorkflowReader(redis, NullLogger<L2WorkflowReader>.Instance);
            Heartbeat = new LoopHeartbeat(Clock);

            // Nothing stubs the parent index by default: an unstubbed array-returning member yields an
            // empty array, which is what an empty L2 looks like to the reader.
        }

        /// <summary>
        /// Puts <paramref name="workflowId"/> in the parent index and writes the same root and step
        /// keys <c>L2ProjectionWriter</c> writes, so hydration reads the store the API produces rather
        /// than one shaped for the test.
        /// </summary>
        public Harness WithWorkflow(Guid workflowId, string? cron)
        {
            _index.Add(workflowId.ToString("D"));
            Db.SetMembersAsync(L2ProjectionKeys.ParentIndex(), Arg.Any<CommandFlags>())
                .Returns(_index.ToArray());

            Db.StringGetAsync(L2ProjectionKeys.Root(workflowId), Arg.Any<CommandFlags>())
                .Returns((RedisValue)JsonSerializer.Serialize(
                    new WorkflowRootProjection(
                        EntryStepIds: [S],
                        StepIds: [S],
                        Cron: cron,
                        Liveness: new LivenessProjection(DateTime.UtcNow, 3600, "Pending")),
                    MessagingJson.Options));

            Db.StringGetAsync(L2ProjectionKeys.Step(workflowId, S), Arg.Any<CommandFlags>())
                .Returns((RedisValue)JsonSerializer.Serialize(
                    new StepProjection(
                        EntryCondition: 0, ProcessorId: P, Payload: "{}", NextStepIds: []),
                    MessagingJson.Options));

            return this;
        }

        /// <summary>An L2 that cannot be reached at all — the index read itself faults.</summary>
        public Harness WithStoreFault()
        {
            Db.SetMembersAsync(L2ProjectionKeys.ParentIndex(), Arg.Any<CommandFlags>())
                .ThrowsAsync(new RedisConnectionException(ConnectionFailureType.SocketFailure, "down"));

            return this;
        }

        public HydrationService Build() => new(
            _reader,
            new WorkflowActivator(
                _reader, Store, Scheduler, NullLogger<WorkflowActivator>.Instance),
            Admission,
            StartupGate,
            Clock,
            Heartbeat,
            NullLogger<HydrationService>.Instance);

        /// <summary>
        /// Advances the fake clock through <paramref name="span"/> a second at a time, giving the pool
        /// a moment to resume the loop between steps. A <see cref="FakeTimeProvider"/> moves only when
        /// something reads it and nothing reads it while a delay is pending, so a loop waiting out its
        /// backoff never wakes unless the clock is pushed from here.
        /// </summary>
        public void PumpTime(TimeSpan span)
        {
            for (var elapsed = TimeSpan.Zero; elapsed < span; elapsed += TimeSpan.FromSeconds(1))
            {
                Clock.Advance(TimeSpan.FromSeconds(1));
                Thread.Sleep(1);
            }
        }
    }

    [Fact]
    public async Task MirrorsEveryWorkflowInTheParentIndex()
    {
        var h = new Harness().WithWorkflow(W1, "0 * * * *").WithWorkflow(W2, null);

        await h.Build().RunOnceAsync(CancellationToken.None);

        Assert.True(h.Store.TryGet(W1, out _));
        Assert.True(h.Store.TryGet(W2, out _));
    }

    [Fact]
    public async Task KeepsBeatingAndRetryingWhileL2IsUnreachable()
    {
        // The watchdog's whole purpose: an unreachable store is a dependency outage, not a crash, so
        // the loop must keep ticking and the pod must stay alive. A loop that stopped beating here
        // would be restarted by Kubernetes for a fault a restart cannot fix.
        var h = new Harness().WithStoreFault();
        var start = h.Clock.GetUtcNow();

        var run = h.Build().RunUntilHydratedAsync(h.Cts.Token);
        h.PumpTime(TimeSpan.FromSeconds(30));

        Assert.NotNull(h.Heartbeat.Last);

        // Later than the first beat, which is the only evidence available that the loop came back
        // round rather than beating once and wedging. Beat stamps the fake clock, so a stamp past the
        // instant the pass started means an attempt ran after the pump moved time — a retry.
        Assert.True(
            h.Heartbeat.Last > start, "the loop stopped beating while L2 was unreachable");
        Assert.False(h.Admission.IsOpen);
        h.Cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => run);
    }

    [Fact]
    public async Task OpensAdmissionAndRetiresItsHeartbeatOnlyOnceHydrationSucceeds()
    {
        // Retiring matters: a startup loop that stops beating is indistinguishable from one that
        // wedged, and would fail its liveness check one window later and restart a healthy pod.
        var h = new Harness().WithWorkflow(W1, "0 * * * *");

        await h.Build().RunOnceAsync(CancellationToken.None);

        Assert.True(h.Admission.IsOpen);
        Assert.True(h.Heartbeat.IsRetired);
        Assert.True(h.StartupGate.IsReady);
    }
}
