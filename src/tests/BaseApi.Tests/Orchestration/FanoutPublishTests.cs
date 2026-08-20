using System.Text.Json;
using BaseApi.Service.Features.Orchestration.Messaging;
using BaseApi.Service.Features.Orchestration.Projection;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Messaging.Transport;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using NSubstitute;
using NSubstitute.ExceptionExtensions;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Orchestration;

/// <summary>
/// The API is the only writer of L2, and it announces to the orchestrator fan-out exchange once a
/// write has committed, so every replica knows to re-read L2. These cover both handlers that mutate
/// L2: the announcement must carry only the workflow id, must go out only after the write (or clean)
/// has committed, and a failed publish must escape so the control message is requeued.
/// </summary>
public sealed class FanoutPublishTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");

    private sealed class Harness
    {
        public IDatabase Db { get; } = Substitute.For<IDatabase>();

        // L2ProjectionWriter and L2Cleanup are internal sealed classes with no interface, so neither
        // can be substituted directly — NSubstitute cannot proxy a sealed type. The write they commit
        // is observed one layer down instead, at the batch they build and dispatch to Redis.
        public IBatch Batch { get; } = Substitute.For<IBatch>();
        public IConnectionMultiplexer Redis { get; }
        public IQueueFanoutPublisher Publisher { get; } = Substitute.For<IQueueFanoutPublisher>();
        private readonly FakeTimeProvider _clock = new(DateTimeOffset.UtcNow);

        public Harness()
        {
            Redis = Substitute.For<IConnectionMultiplexer>();
            Redis.GetDatabase().Returns(Db);
            Db.CreateBatch().Returns(Batch);

            // No explicit "no prior projection" stub here: NSubstitute already returns a completed
            // Task whose RedisValue is default, and default(RedisValue).IsNullOrEmpty is true — the
            // same thing RedisValue.Null would assert, so a stub saying so was dead weight rather than
            // a precondition. The start-path tests below rely on exactly that default: an absent root
            // makes L2Cleanup.RemoveAsync return before it ever touches a batch, so only the writer's
            // own batch exercises Batch for those. The stop-path test needs the opposite — a root that
            // IS present, so its own clean reaches a batch too — and stubs that itself.
        }

        public StartOrchestrationHandler BuildStart() => new(
            new L2Cleanup(Redis), new L2ProjectionWriter(Redis, _clock), Publisher,
            NullLogger<StartOrchestrationHandler>.Instance);

        public StopOrchestrationHandler BuildStop() => new(
            new L2Cleanup(Redis), Publisher, NullLogger<StopOrchestrationHandler>.Instance);
    }

    private static StartOrchestration Start(Guid workflowId) =>
        new(new WorkflowL1(workflowId, new List<Guid>(), null, new List<StepL1>()));

    private static StopOrchestration Stop(Guid workflowId) => new(workflowId);

    private static byte[] Body(StartOrchestration m)
        => JsonSerializer.SerializeToUtf8Bytes(m, MessagingJson.Options);

    private static byte[] Body(StopOrchestration m)
        => JsonSerializer.SerializeToUtf8Bytes(m, MessagingJson.Options);

    /// <summary>A stored root for <see cref="W"/>, serialized the way L2Cleanup expects to read it.</summary>
    private static string ExistingRoot() => JsonSerializer.Serialize(
        new WorkflowRootProjection(
            EntryStepIds: new List<Guid>(),
            StepIds: new List<Guid>(),
            Cron: null,
            Liveness: new LivenessProjection(DateTime.UtcNow, 0, "Pending")),
        MessagingJson.Options);

    [Fact]
    public async Task AnnouncesOnlyAfterTheProjectionHasBeenWritten()
    {
        // The announcement means "L2 is ready, go read it". Published before the write, a replica
        // reading L2 on it would find the previous definition or none, and would have no way to tell
        // that from a workflow that was never started.
        var h = new Harness();
        var order = new List<string>();
        h.Batch.When(b => b.Execute()).Do(_ => order.Add("write"));
        h.Publisher.When(p => p.PublishAsync(
                    Arg.Any<string>(), Arg.Any<string>(), Arg.Any<OrchestrationStarted>(), Arg.Any<CancellationToken>()))
                .Do(_ => order.Add("announce"));

        await h.BuildStart().HandleAsync(Body(Start(W)), CancellationToken.None);

        Assert.Equal(["write", "announce"], order);
    }

    [Fact]
    public async Task AnnouncesToTheFanoutExchangeCarryingOnlyTheWorkflowId()
    {
        var h = new Harness();

        await h.BuildStart().HandleAsync(Body(Start(W)), CancellationToken.None);

        await h.Publisher.Received(1).PublishAsync(
            OrchestratorFanout.Exchange, MessageTypes.OrchestrationStarted,
            Arg.Is<OrchestrationStarted>(a => a.WorkflowId == W), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task AFailedAnnouncementEscapesSoTheControlMessageIsRequeued()
    {
        // TransientSendException classifies as Requeue, so the redelivery re-runs the idempotent
        // clean-and-write and announces again. Anything else would PARK the control message and the
        // replicas would never learn about a workflow the API has already projected.
        var h = new Harness();
        h.Publisher.PublishAsync(Arg.Any<string>(), Arg.Any<string>(),
                                 Arg.Any<OrchestrationStarted>(), Arg.Any<CancellationToken>())
                   .ThrowsAsync(new TransientSendException("broker down", new IOException("connection reset")));

        await Assert.ThrowsAsync<TransientSendException>(
            () => h.BuildStart().HandleAsync(Body(Start(W)), CancellationToken.None));
    }

    [Fact]
    public async Task TheStopPathAnnouncesAfterItsCleanToo()
    {
        // A stop that cleans L2 without telling the replicas leaves three schedulers firing a workflow
        // that no longer exists. A stop only reaches a batch when there is something stored to remove
        // — an absent root returns early inside L2Cleanup and never calls Execute() — so this stubs a
        // real stored root rather than the harness's "nothing stored" default, which would let the
        // announce-after-clean ordering pass unchecked.
        var h = new Harness();
        var order = new List<string>();
        h.Db.StringGetAsync(L2ProjectionKeys.Root(W), Arg.Any<CommandFlags>()).Returns((RedisValue)ExistingRoot());
        h.Batch.When(b => b.Execute()).Do(_ => order.Add("write"));
        h.Publisher.When(p => p.PublishAsync(
                    Arg.Any<string>(), Arg.Any<string>(), Arg.Any<OrchestrationStopped>(), Arg.Any<CancellationToken>()))
                .Do(_ => order.Add("announce"));

        await h.BuildStop().HandleAsync(Body(Stop(W)), CancellationToken.None);

        Assert.Equal(["write", "announce"], order);
        await h.Publisher.Received(1).PublishAsync(
            OrchestratorFanout.Exchange, MessageTypes.OrchestrationStopped,
            Arg.Is<OrchestrationStopped>(a => a.WorkflowId == W), Arg.Any<CancellationToken>());
    }
}
