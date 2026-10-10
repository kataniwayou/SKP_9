using System.Text.Json;
using BaseApi.Core.Persistence;
using BaseApi.Service;
using BaseApi.Service.Features.Liveness;
using BaseApi.Service.Features.Processor;
using Messaging.Contracts.Projections;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;
using NSubstitute;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Liveness;

/// <summary>The monitor's reading: the live set, and every processor row judged by the start gate's probe.</summary>
public sealed class RedisLivenessSourceTests
{
    private static readonly DateTime Now = new(2026, 1, 1, 12, 0, 0, DateTimeKind.Utc);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private readonly IDatabase _db = Substitute.For<IDatabase>();
    private readonly FakeTimeProvider _clock = new(new DateTimeOffset(Now, TimeSpan.Zero));
    private readonly string _database = $"liveness-source-{Guid.NewGuid():N}";

    private IServiceScopeFactory Scopes()
    {
        var services = new ServiceCollection();
        services.AddDbContext<AppDbContext>(o => o.UseInMemoryDatabase(_database));
        services.AddScoped<BaseDbContext>(sp => sp.GetRequiredService<AppDbContext>());
        return services.BuildServiceProvider().GetRequiredService<IServiceScopeFactory>();
    }

    private RedisLivenessSource Source(IServiceScopeFactory scopes)
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase().Returns(_db);
        return new RedisLivenessSource(scopes, redis, _clock, Options.Create(new LivenessMonitorOptions { ProbeParallelism = 2 }));
    }

    private static async Task<Guid> AddProcessor(IServiceScopeFactory scopes)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var p = new ProcessorEntity { Id = Guid.NewGuid(), Name = "p", Version = "1.0.0", SourceHash = Guid.NewGuid().ToString("N") };
        db.Add(p);
        await db.SaveChangesAsync(Ct);
        return p.Id;
    }

    private static RedisValue Beat(int ageSeconds, int interval = 1) =>
        JsonSerializer.Serialize(new ProcessorLivenessEntry(Now.AddSeconds(-ageSeconds), interval, LivenessStatus.Healthy,
            new LivenessSummary(SchemaOutcome.Success, SchemaOutcome.Success, SchemaOutcome.Success)));

    [Fact]
    public async Task ReadsTheLiveSetAndJudgesEveryProcessorAsTheStartGateDoes()
    {
        var scopes = Scopes();
        var fresh = await AddProcessor(scopes);
        var stale = await AddProcessor(scopes);
        var none = await AddProcessor(scopes);
        var wf = Guid.NewGuid();
        _db.SetMembersAsync(L2ProjectionKeys.Live()).Returns(new RedisValue[] { wf.ToString("D"), "not-a-guid" });
        _db.SetMembersAsync(L2ProjectionKeys.ProcessorInstances(fresh)).Returns(new RedisValue[] { "i1", "i2" });
        _db.StringGetAsync(L2ProjectionKeys.PerInstance(fresh, "i1")).Returns(Beat(ageSeconds: 1));
        _db.StringGetAsync(L2ProjectionKeys.PerInstance(fresh, "i2")).Returns(Beat(ageSeconds: 2));   // timestamp + 2 x 1 s <= now: stale
        _db.SetMembersAsync(L2ProjectionKeys.ProcessorInstances(stale)).Returns(new RedisValue[] { "i1" });
        _db.StringGetAsync(L2ProjectionKeys.PerInstance(stale, "i1")).Returns(Beat(ageSeconds: 30));
        _db.SetMembersAsync(L2ProjectionKeys.ProcessorInstances(none)).Returns(Array.Empty<RedisValue>());

        var reading = await Source(scopes).ReadAsync(Ct);

        Assert.Equal([wf], reading.Running);
        Assert.Equal(3, reading.Processors.Count);
        Assert.Equal(new ProcessorLivenessStateDto(fresh, true, 1, 2, null), reading.Processors[fresh]);
        Assert.Equal(new ProcessorLivenessStateDto(stale, false, 0, 1, "no healthy replica (1 checked: 0 absent, 0 unhealthy, 1 stale, 0 malformed)"), reading.Processors[stale]);
        Assert.Equal(new ProcessorLivenessStateDto(none, false, 0, 0, "no healthy replica (0 checked: 0 absent, 0 unhealthy, 0 stale, 0 malformed)"), reading.Processors[none]);
    }

    [Fact]
    public async Task ARedisFaultPropagatesForTheMonitorToLogAndRetry()
    {
        var scopes = Scopes();
        await AddProcessor(scopes);
        _db.SetMembersAsync(Arg.Any<RedisKey>()).Returns<RedisValue[]>(_ => throw new RedisConnectionException(ConnectionFailureType.UnableToConnect, "down"));

        await Assert.ThrowsAsync<RedisConnectionException>(() => Source(scopes).ReadAsync(Ct));
    }
}
