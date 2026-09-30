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
        await l2.Db.HashSetAsync(L2ProjectionKeys.Workflow(W), L2ProjectionKeys.NameField, "wf_1.0.0-aaaa-111111111111");

        var found = await new RedisEntityNameSource(l2.Multiplexer)
            .ReadNamesAsync([new EntityRef(L2EntityKind.Workflow, W), new EntityRef(L2EntityKind.Step, S)]);

        Assert.Equal("wf_1.0.0-aaaa-111111111111", Assert.Single(found).Value);
    }

    [Fact]
    public async Task EachIdIsAskedForUnderItsOwnKind()
    {
        var w = Guid.NewGuid(); var s = Guid.NewGuid(); var p = Guid.NewGuid();
        var source = new FakeNameSource();
        var resolver = new EntityNameResolver(source, NullLogger<EntityNameResolver>.Instance);

        await resolver.ScopeAsync(w, s, p);

        Assert.Equal(
            [new EntityRef(L2EntityKind.Workflow, w), new EntityRef(L2EntityKind.Step, s), new EntityRef(L2EntityKind.Processor, p)],
            source.Requested);
    }

    [Fact]
    public async Task APreloadFillsTheCacheSoTheNextScopeReadsNothing()
    {
        var w = Guid.NewGuid(); var s = Guid.NewGuid();
        var source = new FakeNameSource(new() { [w] = "chain_1.0.0-aaaa-111111111111", [s] = "step-a_1.0.0-bbbb-222222222222" });
        var resolver = new EntityNameResolver(source, NullLogger<EntityNameResolver>.Instance);

        await resolver.PreloadAsync([new(L2EntityKind.Workflow, w), new(L2EntityKind.Step, s)]);
        var reads = source.Reads;
        await resolver.ScopeAsync(w, s, Guid.Empty);

        Assert.Equal(reads, source.Reads);
        Assert.Equal("chain_1.0.0-aaaa-111111111111", resolver.NameOrFallback(w));
    }

    [Fact]
    public async Task ARefreshOverwritesACachedName()
    {
        // Spec §6: a workflow or step renamed while stopped shows its new name from the next start.
        // The orchestrator refreshes at every activation, so a cached hit must not shield the old name.
        var source = new FakeNameSource(new() { [W] = "old_1.0.0-aaaa-111111111111" });
        var resolver = Resolver(source);
        await resolver.PreloadAsync([new(L2EntityKind.Workflow, W)]);

        source.Names[W] = "new_1.0.0-aaaa-111111111111";
        await resolver.RefreshAsync([new(L2EntityKind.Workflow, W)]);

        Assert.Equal("new_1.0.0-aaaa-111111111111", resolver.NameOrFallback(W));
    }

    [Fact]
    public async Task ARefreshThatFindsNothingKeepsTheCachedName()
    {
        var source = new FakeNameSource(new() { [W] = "old_1.0.0-aaaa-111111111111" });
        var resolver = Resolver(source);
        await resolver.PreloadAsync([new(L2EntityKind.Workflow, W)]);

        source.Names.Remove(W);
        await resolver.RefreshAsync([new(L2EntityKind.Workflow, W)]);

        Assert.Equal("old_1.0.0-aaaa-111111111111", resolver.NameOrFallback(W));
    }

    [Fact]
    public async Task ARefreshThatFaultsKeepsTheCachedNameAndDoesNotThrow()
    {
        var source = new FakeNameSource(new() { [W] = "old_1.0.0-aaaa-111111111111" });
        var resolver = Resolver(source);
        await resolver.PreloadAsync([new(L2EntityKind.Workflow, W)]);

        source.Fault = new RedisConnectionException(ConnectionFailureType.SocketFailure, "down");
        await resolver.RefreshAsync([new(L2EntityKind.Workflow, W)]);

        Assert.Equal("old_1.0.0-aaaa-111111111111", resolver.NameOrFallback(W));
    }

    [Fact]
    public async Task AScopeStillReadsACachedNameFromTheCacheAlone()
    {
        // The refresh is the orchestrator's; a processor's ScopeAsync keeps cache-first (spec §5).
        var source = new FakeNameSource(new() { [W] = "old_1.0.0-aaaa-111111111111" });
        var resolver = Resolver(source);
        await resolver.ScopeAsync(W, Guid.Empty, Guid.Empty);

        source.Names[W] = "new_1.0.0-aaaa-111111111111";
        var scope = await resolver.ScopeAsync(W, Guid.Empty, Guid.Empty);

        Assert.Equal("old_1.0.0-aaaa-111111111111", scope[EntityNames.WorkflowName]);
        Assert.Equal(1, source.Reads);
    }

    [Fact]
    public async Task APreloadAgainstAFaultingStoreDoesNotThrow()
    {
        var source = new FakeNameSource { Fault = new InvalidOperationException("down") };
        var resolver = new EntityNameResolver(source, NullLogger<EntityNameResolver>.Instance);

        await resolver.PreloadAsync([new(L2EntityKind.Workflow, Guid.NewGuid())]);
    }

    [Fact]
    public async Task TheRedisSourceReadsTheNameFieldOfEachKindsHash()
    {
        var w = Guid.NewGuid(); var p = Guid.NewGuid();
        var l2 = new InMemoryL2();
        await l2.Db.HashSetAsync(L2ProjectionKeys.Workflow(w), L2ProjectionKeys.NameField, "chain_1.0.0-aaaa-111111111111");
        await l2.Db.HashSetAsync(L2ProjectionKeys.Processor(p), L2ProjectionKeys.NameField, "proc_1.0.0-dddd-444444444444");

        var found = await RedisEntityNameSource.ReadAsync(l2.Db,
            [new(L2EntityKind.Workflow, w), new(L2EntityKind.Processor, p), new(L2EntityKind.Step, Guid.NewGuid())]);

        Assert.Equal(2, found.Count);
        Assert.Equal("proc_1.0.0-dddd-444444444444", found[p]);
    }

    /// <summary>
    /// Pins the "one round trip" claim in <see cref="RedisEntityNameSource.ReadAsync"/>'s doc comment:
    /// every <c>HashGetAsync</c> is issued before any of them is awaited. A regression that awaited each
    /// read sequentially would still pass every other test in this file -- they only assert on the final
    /// result -- so this one holds each read open with its own <see cref="TaskCompletionSource{TResult}"/>
    /// and checks all three calls already reached the database before <c>ReadAsync</c>'s own task can
    /// possibly have completed.
    /// </summary>
    [Fact]
    public async Task TheRedisSourceIssuesEveryReadBeforeAwaitingAny()
    {
        var w = Guid.NewGuid(); var s = Guid.NewGuid(); var p = Guid.NewGuid();
        var sources = new Dictionary<(RedisKey Key, RedisValue Field), TaskCompletionSource<RedisValue>>();
        var db = Substitute.For<IDatabaseAsync>();

        db.HashGetAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Any<CommandFlags>())
            .Returns(ci =>
            {
                var key = (ci.ArgAt<RedisKey>(0), ci.ArgAt<RedisValue>(1));
                var tcs = new TaskCompletionSource<RedisValue>();
                sources[key] = tcs;
                return tcs.Task;
            });

        var refs = new[]
        {
            new EntityRef(L2EntityKind.Workflow, w),
            new EntityRef(L2EntityKind.Step, s),
            new EntityRef(L2EntityKind.Processor, p),
        };

        var result = RedisEntityNameSource.ReadAsync(db, refs);

        // All three calls must have already reached the database -- unawaited -- before this line, or
        // the lookups below throw KeyNotFoundException.
        Assert.False(result.IsCompleted);
        await db.Received(1).HashGetAsync(L2ProjectionKeys.Workflow(w), L2ProjectionKeys.NameField, Arg.Any<CommandFlags>());
        await db.Received(1).HashGetAsync(L2ProjectionKeys.StepEntity(s), L2ProjectionKeys.NameField, Arg.Any<CommandFlags>());
        await db.Received(1).HashGetAsync(L2ProjectionKeys.Processor(p), L2ProjectionKeys.NameField, Arg.Any<CommandFlags>());
        Assert.Equal(3, sources.Count);

        sources[(L2ProjectionKeys.Workflow(w), L2ProjectionKeys.NameField)].SetResult("chain_1.0.0-aaaa-111111111111");
        sources[(L2ProjectionKeys.StepEntity(s), L2ProjectionKeys.NameField)].SetResult(RedisValue.Null);
        sources[(L2ProjectionKeys.Processor(p), L2ProjectionKeys.NameField)].SetResult("proc_1.0.0-dddd-444444444444");

        var found = await result;

        Assert.Equal(2, found.Count);
        Assert.Equal("chain_1.0.0-aaaa-111111111111", found[w]);
        Assert.Equal("proc_1.0.0-dddd-444444444444", found[p]);
        Assert.False(found.ContainsKey(s));
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

    /// <summary>
    /// The negative control for the regression above: a scope begun INSIDE an awaited async helper --
    /// the shape of the original bug -- must NOT reach the caller's own records. This is what proves
    /// <see cref="SharedLog"/> models AsyncLocal faithfully, which is what that regression test's
    /// result rests on.
    /// </summary>
    [Fact]
    public async Task AScopeBegunInsideAnAwaitedHelperIsNotVisibleOnTheCallersRecords()
    {
        var log = new SharedLog();
        var logger = log.For<EntityNameResolverTests>();

        async Task<IDisposable?> Helper()
        {
            await Task.Yield();
            return logger.BeginScope(new Dictionary<string, object> { [EntityNames.WorkflowName] = "wf_1.0.0-aaaa-111111111111" });
        }

        using (await Helper())
        {
            logger.LogInformation("logged after the helper returned");
        }

        Assert.False(log.ScopeOf("logged after the helper returned").ContainsKey(EntityNames.WorkflowName));
    }

    /// <summary>
    /// A stalled (not faulted) store -- e.g. Redis stuck behind CLIENT PAUSE -- must not delay a
    /// delivery indefinitely. <see cref="EntityNameResolver.ScopeAsync"/> caps the read at
    /// <c>ReadTimeout</c> (250ms); the resulting TimeoutException is caught the same way a source
    /// fault is, and the scope carries fallbacks.
    /// </summary>
    [Fact]
    public async Task ASourceThatNeverCompletesYieldsFallbacksWithinASecond()
    {
        var resolver = Resolver(new FakeNameSource { Stall = true });

        var scope = await resolver.ScopeAsync(W, S, P).WaitAsync(TimeSpan.FromSeconds(2), TestContext.Current.CancellationToken);

        Assert.Equal(EntityNames.Fallback(W), scope[EntityNames.WorkflowName]);
        Assert.Equal(EntityNames.Fallback(S), scope[EntityNames.StepName]);
        Assert.Equal(EntityNames.Fallback(P), scope[EntityNames.ProcessorName]);
    }
}
