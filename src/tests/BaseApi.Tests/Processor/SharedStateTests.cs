using BaseApi.Tests.Support;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Identity;
using BaseProcessor.Core.Liveness;
using BaseProcessor.Core.Shared;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using NSubstitute;
using NSubstitute.ExceptionExtensions;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Processor;

/// <summary>
/// Data shared across one processor's replicas: written once, readable by all, re-armed by every
/// replica's heartbeat, and gone once the last one stops beating.
/// </summary>
public sealed class SharedStateTests
{
    private static readonly Guid P = Guid.Parse("55555555-5555-5555-eeee-555555555555");

    private static ProcessorIdentity Identity() =>
        new(P, null, null, null, "shared-proc", "1.0.0", null, null);

    private static IProcessorContext Context(ProcessorIdentity? identity)
    {
        var context = Substitute.For<IProcessorContext>();
        context.Identity.Returns(identity);
        return context;
    }

    private static (RedisProcessorSharedState Store, RecordingLogger<RedisProcessorSharedState> Log) Store(
        IConnectionMultiplexer redis, ProcessorIdentity? identity = null)
    {
        var log = new RecordingLogger<RedisProcessorSharedState>();
        var store = new RedisProcessorSharedState(
            redis, Context(identity ?? Identity()), Options.Create(new ProcessorLivenessOptions()), log);
        return (store, log);
    }

    private static ProcessorLivenessEntry Entry(int interval) => ProcessorLivenessEntry.Create(
        SchemaOutcome.Success, SchemaOutcome.Success, SchemaOutcome.Success,
        new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc), interval);

    [Fact]
    public void TheKeysSitUnderTheProcessorsSharedSegment()
    {
        Assert.Equal("skp:proc:55555555-5555-5555-eeee-555555555555:shared", L2ProjectionKeys.ProcessorShared(P));
        Assert.Equal(
            "skp:proc:55555555-5555-5555-eeee-555555555555:shared:bit:abc",
            L2ProjectionKeys.ProcessorSharedEntry(P, "bit:abc"));
    }

    [Fact]
    public void ASharedEntryNeverParsesAsAnInstancesIndex()
    {
        // The orphan sweeper scans skp:proc:*:instances; an entry named to end in it must not be
        // mistaken for a processor's instance set.
        Assert.False(L2ProjectionKeys.TryParseProcessorInstances(
            L2ProjectionKeys.ProcessorSharedEntry(P, "x:instances"), out _));
    }

    [Fact]
    public async Task AnEntryIsWrittenWithTheLivenessTtlAndIndexed()
    {
        var l2 = new InMemoryL2();
        var (store, log) = Store(l2.Multiplexer);

        Assert.True(await store.SetAsync("bit:abc", "{\"v\":1}"));

        var key = L2ProjectionKeys.ProcessorSharedEntry(P, "bit:abc");
        Assert.Equal("{\"v\":1}", l2.Value(key));
        Assert.Equal(TimeSpan.FromSeconds(40), l2.Ttl(key));
        Assert.Equal(["bit:abc"], l2.Members(L2ProjectionKeys.ProcessorShared(P)));
        Assert.Equal(TimeSpan.FromSeconds(40), l2.Ttl(L2ProjectionKeys.ProcessorShared(P)));
        Assert.Empty(log.Records);
    }

    [Fact]
    public async Task AnotherReplicaReadsWhatOneWrote()
    {
        var l2 = new InMemoryL2();
        await Store(l2.Multiplexer).Store.SetAsync("bit:abc", "verdict");

        Assert.Equal("verdict", await Store(l2.Multiplexer).Store.GetAsync("bit:abc"));
    }

    [Fact]
    public async Task AnAbsentEntryReadsAsNull()
        => Assert.Null(await Store(new InMemoryL2().Multiplexer).Store.GetAsync("bit:nothing"));

    [Fact]
    public async Task AReadFaultIsAMissAndIsLogged()
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase().Throws(new RedisConnectionException(ConnectionFailureType.SocketFailure, "down"));
        var (store, log) = Store(redis);

        Assert.Null(await store.GetAsync("bit:abc"));
        Assert.Equal(LogLevel.Warning, Assert.Single(log.Records).Level);
    }

    [Fact]
    public async Task AWriteFaultReturnsFalseAndIsLogged()
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase().Throws(new RedisConnectionException(ConnectionFailureType.SocketFailure, "down"));
        var (store, log) = Store(redis);

        Assert.False(await store.SetAsync("bit:abc", "v"));
        Assert.Equal(LogLevel.Warning, Assert.Single(log.Records).Level);
    }

    [Fact]
    public async Task EveryHeartbeatReArmsTheIndexAndEveryEntry()
    {
        // Written at the steady TTL (40s); a startup beat records interval 30, so a re-arm shows as
        // 120s on both keys -- including an entry this replica did not write.
        var l2 = new InMemoryL2();
        await Store(l2.Multiplexer).Store.SetAsync("bit:abc", "v");
        var writer = new ProcessorLivenessWriter(l2.Multiplexer, new RecordingLogger<ProcessorLivenessWriter>());

        await writer.WriteAsync(Identity(), "another-pod", Entry(interval: 30));

        Assert.Equal(TimeSpan.FromSeconds(120), l2.Ttl(L2ProjectionKeys.ProcessorShared(P)));
        Assert.Equal(TimeSpan.FromSeconds(120), l2.Ttl(L2ProjectionKeys.ProcessorSharedEntry(P, "bit:abc")));
    }

    [Fact]
    public async Task AnIndexLineWhoseEntryExpiredIsPruned()
    {
        var l2 = new InMemoryL2();
        await Store(l2.Multiplexer).Store.SetAsync("bit:live", "v");
        await l2.Db.SetAddAsync(L2ProjectionKeys.ProcessorShared(P), "bit:expired");
        var writer = new ProcessorLivenessWriter(l2.Multiplexer, new RecordingLogger<ProcessorLivenessWriter>());

        await writer.WriteAsync(Identity(), "pod-0", Entry(interval: 10));

        Assert.Equal(["bit:live"], l2.Members(L2ProjectionKeys.ProcessorShared(P)));
    }

    [Fact]
    public async Task AProcessorWithNothingSharedLeavesNoIndexBehind()
    {
        var l2 = new InMemoryL2();
        var writer = new ProcessorLivenessWriter(l2.Multiplexer, new RecordingLogger<ProcessorLivenessWriter>());

        await writer.WriteAsync(Identity(), "pod-0", Entry(interval: 10));

        Assert.Empty(l2.Members(L2ProjectionKeys.ProcessorShared(P)));
        Assert.Null(l2.Ttl(L2ProjectionKeys.ProcessorShared(P)));
    }

    [Fact]
    public async Task ARefreshFaultDoesNotCostLiveness()
    {
        // Liveness is what the start gate reads; the refresh runs after it and fails on its own.
        var db = Substitute.For<IDatabase>();
        db.KeyExpireAsync(
                Arg.Is<RedisKey>(k => k == L2ProjectionKeys.ProcessorShared(P)),
                Arg.Any<TimeSpan?>(), Arg.Any<ExpireWhen>(), Arg.Any<CommandFlags>())
            .Throws(new RedisTimeoutException("timed out", CommandStatus.WaitingInBacklog));
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase().Returns(db);
        var log = new RecordingLogger<ProcessorLivenessWriter>();

        await new ProcessorLivenessWriter(redis, log).WriteAsync(Identity(), "pod-0", Entry(interval: 10));

        await db.Received(1).StringSetAsync(
            L2ProjectionKeys.PerInstance(P, "pod-0"), Arg.Any<RedisValue>(), Arg.Any<TimeSpan?>(),
            Arg.Any<When>(), Arg.Any<CommandFlags>());
        var record = Assert.Single(log.Records);
        Assert.Contains("shared entry refresh failed", record.Message, StringComparison.Ordinal);
    }
}
