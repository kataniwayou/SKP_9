using System.Text;
using System.Text.Json;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using NSubstitute.ExceptionExtensions;
using Orchestrator.L1;
using Orchestrator.Messaging;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Orchestrator;

/// <summary>
/// The two consumers that keep a running replica in step with L2: the start and stop announcements
/// the API publishes after each projection write.
/// <para>
/// <b>The tests never hand the message a definition to apply.</b> Every "start applies" assertion
/// arranges the definition in the substituted store and hands the handler an announcement carrying
/// only the id — an announcement is an announcement, not a payload, and a test that stubbed a
/// definition into the message itself would prove nothing about the recipient re-reading L2.
/// </para>
/// </summary>
public sealed class ApplyHandlerTests
{
    private static readonly Guid W = Guid.Parse("55555555-5555-5555-5555-555555555555");
    private static readonly Guid S = Guid.Parse("66666666-6666-6666-6666-666666666666");
    private static readonly Guid P = Guid.Parse("77777777-7777-7777-7777-777777777777");

    private sealed class Harness
    {
        private readonly HashSet<Guid> _live = [];
        private readonly L2WorkflowReader _reader;

        public IDatabase Db { get; } = Substitute.For<IDatabase>();

        public WorkflowL1Store Store { get; } = new();

        public RecordingWorkflowScheduler Scheduler { get; } = new();

        public Harness()
        {
            var redis = Substitute.For<IConnectionMultiplexer>();
            redis.GetDatabase().Returns(Db);

            _reader = new L2WorkflowReader(redis, NullLogger<L2WorkflowReader>.Instance);
        }

        /// <summary>
        /// Puts <paramref name="workflowId"/> in L2: <see cref="L2WorkflowReader.ExistsAsync"/> and
        /// <see cref="L2WorkflowReader.ReadAsync"/> both answer as they would against the real root
        /// and step keys <c>L2ProjectionWriter</c> writes.
        /// </summary>
        public Harness WithWorkflow(Guid workflowId, string? cron)
        {
            _live.Add(workflowId);

            Db.KeyExistsAsync(L2ProjectionKeys.Root(workflowId), Arg.Any<CommandFlags>())
                .Returns(_ => _live.Contains(workflowId));

            Db.StringGetAsync(L2ProjectionKeys.Root(workflowId), Arg.Any<CommandFlags>())
                .Returns(_ => _live.Contains(workflowId)
                    ? (RedisValue)JsonSerializer.Serialize(
                        new WorkflowRootProjection(
                            EntryStepIds: [S],
                            StepIds: [S],
                            Cron: cron,
                            Liveness: new LivenessProjection(DateTime.UtcNow, 3600, "Pending")),
                        MessagingJson.Options)
                    : RedisValue.Null);

            Db.StringGetAsync(L2ProjectionKeys.Step(workflowId, S), Arg.Any<CommandFlags>())
                .Returns((RedisValue)JsonSerializer.Serialize(
                    new StepProjection(
                        EntryCondition: 0, ProcessorId: P, Payload: "{}", NextStepIds: []),
                    MessagingJson.Options));

            return this;
        }

        /// <summary>
        /// The clean the API runs before it publishes a stop: L2 no longer holds the workflow, as
        /// far as <see cref="L2WorkflowReader.ExistsAsync"/> and <see cref="L2WorkflowReader.ReadAsync"/>
        /// are concerned.
        /// </summary>
        public void RemoveWorkflowFromL2(Guid workflowId) => _live.Remove(workflowId);

        /// <summary>An L2 that cannot be reached at all.</summary>
        public Harness WithStoreFault()
        {
            Db.StringGetAsync(L2ProjectionKeys.Root(W), Arg.Any<CommandFlags>())
                .ThrowsAsync(new RedisConnectionException(ConnectionFailureType.SocketFailure, "down"));
            Db.KeyExistsAsync(L2ProjectionKeys.Root(W), Arg.Any<CommandFlags>())
                .ThrowsAsync(new RedisConnectionException(ConnectionFailureType.SocketFailure, "down"));

            return this;
        }

        public ApplyStartHandler BuildStart() => new(
            new WorkflowActivator(_reader, Store, Scheduler, NullLogger<WorkflowActivator>.Instance),
            NullLogger<ApplyStartHandler>.Instance);

        public ApplyStopHandler BuildStop() => new(
            _reader, Store, Scheduler, NullLogger<ApplyStopHandler>.Instance);
    }

    private static byte[] Body<T>(T message) =>
        JsonSerializer.SerializeToUtf8Bytes(message, MessagingJson.Options);

    [Fact]
    public async Task AStartAppliesTheWorkflowFromL2NotFromTheMessage()
    {
        var h = new Harness().WithWorkflow(W, "0 * * * *");

        await h.BuildStart().HandleAsync(Body(new OrchestrationStarted(W)), CancellationToken.None);

        Assert.True(h.Store.TryGet(W, out _));
    }

    [Fact]
    public async Task AStartIsIdempotentAcrossAReplay()
    {
        var h = new Harness().WithWorkflow(W, "0 * * * *");
        await h.BuildStart().HandleAsync(Body(new OrchestrationStarted(W)), CancellationToken.None);

        await h.BuildStart().HandleAsync(Body(new OrchestrationStarted(W)), CancellationToken.None);

        Assert.True(h.Store.TryGet(W, out _));
        Assert.Equal(1, h.Scheduler.LiveJobCount);
    }

    [Fact]
    public async Task AStartForAWorkflowL2NoLongerHoldsIsANoOpNotAPark()
    {
        // A stop cleaned L2 after this announcement was published. Applying it would resurrect a
        // workflow an operator stopped; parking it would DLX a legitimate race rather than a defect.
        var h = new Harness();

        await h.BuildStart().HandleAsync(Body(new OrchestrationStarted(W)), CancellationToken.None);

        Assert.False(h.Store.TryGet(W, out _));
    }

    [Fact]
    public async Task AnUnreadableBodyThrowsSoTheDeliveryParks()
    {
        var h = new Harness();

        await Assert.ThrowsAsync<JsonException>(
            () => h.BuildStart().HandleAsync(Encoding.UTF8.GetBytes("not json"), CancellationToken.None));
    }

    [Fact]
    public async Task AStopDoesNothingWhileL2StillHoldsTheWorkflow()
    {
        // The API can process a stop then a start: clean, announce stop, write, announce start — both
        // queued here in that order. Acting on the stop first would halt a workflow L2 says is live.
        var h = new Harness().WithWorkflow(W, "0 * * * *");
        await h.BuildStart().HandleAsync(Body(new OrchestrationStarted(W)), CancellationToken.None);

        await h.BuildStop().HandleAsync(Body(new OrchestrationStopped(W)), CancellationToken.None);

        Assert.True(h.Store.TryGet(W, out _));
        Assert.Equal(1, h.Scheduler.LiveJobCount);
    }

    [Fact]
    public async Task AStopUnschedulesThenRemovesOnceL2ConfirmsTheRemoval()
    {
        var h = new Harness().WithWorkflow(W, "0 * * * *");
        await h.BuildStart().HandleAsync(Body(new OrchestrationStarted(W)), CancellationToken.None);
        h.RemoveWorkflowFromL2(W);

        await h.BuildStop().HandleAsync(Body(new OrchestrationStopped(W)), CancellationToken.None);

        Assert.False(h.Store.TryGet(W, out _));
        Assert.Equal(0, h.Scheduler.LiveJobCount);
    }

    [Fact]
    public async Task AStopForAWorkflowThisReplicaNeverSawIsANoOp()
    {
        // What a replica sees after it missed the start while it was down, and after a duplicate stop.
        var h = new Harness();

        await h.BuildStop().HandleAsync(Body(new OrchestrationStopped(W)), CancellationToken.None);

        Assert.Equal(0, h.Scheduler.LiveJobCount);
    }

    [Fact]
    public async Task AnL2FaultPropagatesSoTheDeliveryRequeuesAndTripsTheGate()
    {
        // Requeue-and-trip is right: the replica stops consuming until the store returns, rather than
        // spinning through the backlog failing every message in turn.
        var h = new Harness().WithStoreFault();

        await Assert.ThrowsAsync<RedisConnectionException>(
            () => h.BuildStart().HandleAsync(Body(new OrchestrationStarted(W)), CancellationToken.None));
    }
}
