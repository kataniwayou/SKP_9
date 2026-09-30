using BaseApi.Tests.Support;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Identity;
using BaseProcessor.Core.Liveness;
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
/// The writer's contract under a Redis fault: its caller is a loop whose next iteration writes
/// again, so a fault must be recorded and swallowed rather than ending that loop.
/// </summary>
public sealed class LivenessWriterTests
{
    private static readonly Guid P = Guid.Parse("44444444-4444-4444-dddd-444444444444");

    private static ProcessorIdentity Identity() =>
        new(P, null, null, null, "shared-proc", "1.2.0", null, null);

    private static ProcessorLivenessEntry Entry() => ProcessorLivenessEntry.Create(
        inputOutcome: SchemaOutcome.Success,
        outputOutcome: SchemaOutcome.Success,
        configOutcome: SchemaOutcome.Success,
        timestamp: new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc),
        interval: 10);

    private static (ProcessorLivenessWriter Writer, RecordingLogger<ProcessorLivenessWriter> Log)
        Build(IConnectionMultiplexer redis)
    {
        var log = new RecordingLogger<ProcessorLivenessWriter>();
        return (new ProcessorLivenessWriter(redis, log), log);
    }

    [Fact]
    public async Task ConnectionFaultIsLoggedAndSwallowed()
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase().Throws(new RedisConnectionException(
            ConnectionFailureType.SocketFailure, "no connection"));
        var (writer, log) = Build(redis);

        await writer.WriteAsync(Identity(), "instance-1", Entry());

        var record = Assert.Single(log.Records);
        Assert.Equal(LogLevel.Warning, record.Level);
        Assert.IsType<RedisConnectionException>(record.Exception);
    }

    [Fact]
    public async Task SetFaultIsLoggedAndSwallowed()
    {
        var db = Substitute.For<IDatabase>();
        // Matched against the five-parameter (expiry, When, CommandFlags) overload the writer now
        // names explicitly. The Expiration/ValueCondition matchers this replaces bound a DIFFERENT
        // overload — the one the compiler used to pick for a bare three-argument call — so they would
        // silently stop matching the moment the call site was disambiguated.
        db.StringSetAsync(
                Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Any<TimeSpan?>(),
                Arg.Any<When>(), Arg.Any<CommandFlags>())
            .Throws(new RedisTimeoutException("timed out", CommandStatus.WaitingInBacklog));

        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase().Returns(db);
        var (writer, log) = Build(redis);

        await writer.WriteAsync(Identity(), "instance-1", Entry());

        var record = Assert.Single(log.Records);
        Assert.Equal(LogLevel.Warning, record.Level);
        Assert.IsType<RedisTimeoutException>(record.Exception);
    }

    [Fact]
    public async Task IndexFaultIsLoggedAndSwallowed()
    {
        // The per-instance key succeeded and only the index add failed — still swallowed, because the
        // index is re-added idempotently on the next write.
        var db = Substitute.For<IDatabase>();
        db.SetAddAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Any<CommandFlags>())
            .Throws(new RedisTimeoutException("timed out", CommandStatus.WaitingInBacklog));

        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase().Returns(db);
        var (writer, log) = Build(redis);

        await writer.WriteAsync(Identity(), "instance-1", Entry());

        Assert.Single(log.Records);
    }

    [Fact]
    public async Task WritesTheKeyAndTheInstanceSetBothWithTheTtl()
    {
        var l2 = new InMemoryL2();
        var (writer, log) = Build(l2.Multiplexer);

        await writer.WriteAsync(Identity(), "instance-1", Entry());

        // TTL is four times the entry's own recorded interval: 10 * 4 = 40. The instance set carries
        // the same TTL, so a processor whose replicas are all gone leaves nothing behind.
        Assert.Equal(TimeSpan.FromSeconds(40), l2.Ttl(L2ProjectionKeys.PerInstance(P, "instance-1")));
        Assert.Equal(["instance-1"], l2.Members(L2ProjectionKeys.ProcessorInstances(P)));
        Assert.Equal(TimeSpan.FromSeconds(40), l2.Ttl(L2ProjectionKeys.ProcessorInstances(P)));
        Assert.Empty(log.Records);
    }

    [Fact]
    public async Task NullEntryStillThrows()
    {
        // The guard is outside the try on purpose: a null entry is a caller bug, not an environment
        // fault, and swallowing it would hide the defect behind a silent no-write.
        var (writer, _) = Build(Substitute.For<IConnectionMultiplexer>());

        await Assert.ThrowsAsync<ArgumentNullException>(
            () => writer.WriteAsync(Identity(), "instance-1", null!));
    }

    [Fact]
    public async Task NullIdentityStillThrows()
    {
        var (writer, _) = Build(Substitute.For<IConnectionMultiplexer>());

        await Assert.ThrowsAsync<ArgumentNullException>(() => writer.WriteAsync(null!, "instance-1", Entry()));
    }

    [Fact]
    public async Task WritesItsOwnFullNameWithTheLivenessTtl()
    {
        var l2 = new InMemoryL2();
        var (writer, _) = Build(l2.Multiplexer);

        await writer.WriteAsync(Identity(), "pod-0", Entry());

        Assert.Equal(EntityNames.Format("shared-proc", "1.2.0", P),
                     l2.HashValue(L2ProjectionKeys.Processor(P), L2ProjectionKeys.NameField));
        Assert.Equal(TimeSpan.FromSeconds(40), l2.Ttl(L2ProjectionKeys.Processor(P)));
    }

    [Fact]
    public async Task EveryReplicaWritesTheSameNameWithNoInstanceIdInIt()
    {
        var l2 = new InMemoryL2();
        var (writer, _) = Build(l2.Multiplexer);

        await writer.WriteAsync(Identity(), "pod-0", Entry());
        var first = l2.HashValue(L2ProjectionKeys.Processor(P), L2ProjectionKeys.NameField);
        await writer.WriteAsync(Identity(), "pod-1", Entry());

        Assert.Equal(first, l2.HashValue(L2ProjectionKeys.Processor(P), L2ProjectionKeys.NameField));
        Assert.DoesNotContain("pod-", first);
    }

    [Fact]
    public async Task ANameWriteFailureStillLeavesTheLivenessKey()
    {
        // A WRONGTYPE that survives the delete-and-retry (another writer re-created the old SET in
        // between, as an old-image replica does every beat) still just logs. The liveness key is what
        // the start gate reads; it must already be written when the name fails.
        var l2 = new InMemoryL2();
        l2.Db.HashSetAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Any<RedisValue>(),
                           Arg.Any<When>(), Arg.Any<CommandFlags>())
            .Throws(new RedisServerException("WRONGTYPE Operation against a key holding the wrong kind of value"));
        var (writer, log) = Build(l2.Multiplexer);

        await writer.WriteAsync(Identity(), "pod-0", Entry());

        Assert.True(l2.Has(L2ProjectionKeys.PerInstance(P, "pod-0")));
        Assert.Equal(["pod-0"], l2.Members(L2ProjectionKeys.ProcessorInstances(P)));
        Assert.Equal(LogLevel.Warning, Assert.Single(log.Records).Level);
        Assert.Equal("processor name write failed for {ProcessorId}", Assert.Single(log.Templates));
    }

    [Fact]
    public async Task APreMigrationSetAtTheNameKeyIsReplacedByTheNameHash()
    {
        // Ruling R9: during a mis-ordered rollout the retired SET still sits at skp:proc:{id} and HSET
        // there answers WRONGTYPE. The processor owns that key, so it deletes it and writes once more.
        var l2 = new InMemoryL2();
        await l2.Db.SetAddAsync(L2ProjectionKeys.Processor(P), "old-instance");
        var (writer, log) = Build(l2.Multiplexer);

        await writer.WriteAsync(Identity(), "pod-0", Entry());

        Assert.Equal(EntityNames.Format("shared-proc", "1.2.0", P),
                     l2.HashValue(L2ProjectionKeys.Processor(P), L2ProjectionKeys.NameField));
        Assert.Empty(l2.Members(L2ProjectionKeys.Processor(P)));
        Assert.Equal(TimeSpan.FromSeconds(40), l2.Ttl(L2ProjectionKeys.Processor(P)));
        Assert.True(l2.Has(L2ProjectionKeys.PerInstance(P, "pod-0")));
        Assert.Equal(["pod-0"], l2.Members(L2ProjectionKeys.ProcessorInstances(P)));
        Assert.DoesNotContain(log.Records, r => r.Level >= LogLevel.Warning);
    }

    [Fact]
    public async Task AWrongTypeOnTheFirstNameWriteOnlyIsHealedByOneRetry()
    {
        // The same heal against a store that faults exactly once: the delete happens, the retry lands.
        var l2 = new InMemoryL2();
        var calls = 0;
        l2.Db.HashSetAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Any<RedisValue>(),
                           Arg.Any<When>(), Arg.Any<CommandFlags>())
            .Returns(_ => ++calls == 1
                ? Task.FromException<bool>(new RedisServerException("WRONGTYPE Operation against a key holding the wrong kind of value"))
                : Task.FromResult(true));
        var (writer, log) = Build(l2.Multiplexer);

        await writer.WriteAsync(Identity(), "pod-0", Entry());

        Assert.Equal(2, calls);
        await l2.Db.Received(1).KeyDeleteAsync(L2ProjectionKeys.Processor(P), Arg.Any<CommandFlags>());
        Assert.DoesNotContain(log.Records, r => r.Level >= LogLevel.Warning);
    }

    [Fact]
    public async Task ANonWrongTypeNameFaultIsNotRetriedAndDeletesNothing()
    {
        var l2 = new InMemoryL2();
        l2.Db.HashSetAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Any<RedisValue>(),
                           Arg.Any<When>(), Arg.Any<CommandFlags>())
            .Throws(new RedisTimeoutException("timed out", CommandStatus.WaitingInBacklog));
        var (writer, log) = Build(l2.Multiplexer);

        await writer.WriteAsync(Identity(), "pod-0", Entry());

        await l2.Db.DidNotReceive().KeyDeleteAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>());
        Assert.True(l2.Has(L2ProjectionKeys.PerInstance(P, "pod-0")));
        Assert.Equal("processor name write failed for {ProcessorId}", Assert.Single(log.Templates));
    }

    [Fact]
    public async Task ALivenessFaultKeepsItsOwnTemplate()
    {
        var db = Substitute.For<IDatabase>();
        db.StringSetAsync(
                Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Any<TimeSpan?>(),
                Arg.Any<When>(), Arg.Any<CommandFlags>())
            .Throws(new RedisTimeoutException("timed out", CommandStatus.WaitingInBacklog));
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase().Returns(db);
        var (writer, log) = Build(redis);

        await writer.WriteAsync(Identity(), "instance-1", Entry());

        Assert.Equal("liveness write failed for {ProcessorId}/{InstanceId}", Assert.Single(log.Templates));
    }
}
