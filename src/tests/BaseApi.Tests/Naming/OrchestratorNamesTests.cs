using BaseApi.Tests.Support;
using BaseConsole.Core.Naming;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using NSubstitute;
using Orchestrator.L1;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Naming;

public sealed class OrchestratorNamesTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-aaaa-111111111111");

    [Fact]
    public async Task TheReaderIsTheOrchestratorsNameSource()
    {
        var l2 = new InMemoryL2();
        await l2.Db.HashSetAsync(L2ProjectionKeys.Workflow(W), L2ProjectionKeys.NameField, "chain_1.0.0-aaaa-111111111111");
        IEntityNameSource source = new L2WorkflowReader(l2.Multiplexer, NullLogger<L2WorkflowReader>.Instance);

        var found = await source.ReadNamesAsync([new EntityRef(L2EntityKind.Workflow, W)]);

        Assert.Equal("chain_1.0.0-aaaa-111111111111", found[W]);
    }

    [Fact]
    public async Task TheReapLineNamesEveryReapedWorkflowWithoutChangingItsTemplate()
    {
        var w2 = Guid.Parse("55555555-5555-5555-5555-555555555555");
        var store = new WorkflowL1Store();
        var clock = new FakeTimeProvider(DateTimeOffset.Parse("2026-09-29T12:00:00Z"));
        store.Set(W, new WorkflowL1(W, [], null, [], []), Guid.NewGuid());
        store.Set(w2, new WorkflowL1(w2, [], null, [], []), Guid.NewGuid());
        store.MarkDeleted(W, clock.GetUtcNow() - L1ReapService.GracePeriod - TimeSpan.FromMinutes(1));
        store.MarkDeleted(w2, clock.GetUtcNow() - L1ReapService.GracePeriod - TimeSpan.FromMinutes(1));

        // Prime the resolver's cache with W's REAL name before reaping, the way an active workflow's
        // own deliveries would have. w2 is left unresolved, so the reap line must fall back for it
        // without failing to name W from the cache.
        var names = new EntityNameResolver(new FakeNameSource(new() { [W] = "chain_1.0.0-aaaa-111111111111" }),
            NullLogger<EntityNameResolver>.Instance);
        await names.ScopeAsync(W, Guid.Empty, Guid.Empty);

        var log = new RecordingLogger<L1ReapService>();

        new L1ReapService(store, clock, new BaseConsole.Core.Loop.LoopHeartbeat(clock), log, names).Reap();

        var i = log.Templates.ToList().FindIndex(t => t is not null && t.StartsWith("reaped {ReapedCount}", StringComparison.Ordinal));
        Assert.True(i >= 0);
        Assert.Equal("reaped {ReapedCount} workflow(s) stopped more than {GracePeriod} ago: {WorkflowIds}", log.Templates[i]);

        // Order-independent: ConcurrentDictionary enumeration order is not a contract, so this checks
        // the joined value is exactly {the cached real name, w2's fallback} with no other entries,
        // rather than pinning which one comes first.
        var joined = ((string)log.RecordScopes[i][EntityNames.WorkflowNames]).Split(", ");
        Assert.Equal(
            new[] { "chain_1.0.0-aaaa-111111111111", EntityNames.Fallback(w2) }.OrderBy(n => n, StringComparer.Ordinal),
            joined.OrderBy(n => n, StringComparer.Ordinal));
    }
}
