using BaseApi.Tests.Support;
using BaseConsole.Core.Naming;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Naming;

public sealed class EntityNameResolverTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-aaaa-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-bbbb-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-cccc-333333333333");

    private static EntityNameResolver Resolver(IEntityNameSource source) =>
        new(source, NullLogger<EntityNameResolver>.Instance);

    [Fact]
    public async Task AHitNamesTheRecordAndIsReadOnce()
    {
        var source = new FakeNameSource(new() { [W] = "wf_1.0.0-aaaa-111111111111" });
        var resolver = Resolver(source);

        var first = await resolver.ScopeAsync(W, Guid.Empty, Guid.Empty);
        var second = await resolver.ScopeAsync(W, Guid.Empty, Guid.Empty);

        Assert.Equal("wf_1.0.0-aaaa-111111111111", first[EntityNames.WorkflowName]);
        Assert.Equal(first, second);
        Assert.Equal(1, source.Reads);
        Assert.False(first.ContainsKey(EntityNames.StepName));   // Guid.Empty is not an entity
    }

    [Fact]
    public async Task AMissLogsTheFallbackAndIsNotCached()
    {
        // Review focus 3: a key written after the first read is picked up by the next one.
        var source = new FakeNameSource();
        var resolver = Resolver(source);

        var miss = await resolver.ScopeAsync(Guid.Empty, S, Guid.Empty);
        source.Names[S] = "step_1.0.0-bbbb-222222222222";
        var hit = await resolver.ScopeAsync(Guid.Empty, S, Guid.Empty);

        Assert.Equal(EntityNames.Fallback(S), miss[EntityNames.StepName]);
        Assert.Equal("step_1.0.0-bbbb-222222222222", hit[EntityNames.StepName]);
        Assert.Equal(2, source.Reads);
    }

    [Fact]
    public async Task ASourceFaultYieldsFallbacksAndNeverThrows()
    {
        var source = new FakeNameSource { Fault = new RedisConnectionException(ConnectionFailureType.SocketFailure, "down") };

        var scope = await Resolver(source).ScopeAsync(W, S, P);

        Assert.Equal(EntityNames.Fallback(W), scope[EntityNames.WorkflowName]);
        Assert.Equal(EntityNames.Fallback(S), scope[EntityNames.StepName]);
        Assert.Equal(EntityNames.Fallback(P), scope[EntityNames.ProcessorName]);
    }

    [Fact]
    public async Task EachIdResolvesOnItsOwn()
    {
        // D3: a missing workflow name does not stop the processor's being found.
        var resolver = Resolver(new FakeNameSource(new() { [P] = "proc_1.0.0-cccc-333333333333" }));

        var scope = await resolver.ScopeAsync(W, Guid.Empty, P);

        Assert.Equal(EntityNames.Fallback(W), scope[EntityNames.WorkflowName]);
        Assert.Equal("proc_1.0.0-cccc-333333333333", scope[EntityNames.ProcessorName]);
    }

    [Fact]
    public async Task TheCachedViewNeverReadsTheSource()
    {
        var source = new FakeNameSource(new() { [W] = "wf_1.0.0-aaaa-111111111111" });
        var resolver = Resolver(source);

        Assert.Equal(EntityNames.Fallback(W), resolver.NameOrFallback(W));
        await resolver.ScopeAsync(W, Guid.Empty, Guid.Empty);

        Assert.Equal("wf_1.0.0-aaaa-111111111111", resolver.NameOrFallback(W));
        Assert.Equal("wf_1.0.0-aaaa-111111111111", resolver.CachedScope(W, Guid.Empty, Guid.Empty)[EntityNames.WorkflowName]);
        Assert.Equal(1, source.Reads);
    }

    [Fact]
    public async Task ConcurrentFirstLookupsAllGetTheName()
    {
        var resolver = Resolver(new FakeNameSource(new() { [W] = "wf_1.0.0-aaaa-111111111111" }));

        var scopes = await Task.WhenAll(Enumerable.Range(0, 32)
            .Select(_ => Task.Run(() => resolver.ScopeAsync(W, Guid.Empty, Guid.Empty))));

        Assert.All(scopes, s => Assert.Equal("wf_1.0.0-aaaa-111111111111", s[EntityNames.WorkflowName]));
    }

    [Fact]
    public async Task TheRedisSourceReadsNameKeysInOneMget()
    {
        var l2 = new InMemoryL2();
        await l2.Db.StringSetAsync(L2ProjectionKeys.Name(W), "wf_1.0.0-aaaa-111111111111");

        var found = await new RedisEntityNameSource(l2.Multiplexer).ReadNamesAsync([W, S]);

        Assert.Equal("wf_1.0.0-aaaa-111111111111", Assert.Single(found).Value);
        await l2.Db.Received(1).StringGetAsync(Arg.Any<RedisKey[]>(), Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task TheNoOpHelpersAcceptNoResolver()
    {
        var logger = NullLogger.Instance;
        EntityNameResolver? none = null;

        Assert.Null(await none.ScopeOrNullAsync(W, S, P));
        Assert.Null(logger.BeginNamesScope(null));
        Assert.Null(logger.BeginCachedNamesScope(null, W, S, P));
    }

    /// <summary>
    /// Pins the AsyncLocal rule documented on <see cref="EntityNameScopeExtensions"/>: a scope begun
    /// AFTER an await, but in the SAME frame that goes on to log, is visible on that frame's own
    /// records. (The bug this regression guards against is the opposite shape -- BeginScope called
    /// from inside the awaited async helper itself, whose AsyncLocal write never reaches the caller.)
    /// </summary>
    [Fact]
    public async Task AScopeBegunInTheCallersFrameAfterAnAwaitIsVisibleOnThatFramesOwnRecords()
    {
        var log = new SharedLog();
        var resolver = Resolver(new FakeNameSource(new() { [W] = "wf_1.0.0-aaaa-111111111111" }));
        var logger = log.For<EntityNameResolverTests>();

        using (logger.BeginNamesScope(await resolver.ScopeOrNullAsync(W, Guid.Empty, Guid.Empty)))
        {
            logger.LogInformation("after the await");
        }

        Assert.Equal(
            "wf_1.0.0-aaaa-111111111111",
            log.ScopeOf("after the await")[EntityNames.WorkflowName]);
    }
}
