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
using Orchestrator.Messaging;
using RabbitMQ.Client.Exceptions;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Orchestrator;

/// <summary>
/// Loop 2, and the things that go wrong silently if it is written carelessly: that every workflow L2
/// lists actually reaches L1, that an unreachable L2 leaves the pod alive and still beating rather
/// than restarting into the same outage, and that the admission latch and the heartbeat's retirement
/// happen together with success and never before it.
/// <para>
/// <b>That last claim is made twice, and the two halves are not the same claim.</b> A pass that fails
/// before it activates anything is the easy case — nothing has happened, so nothing has been decided.
/// A pass that mirrors one workflow and then fails on the next is the case where a latch opened
/// optimistically would admit the consumer against a half-built L1, and it is tested separately.
/// </para>
/// <para>
/// <b>And that this replica's queue is declared before the pass reads L2 at all.</b> That ordering is
/// not observable from anywhere else: get it wrong and every test here still passes, every probe is
/// green, and the only symptom is an announcement published in the window between the read and the
/// declare vanishing — reachable on the first start of a replica ordinal, which is a scale-up.
/// </para>
/// <para>
/// <b>The startup gate is the one thing here that is deliberately not tied to success.</b> It reports
/// that this loop is running, not that it has finished, so it opens on the first beat of the first
/// attempt and stays open through every retry. Tied to success instead, a dependency outage would
/// exhaust the pod's startup budget and have the kubelet kill all three replicas for a fault a
/// restart cannot repair — so "ready even when the pass fails" is asserted directly.
/// </para>
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

        public ITopologyDeclarer Topology { get; } = Substitute.For<ITopologyDeclarer>();

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
            Index(workflowId);

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

        /// <summary>
        /// Adds one id to the parent index. The stub is replaced rather than appended to, so the last
        /// call carries every id added so far and index order is the order they were added in — which
        /// is what makes "mirrored W1, then failed on W2" a thing a test can arrange.
        /// </summary>
        private void Index(Guid workflowId)
        {
            _index.Add(workflowId.ToString("D"));
            Db.SetMembersAsync(L2ProjectionKeys.ParentIndex(), Arg.Any<CommandFlags>())
                .Returns(_index.ToArray());
        }

        /// <summary>A broker this replica cannot reach, so its topology cannot be declared.</summary>
        public Harness WithBrokerFault()
        {
            Topology.EnsureDeclaredAsync(Arg.Any<CancellationToken>())
                .Throws(new BrokerUnreachableException(new IOException("no broker")));

            return this;
        }

        /// <summary>
        /// A broker that refuses the first <paramref name="failures"/> declarations and accepts after
        /// that — the outage this loop is supposed to back off through rather than die on.
        /// </summary>
        public Harness WithBrokerFaultsThenRecovery(int failures)
        {
            var attempts = 0;

            Topology.EnsureDeclaredAsync(Arg.Any<CancellationToken>())
                .Returns(_ => Interlocked.Increment(ref attempts) <= failures
                    ? throw new BrokerUnreachableException(new IOException("no broker"))
                    : ValueTask.CompletedTask);

            return this;
        }

        /// <summary>An L2 that cannot be reached at all — the index read itself faults.</summary>
        public Harness WithStoreFault()
        {
            Db.SetMembersAsync(L2ProjectionKeys.ParentIndex(), Arg.Any<CommandFlags>())
                .ThrowsAsync(new RedisConnectionException(ConnectionFailureType.SocketFailure, "down"));

            return this;
        }

        /// <summary>
        /// A workflow the index lists but whose root read faults — the store going away partway
        /// through a pass, rather than before it started.
        /// </summary>
        public Harness WithWorkflowFault(Guid workflowId)
        {
            Index(workflowId);
            Db.StringGetAsync(L2ProjectionKeys.Root(workflowId), Arg.Any<CommandFlags>())
                .ThrowsAsync(new RedisConnectionException(ConnectionFailureType.SocketFailure, "down"));

            return this;
        }

        /// <summary>
        /// An L2 that faults the first <paramref name="failures"/> index reads and answers normally
        /// after that — a store that was down and came back.
        /// <para>
        /// Must be the last <c>With…</c> call in a chain: it replaces the index stub, and reads the
        /// ids lazily so whatever <see cref="WithWorkflow"/> added still arrives on the attempt that
        /// succeeds.
        /// </para>
        /// </summary>
        public Harness WithStoreFaultsThenRecovery(int failures)
        {
            var attempts = 0;

            Db.SetMembersAsync(L2ProjectionKeys.ParentIndex(), Arg.Any<CommandFlags>())
                .Returns(_ => Interlocked.Increment(ref attempts) <= failures
                    ? throw new RedisConnectionException(ConnectionFailureType.SocketFailure, "down")
                    : _index.ToArray());

            return this;
        }

        public HydrationService Build() => new(
            Topology,
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
    public async Task DeclaresThisReplicasTopologyBeforeItReadsL2()
    {
        // The whole of the finding. Both calls happen either way, so nothing but their order says
        // whether an announcement published mid-pass reaches this replica's queue or is discarded by
        // an exchange that has nothing of ours bound to it yet.
        var h = new Harness().WithWorkflow(W1, "0 * * * *");

        await h.Build().RunOnceAsync(CancellationToken.None);

        Received.InOrder(() =>
        {
            h.Topology.EnsureDeclaredAsync(Arg.Any<CancellationToken>());
            h.Db.SetMembersAsync(L2ProjectionKeys.ParentIndex(), Arg.Any<CommandFlags>());
        });
    }

    [Fact]
    public async Task ReadsNothingFromL2WhileTheBrokerIsUnreachable()
    {
        // The ordering above, stated as the thing it protects: a pass that cannot declare must not
        // proceed to read. A read that went ahead anyway would mirror an L2 whose announcements this
        // replica is not yet listening for, and then admit the consumer against it.
        var h = new Harness().WithWorkflow(W1, "0 * * * *").WithBrokerFault();

        await Assert.ThrowsAsync<BrokerUnreachableException>(
            () => h.Build().RunOnceAsync(CancellationToken.None));

        await h.Db.DidNotReceive().SetMembersAsync(
            L2ProjectionKeys.ParentIndex(), Arg.Any<CommandFlags>());
        Assert.False(h.Admission.IsOpen);

        // Ready all the same: the gate reports that the loop is turning, and the beat that opens it
        // is ahead of the declare precisely so a broker this replica cannot reach leaves it retrying
        // and startable rather than burning the pod's startup budget.
        Assert.True(h.StartupGate.IsReady);
    }

    [Fact]
    public async Task BacksOffAndRetriesThroughABrokerOutageJustAsItDoesForL2()
    {
        // A broker outage now fails the pass, so it has to land in the same contract as an L2 outage:
        // back off, keep beating, hydrate when it returns. A declaration ordered ahead of this loop
        // instead would have blocked host startup on a dependency this design allows to be down.
        var h = new Harness()
            .WithWorkflow(W1, "0 * * * *")
            .WithBrokerFaultsThenRecovery(failures: 2);

        var run = h.Build().RunUntilHydratedAsync(h.Cts.Token);
        h.PumpTime(TimeSpan.FromSeconds(30));

        await run.WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken);

        Assert.True(h.Admission.IsOpen);
        Assert.True(h.Store.TryGet(W1, out _));
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

        // And startable throughout. This is the assertion that stands between a Redis outage and the
        // kubelet killing every replica at once: /health/startup reads this latch, and a latch that
        // waited for a complete pass would stay red for the whole outage.
        Assert.True(h.StartupGate.IsReady);
        h.Cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => run);
    }

    [Fact]
    public async Task OpensAdmissionAndRetiresItsHeartbeatOnlyOnceHydrationSucceeds()
    {
        // Retiring matters: a startup loop that stops beating is indistinguishable from one that
        // wedged, and would fail its liveness check one window later and restart a healthy pod.
        //
        // The startup gate is deliberately absent from this test. It is not part of the "only once"
        // claim any more — it opens on the first beat, before any of this — and asserting it here
        // would read as evidence for a rule it no longer follows. MarksTheStartupGateReadyEvenWhen…
        // owns it instead.
        var h = new Harness().WithWorkflow(W1, "0 * * * *");

        await h.Build().RunOnceAsync(CancellationToken.None);

        Assert.True(h.Admission.IsOpen);
        Assert.True(h.Heartbeat.IsRetired);
    }

    [Fact]
    public async Task MarksTheStartupGateReadyEvenWhenThePassFails()
    {
        // The whole point of the gate moving off success. /health/startup reads this latch, and the
        // orchestrator's startup budget is finite: a latch that waited for a complete pass would stay
        // red for the length of any L2 or broker outage and have the kubelet kill all three replicas
        // together — podManagementPolicy: Parallel starts them together, so they fail together too.
        // The gate opens on the first beat and the failure changes nothing about it.
        var h = new Harness().WithStoreFault();

        await Assert.ThrowsAsync<RedisConnectionException>(
            () => h.Build().RunOnceAsync(CancellationToken.None));

        Assert.True(h.StartupGate.IsReady);

        // And the gate opening is emphatically not admission opening. Readiness reports the loop is
        // running; admission is the permission to consume, and it still waits for a complete pass.
        Assert.False(h.Admission.IsOpen);
    }

    [Fact]
    public async Task LeavesAdmissionShutWhenThePassFailsPartWayThrough()
    {
        // The half of "only once hydration succeeds" that a fault on the index read cannot reach. Here
        // the pass gets a workflow into L1 and then loses the store, which is exactly the state an
        // optimistically-opened latch would admit the consumer against: a half-built L1, in which a
        // stop announcement for a workflow this replica has not mirrored yet would find nothing to
        // stop and a fire would run against steps that were never read.
        var h = new Harness()
            .WithWorkflow(W1, "0 * * * *")
            .WithWorkflowFault(W2);

        await Assert.ThrowsAsync<RedisConnectionException>(
            () => h.Build().RunOnceAsync(CancellationToken.None));

        Assert.True(h.Store.TryGet(W1, out _));    // the half that got through is still mirrored
        Assert.False(h.Store.TryGet(W2, out _));
        Assert.False(h.Admission.IsOpen);
        Assert.False(h.Heartbeat.IsRetired);

        // Ready, though — and the pairing is the point of the rename. "Everything shut" stopped being
        // true when readiness moved to the first beat, and the two latches now answer different
        // questions: this pod is starting correctly, and it may not consume yet.
        Assert.True(h.StartupGate.IsReady);
    }

    [Fact]
    public async Task StopsRetryingOnTheFirstAttemptThatSucceeds()
    {
        // The way out of the retry loop. Every other success assertion drives RunOnceAsync directly,
        // so none of them can tell a loop that notices a good pass from one that retries forever —
        // and a loop that never left would hold the admission shut with L2 answering perfectly well.
        var h = new Harness()
            .WithWorkflow(W1, "0 * * * *")
            .WithStoreFaultsThenRecovery(failures: 2);

        var run = h.Build().RunUntilHydratedAsync(h.Cts.Token);
        h.PumpTime(TimeSpan.FromSeconds(30));

        // Three seconds of backoff separate the third attempt from the first, against thirty pumped,
        // so the wait is only ever the pool catching up. The real-time bound is here so that a loop
        // which never returns fails this test instead of stalling the whole run.
        await run.WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken);

        Assert.True(h.Admission.IsOpen);
        Assert.True(h.Heartbeat.IsRetired);
        Assert.True(h.Store.TryGet(W1, out _));
    }
}
