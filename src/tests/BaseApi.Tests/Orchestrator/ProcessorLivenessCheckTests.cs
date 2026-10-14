using System.Text.Json;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Microsoft.Extensions.Time.Testing;
using NSubstitute;
using NSubstitute.ExceptionExtensions;
using Orchestrator.L1;
using Orchestrator.Scheduling;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Orchestrator;

/// <summary>
/// The fire's liveness gate below the fire job: the shared replica rule, the keys L1 derives for it,
/// and the Redis read that applies the one to the other.
/// </summary>
public sealed class ProcessorLivenessCheckTests
{
    private static readonly DateTime Now = new(2026, 1, 1, 12, 0, 0, DateTimeKind.Utc);

    private static readonly Guid P1 = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid P2 = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private readonly IDatabase _db = Substitute.For<IDatabase>();
    private readonly FakeTimeProvider _clock = new(new DateTimeOffset(Now, TimeSpan.Zero));

    private ProcessorLivenessCheck Check()
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase().Returns(_db);
        return new ProcessorLivenessCheck(redis, _clock);
    }

    private void Replicas(Guid processorId, params (string InstanceId, RedisValue Value)[] replicas)
    {
        _db.SetMembersAsync(L2ProjectionKeys.ProcessorInstances(processorId))
            .Returns(replicas.Select(r => (RedisValue)r.InstanceId).ToArray());
        foreach (var (instanceId, value) in replicas)
        {
            _db.StringGetAsync(L2ProjectionKeys.PerInstance(processorId, instanceId)).Returns(value);
        }
    }

    private static string Entry(string status, int ageSeconds, int interval = 10) =>
        JsonSerializer.Serialize(new ProcessorLivenessEntry(
            Now.AddSeconds(-ageSeconds), interval, status,
            new LivenessSummary(SchemaOutcome.Success, SchemaOutcome.Success, SchemaOutcome.Success)));

    private static Dictionary<Guid, string> Keys(params Guid[] processors) =>
        processors.ToDictionary(id => id, L2ProjectionKeys.ProcessorInstances);

    // ---- The shared rule ---------------------------------------------------------------------------

    [Fact]
    public void TheClassifierSortsEveryShapeOfValue()
    {
        Assert.Equal(ReplicaLiveness.Absent,    ReplicaLivenessClassifier.Classify(null, Now));
        Assert.Equal(ReplicaLiveness.Absent,    ReplicaLivenessClassifier.Classify("", Now));
        Assert.Equal(ReplicaLiveness.Malformed, ReplicaLivenessClassifier.Classify("{not json", Now));
        Assert.Equal(ReplicaLiveness.Malformed, ReplicaLivenessClassifier.Classify("{}", Now));
        Assert.Equal(ReplicaLiveness.Unhealthy, ReplicaLivenessClassifier.Classify(Entry(LivenessStatus.Unhealthy, 1), Now));
        Assert.Equal(ReplicaLiveness.Healthy,   ReplicaLivenessClassifier.Classify(Entry(LivenessStatus.Healthy, 1), Now));
    }

    [Fact]
    public void AReplicaIsStaleExactlyAtTwiceItsOwnInterval()
    {
        Assert.Equal(ReplicaLiveness.Healthy, ReplicaLivenessClassifier.Classify(Entry(LivenessStatus.Healthy, 19), Now));
        Assert.Equal(ReplicaLiveness.Stale,   ReplicaLivenessClassifier.Classify(Entry(LivenessStatus.Healthy, 20), Now));
    }

    // ---- The keys L1 holds -------------------------------------------------------------------------

    [Fact]
    public void L1HoldsOneIndexKeyPerDistinctProcessorOfTheWorkflow()
    {
        // Three steps, two processors: the key set is per processor, and covers the successor's too.
        var s1 = Guid.NewGuid();
        var s2 = Guid.NewGuid();
        var s3 = Guid.NewGuid();
        var definition = new WorkflowL1(
            Guid.NewGuid(), [s1], "0 * * * *",
            [
                new StepL1(s1, 1, P1, "", [s2, s3]),
                new StepL1(s2, 1, P2, "", []),
                new StepL1(s3, 1, P1, "", []),
            ],
            []);

        var entry = new L1Entry(definition, Guid.NewGuid());

        Assert.Equal(Keys(P1, P2), entry.ProcessorInstanceIndexKeys);
    }

    [Fact]
    public void AStopMarkKeepsTheKeys()
    {
        var definition = new WorkflowL1(Guid.NewGuid(), [], null, [new StepL1(Guid.NewGuid(), 1, P1, "", [])], []);

        var marked = new L1Entry(definition, Guid.NewGuid()) with { DeletedAt = DateTimeOffset.UnixEpoch };

        Assert.Equal(Keys(P1), marked.ProcessorInstanceIndexKeys);
    }

    // ---- The read ----------------------------------------------------------------------------------

    [Fact]
    public async Task OneHealthyReplicaAmongBadOnesMakesTheProcessorLive()
    {
        Replicas(P1,
            ("gone", RedisValue.Null),
            ("sick", Entry(LivenessStatus.Unhealthy, 1)),
            ("good", Entry(LivenessStatus.Healthy, 1)));

        var verdict = Assert.Single(await Check().ReadAsync(Keys(P1)));

        Assert.Equal(new ProcessorLivenessVerdict(P1, Live: true), verdict);
    }

    [Fact]
    public async Task AProcessorWithNoReplicasOrOnlyStaleOnesIsNotLive()
    {
        // P1 scaled to zero long enough for the index to expire; P2's last replica stopped beating.
        Replicas(P1);
        Replicas(P2, ("old", Entry(LivenessStatus.Healthy, 999)));

        var verdicts = await Check().ReadAsync(Keys(P1, P2));

        Assert.All(verdicts, v => Assert.False(v.Live));
        Assert.All(verdicts, v => Assert.Null(v.Fault));
        Assert.Equal([P1, P2], verdicts.Select(v => v.ProcessorId).Order());
    }

    [Fact]
    public async Task AFaultOnOneIndexIsCapturedOnThatProcessorAndTheOthersAreStillRead()
    {
        var wrongType = new RedisServerException("WRONGTYPE Operation against a key holding the wrong kind of value");
        _db.SetMembersAsync(L2ProjectionKeys.ProcessorInstances(P1)).ThrowsAsync(wrongType);
        Replicas(P2, ("good", Entry(LivenessStatus.Healthy, 1)));

        var verdicts = (await Check().ReadAsync(Keys(P1, P2))).ToDictionary(v => v.ProcessorId);

        Assert.Equal(new ProcessorLivenessVerdict(P1, Live: false, wrongType), verdicts[P1]);
        Assert.Equal(new ProcessorLivenessVerdict(P2, Live: true), verdicts[P2]);
    }

    [Fact]
    public async Task AFaultOnAReplicaReadMakesTheProcessorNotLiveEvenBesideAHealthyOne()
    {
        // A faulted read is never a yes: the fire skips, and the fault is what it reports.
        var timeout = new RedisTimeoutException("slow", CommandStatus.Sent);
        Replicas(P1, ("good", Entry(LivenessStatus.Healthy, 1)), ("slow", RedisValue.Null));
        _db.StringGetAsync(L2ProjectionKeys.PerInstance(P1, "slow")).ThrowsAsync(timeout);

        var verdict = Assert.Single(await Check().ReadAsync(Keys(P1)));

        Assert.Equal(new ProcessorLivenessVerdict(P1, Live: false, timeout), verdict);
    }

    [Fact]
    public async Task ASynchronousThrowFromTheClientLandsOnTheVerdictRatherThanEscaping()
    {
        var down = new RedisConnectionException(ConnectionFailureType.UnableToConnect, "down");
        _db.SetMembersAsync(L2ProjectionKeys.ProcessorInstances(P1)).Throws(down);

        var verdict = Assert.Single(await Check().ReadAsync(Keys(P1)));

        Assert.Same(down, verdict.Fault);
        Assert.False(verdict.Live);
    }
}
