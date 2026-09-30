using System.Text.Json;
using BaseApi.Service.Features.Orchestration.Messaging;
using BaseApi.Service.Features.Orchestration.Projection;
using BaseApi.Tests.Support;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Messaging.Transport;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using NSubstitute.ClearExtensions;
using NSubstitute.ExceptionExtensions;
using StackExchange.Redis;
using Xunit;
using RedisFieldWhitelist = Processor.SKNormalizer.RedisFieldWhitelist;

namespace BaseApi.Tests.Orchestration;

/// <summary>
/// What a start and a stop leave in L2 under the start-driven layout: the start writes and aligns only
/// its own workflow's keys; the stop only leaves the live set.
/// </summary>
public sealed class StartDrivenProjectionTests
{
    private static readonly Guid W  = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid W2 = Guid.Parse("99999999-9999-9999-9999-999999999999");
    private static readonly Guid S1 = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid S2 = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid P  = Guid.Parse("44444444-4444-4444-4444-444444444444");

    private sealed class Harness
    {
        public InMemoryL2 L2 { get; } = new();
        public IQueueFanoutPublisher Publisher { get; } = Substitute.For<IQueueFanoutPublisher>();

        /// <summary>The database's step rows, as the writer sees them. Every step exists unless a test
        /// says otherwise.</summary>
        public FakeStepRows Rows { get; set; } = FakeStepRows.Everything();

        public Task StartAsync(WorkflowL1 d) =>
            new StartOrchestrationHandler(
                    new L2ProjectionWriter(L2.Multiplexer, Rows), new L2LiveSet(L2.Multiplexer), Publisher,
                    NullLogger<StartOrchestrationHandler>.Instance)
                .HandleAsync(JsonSerializer.SerializeToUtf8Bytes(new StartOrchestration(d), MessagingJson.Options),
                             CancellationToken.None);

        public Task StopAsync(Guid workflowId) =>
            new StopOrchestrationHandler(new L2LiveSet(L2.Multiplexer), Publisher, NullLogger<StopOrchestrationHandler>.Instance)
                .HandleAsync(JsonSerializer.SerializeToUtf8Bytes(new StopOrchestration(workflowId), MessagingJson.Options),
                             CancellationToken.None);
    }

    private static WorkflowL1 Def(Guid w, Guid[] steps, List<CacheL1>? caches = null)
    {
        // The workflow and every step are named, exactly as ToDefinition does; no processor.
        var names = new Dictionary<Guid, string> { [w] = "chain_1.0.0-aaaa-111111111111" };
        foreach (var s in steps)
        {
            names[s] = EntityNames.Format("step", "1.0.0", s);
        }

        return new WorkflowL1(
            WorkflowId: w,
            EntryStepIds: [steps[0]],
            Cron: "0 0/5 * * * ?",
            Steps: steps.Select(s => new StepL1(s, 4, P, "{}", [])).ToList(),
            Caches: caches ?? [],
            Names: names);
    }

    private static CacheL1 Whitelist(params string[] keys) =>
        new("sk-whitelist", keys.ToDictionary(k => k, k => k.ToUpperInvariant()));

    [Fact]
    public async Task StartWritesNameStoreAndRootsOnTheWorkflowHash()
    {
        var h = new Harness();

        await h.StartAsync(Def(W, [S1, S2], [Whitelist("acme")]));

        Assert.Equal("chain_1.0.0-aaaa-111111111111", h.L2.HashValue(L2ProjectionKeys.Workflow(W), L2ProjectionKeys.NameField));
        var store = JsonSerializer.Deserialize<WorkflowStoreProjection>(
            h.L2.HashValue(L2ProjectionKeys.Workflow(W), L2ProjectionKeys.StoreField)!, MessagingJson.Options)!;
        Assert.Equal([S1], store.EntryStepIds);
        Assert.Equal([S1, S2], store.Steps.Select(s => s.StepId));
        Assert.Equal("[\"sk-whitelist\"]", h.L2.HashValue(L2ProjectionKeys.Workflow(W), L2ProjectionKeys.RootsField));
    }

    [Fact]
    public async Task StartWritesEachStepNameAndNoProcessorKeyAndNoPerStepKey()
    {
        var h = new Harness();

        await h.StartAsync(Def(W, [S1, S2]));

        Assert.NotNull(h.L2.HashValue(L2ProjectionKeys.StepEntity(S1), L2ProjectionKeys.NameField));
        Assert.NotNull(h.L2.HashValue(L2ProjectionKeys.StepEntity(S2), L2ProjectionKeys.NameField));
        Assert.False(h.L2.HasHash(L2ProjectionKeys.Processor(P)));
        Assert.DoesNotContain(h.L2.Keys(), k => k == $"skp:{W:D}:{S1:D}" || k == $"skp:{W:D}");
    }

    [Fact]
    public async Task StartJoinsTheLiveSetThenAnnounces()
    {
        var h = new Harness();
        var liveAtAnnounce = false;
        h.Publisher.When(p => p.PublishAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<OrchestrationStarted>(), Arg.Any<CancellationToken>()))
                   .Do(_ => liveAtAnnounce = h.L2.Members(L2ProjectionKeys.Live()).Contains(W.ToString("D")));

        await h.StartAsync(Def(W, [S1]));

        Assert.True(liveAtAnnounce);
        await h.Publisher.Received(1).PublishAsync(OrchestratorFanout.Exchange, MessageTypes.OrchestrationStarted,
            Arg.Is<OrchestrationStarted>(a => a.WorkflowId == W), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task ARestartDeletesOnlyItsOwnRemovedItemsAndUnboundRoots()
    {
        var h = new Harness();
        await h.StartAsync(Def(W, [S1], [Whitelist("acme", "globex"), new CacheL1("old-root", new() { ["k"] = "v" })]));

        await h.StartAsync(Def(W, [S1], [Whitelist("acme")]));

        Assert.True(h.L2.Has(L2ProjectionKeys.CacheEntry(W, "sk-whitelist", "acme")));
        Assert.False(h.L2.Has(L2ProjectionKeys.CacheEntry(W, "sk-whitelist", "globex")));
        Assert.False(h.L2.Has(L2ProjectionKeys.Cache(W, "old-root")));
        Assert.False(h.L2.Has(L2ProjectionKeys.CacheEntry(W, "old-root", "k")));
    }

    [Fact]
    public async Task ARestartQueuesItsLeftoverDeleteBeforeItOverwritesTheRecords()
    {
        // The batch is pipelined, not MULTI, so a connection lost part-way leaves a prefix applied. The
        // delete must be in that prefix before the roots field and key lists it was computed from are
        // overwritten, or a torn batch leaves a rerun with nothing to find. InMemoryL2 applies each
        // batch call eagerly, so the order is observed on the batch substitute's calls.
        var h = new Harness();
        await h.StartAsync(Def(W, [S1], [Whitelist("acme", "globex")]));
        var order = new List<string>();
        var batch = h.L2.Db.CreateBatch();
        batch.When(b => b.KeyDeleteAsync(Arg.Any<RedisKey[]>(), Arg.Any<CommandFlags>()))
             .Do(_ => order.Add("delete"));
        batch.When(b => b.HashSetAsync(Arg.Any<RedisKey>(), Arg.Any<HashEntry[]>(), Arg.Any<CommandFlags>()))
             .Do(_ => order.Add("store"));
        // The same call form the writer uses, so the hook binds to the overload it resolves to.
        batch.When(b => b.StringSetAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>()))
             .Do(_ => order.Add("cache"));

        await h.StartAsync(Def(W, [S1], [Whitelist("acme")]));

        Assert.Equal("delete", order.First());
        Assert.Single(order, "delete");
        Assert.Contains("store", order);
        Assert.Contains("cache", order);
        Assert.False(h.L2.Has(L2ProjectionKeys.CacheEntry(W, "sk-whitelist", "globex")));
    }

    [Fact]
    public async Task AnItemRemovedBeforeARestartIsUnlistedAfterIt()
    {
        var h = new Harness();
        await h.StartAsync(Def(W, [S1], [Whitelist("acme", "globex")]));
        await h.StartAsync(Def(W, [S1], [Whitelist("acme")]));

        var whitelist = new RedisFieldWhitelist(h.L2.Multiplexer, W, "sk-whitelist", new RecordingLogger<RedisFieldWhitelist>());

        Assert.True(whitelist.TryGet("acme", out _));
        Assert.False(whitelist.TryGet("globex", out _));
    }

    [Fact]
    public async Task ARestartThatDropsAStepLeavesItsNameKey()
    {
        // Steps are shared across workflows: W dropping S2 must not take S2's name from W2.
        var h = new Harness();
        await h.StartAsync(Def(W, [S1, S2]));
        await h.StartAsync(Def(W2, [S2]));

        await h.StartAsync(Def(W, [S1]));

        Assert.NotNull(h.L2.HashValue(L2ProjectionKeys.StepEntity(S2), L2ProjectionKeys.NameField));
    }

    [Fact]
    public async Task ARemovedStepWhoseRowIsGoneLosesItsNameKey()
    {
        // W dropped S2 and the operator then deleted S2 — which referential integrity only allows once
        // no workflow references it. W's next start is what aligns S2's key with the database.
        var h = new Harness();
        await h.StartAsync(Def(W, [S1, S2]));
        h.Rows = FakeStepRows.Only(S1);

        await h.StartAsync(Def(W, [S1]));

        Assert.False(h.L2.HasHash(L2ProjectionKeys.StepEntity(S2)));
        Assert.NotNull(h.L2.HashValue(L2ProjectionKeys.StepEntity(S1), L2ProjectionKeys.NameField));
    }

    [Fact]
    public async Task OnlyTheRemovedStepsAreLookedUp()
    {
        // One database read, and only about the steps this start dropped: kept and added steps are
        // participants, so they exist by definition.
        var h = new Harness();
        await h.StartAsync(Def(W, [S1, S2]));
        var s3 = Guid.NewGuid();
        h.Rows = FakeStepRows.Only(S1, s3);

        await h.StartAsync(Def(W, [S1, s3]));

        Assert.Equal([S2], h.Rows.Asked);
    }

    [Fact]
    public async Task AStartThatDropsNothingReadsNoStepRows()
    {
        var h = new Harness();
        await h.StartAsync(Def(W, [S1, S2]));
        h.Rows = FakeStepRows.Only(S1, S2);

        await h.StartAsync(Def(W, [S1, S2]));

        Assert.Empty(h.Rows.Asked);
    }

    [Fact]
    public async Task AnAddedStepGetsItsNameKey()
    {
        var h = new Harness();
        await h.StartAsync(Def(W, [S1]));

        await h.StartAsync(Def(W, [S1, S2]));

        Assert.NotNull(h.L2.HashValue(L2ProjectionKeys.StepEntity(S2), L2ProjectionKeys.NameField));
    }

    [Fact]
    public async Task ARestartAfterARemovalLeavesTheSameState()
    {
        var h = new Harness();
        await h.StartAsync(Def(W, [S1, S2]));
        h.Rows = FakeStepRows.Only(S1);
        await h.StartAsync(Def(W, [S1]));
        var once = h.L2.Snapshot();

        await h.StartAsync(Def(W, [S1]));

        Assert.Equal(once, h.L2.Snapshot());
    }

    [Fact]
    public async Task TheRemovedStepKeyIsDeletedInTheLeadingDelete()
    {
        // Same torn-batch argument as the cache leftovers: the delete precedes the store overwrite, so a
        // batch torn in between leaves the previous store for the rerun to recompute the same removal.
        var h = new Harness();
        await h.StartAsync(Def(W, [S1, S2]));
        h.Rows = FakeStepRows.Only(S1);
        var order = new List<string>();
        var batch = h.L2.Db.CreateBatch();
        batch.When(b => b.KeyDeleteAsync(Arg.Any<RedisKey[]>(), Arg.Any<CommandFlags>()))
             .Do(ci => order.Add(ci.ArgAt<RedisKey[]>(0).Any(k => k == L2ProjectionKeys.StepEntity(S2)) ? "delete-step" : "delete"));
        batch.When(b => b.HashSetAsync(Arg.Any<RedisKey>(), Arg.Any<HashEntry[]>(), Arg.Any<CommandFlags>()))
             .Do(_ => order.Add("store"));

        await h.StartAsync(Def(W, [S1]));

        Assert.Equal("delete-step", order.First());
    }

    [Fact]
    public async Task AStartNeverTouchesAnotherWorkflowsKeys()
    {
        var h = new Harness();
        await h.StartAsync(Def(W2, [S2], [Whitelist("initech")]));
        var before = W2Lines(h);

        await h.StartAsync(Def(W, [S1], [Whitelist("acme")]));

        Assert.Equal(before, W2Lines(h));
    }

    /// <summary>
    /// Every snapshot line naming W2, except the live set's: that set is shared by design, and W joining
    /// it is the one change a start of W is supposed to make there.
    /// </summary>
    private static List<string> W2Lines(Harness h)
    {
        var live = $"set {L2ProjectionKeys.Live()} = ";
        return h.L2.Snapshot().Split('\n')
            .Where(l => l.Contains(W2.ToString("D")) && !l.StartsWith(live, StringComparison.Ordinal))
            .ToList();
    }

    [Fact]
    public async Task StopLeavesTheLiveSetFirstThenAnnouncesAndKeepsTheStore()
    {
        var h = new Harness();
        await h.StartAsync(Def(W, [S1], [Whitelist("acme")]));
        var liveAtAnnounce = true;
        h.Publisher.When(p => p.PublishAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<OrchestrationStopped>(), Arg.Any<CancellationToken>()))
                   .Do(_ => liveAtAnnounce = h.L2.Members(L2ProjectionKeys.Live()).Contains(W.ToString("D")));

        await h.StopAsync(W);

        Assert.False(liveAtAnnounce);
        Assert.NotNull(h.L2.HashValue(L2ProjectionKeys.Workflow(W), L2ProjectionKeys.StoreField));
        Assert.True(h.L2.Has(L2ProjectionKeys.CacheEntry(W, "sk-whitelist", "acme")));
    }

    [Fact]
    public async Task AFailedStopAnnouncementEscapesAndTheRedeliveryConverges()
    {
        var h = new Harness();
        await h.StartAsync(Def(W, [S1]));
        h.Publisher.PublishAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<OrchestrationStopped>(), Arg.Any<CancellationToken>())
                   .ThrowsAsync(new TransientSendException("broker down", new IOException("reset")));

        await Assert.ThrowsAsync<TransientSendException>(() => h.StopAsync(W));
        h.Publisher.ClearSubstitute();
        await h.StopAsync(W);

        Assert.Empty(h.L2.Members(L2ProjectionKeys.Live()));
    }
}
