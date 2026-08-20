using BaseApi.Tests.Support;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Liveness;
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

        await writer.WriteAsync(Guid.NewGuid(), "instance-1", Entry());

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

        await writer.WriteAsync(Guid.NewGuid(), "instance-1", Entry());

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

        await writer.WriteAsync(Guid.NewGuid(), "instance-1", Entry());

        Assert.Single(log.Records);
    }

    [Fact]
    public async Task WritesTheKeyAndTheIndexOnTheHappyPath()
    {
        var db = Substitute.For<IDatabase>();
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase().Returns(db);
        var (writer, log) = Build(redis);
        var processorId = Guid.NewGuid();

        await writer.WriteAsync(processorId, "instance-1", Entry());

        // TTL is four times the entry's own recorded interval: 10 * 4 = 40.
        await db.Received(1).StringSetAsync(
            L2ProjectionKeys.PerInstance(processorId, "instance-1"),
            Arg.Any<RedisValue>(),
            TimeSpan.FromSeconds(40),
            Arg.Any<When>(), Arg.Any<CommandFlags>());
        await db.Received(1).SetAddAsync(
            L2ProjectionKeys.InstanceIndex(processorId), "instance-1", Arg.Any<CommandFlags>());
        Assert.Empty(log.Records);
    }

    [Fact]
    public async Task NullEntryStillThrows()
    {
        // The guard is outside the try on purpose: a null entry is a caller bug, not an environment
        // fault, and swallowing it would hide the defect behind a silent no-write.
        var (writer, _) = Build(Substitute.For<IConnectionMultiplexer>());

        await Assert.ThrowsAsync<ArgumentNullException>(
            () => writer.WriteAsync(Guid.NewGuid(), "instance-1", null!));
    }
}
