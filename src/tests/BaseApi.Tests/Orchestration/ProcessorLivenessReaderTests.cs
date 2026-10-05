using System.Text.Json;
using BaseApi.Core.Persistence;
using BaseApi.Service;
using BaseApi.Service.Features.Orchestration;
using BaseApi.Service.Features.Orchestration.Validation;
using BaseApi.Service.Features.Processor;
using Messaging.Contracts.Projections;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using NSubstitute;
using NSubstitute.ExceptionExtensions;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Orchestration;

public sealed class ProcessorLivenessReaderTests
{
    private static readonly DateTime Now = new(2026, 1, 1, 12, 0, 0, DateTimeKind.Utc);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private readonly IDatabase _db = Substitute.For<IDatabase>();
    private readonly FakeTimeProvider _clock = new(new DateTimeOffset(Now, TimeSpan.Zero));

    private ProcessorLivenessProbe Probe()
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase().Returns(_db);
        return new ProcessorLivenessProbe(redis, _clock);
    }

    private static AppDbContext Db() =>
        new(new DbContextOptionsBuilder<AppDbContext>().UseInMemoryDatabase($"liveness-{Guid.NewGuid():N}").Options);

    private static async Task<Guid> AddProcessor(AppDbContext db, string name)
    {
        var p = new ProcessorEntity { Id = Guid.NewGuid(), Name = name, Version = "1.0.0", SourceHash = Guid.NewGuid().ToString("N") };
        db.Add(p);
        await db.SaveChangesAsync(Ct);
        return p.Id;
    }

    private static RedisValue Healthy() =>
        JsonSerializer.Serialize(new ProcessorLivenessEntry(Now, 10, LivenessStatus.Healthy,
            new LivenessSummary(SchemaOutcome.Success, SchemaOutcome.Success, SchemaOutcome.Success)));

    [Fact]
    public async Task ReportsEveryProcessorRowOrderedByName()
    {
        await using var db = Db();
        var zeta = await AddProcessor(db, "zeta");
        var alpha = await AddProcessor(db, "alpha");
        _db.SetMembersAsync(L2ProjectionKeys.ProcessorInstances(alpha)).Returns(new RedisValue[] { "i1" });
        _db.StringGetAsync(L2ProjectionKeys.PerInstance(alpha, "i1")).Returns(Healthy());
        _db.SetMembersAsync(L2ProjectionKeys.ProcessorInstances(zeta)).Returns(Array.Empty<RedisValue>());

        var result = await new ProcessorLivenessReader(db, Probe()).ReadAllAsync(Ct);

        Assert.Equal(
            [new ProcessorLivenessDto(alpha, true, 1, 1, 0, 0, 0, 0), new ProcessorLivenessDto(zeta, false, 0, 0, 0, 0, 0, 0)],
            result);
    }

    [Fact]
    public async Task ARedisFaultPropagatesTaggedWithItsOperation()
    {
        await using var db = Db();
        await AddProcessor(db, "p");
        _db.SetMembersAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>())
            .ThrowsAsync(new RedisConnectionException(ConnectionFailureType.UnableToConnect, "down"));

        var ex = await Assert.ThrowsAsync<RedisConnectionException>(() => new ProcessorLivenessReader(db, Probe()).ReadAllAsync(Ct));

        Assert.Equal("ProcessorLivenessRead", ex.Data["redisOp"]);
    }
}
