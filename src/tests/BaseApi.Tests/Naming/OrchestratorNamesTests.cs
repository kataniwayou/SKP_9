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
        await l2.Db.StringSetAsync(L2ProjectionKeys.Name(W), "chain_1.0.0-aaaa-111111111111");
        IEntityNameSource source = new L2WorkflowReader(l2.Multiplexer, NullLogger<L2WorkflowReader>.Instance);

        var found = await source.ReadNamesAsync([W]);

        Assert.Equal("chain_1.0.0-aaaa-111111111111", found[W]);
    }

    [Fact]
    public void TheReapLineNamesEveryReapedWorkflowWithoutChangingItsTemplate()
    {
        var store = new WorkflowL1Store();
        var clock = new FakeTimeProvider(DateTimeOffset.Parse("2026-09-29T12:00:00Z"));
        store.Set(W, new WorkflowL1(W, [], null, [], []), Guid.NewGuid());
        store.MarkDeleted(W, clock.GetUtcNow() - L1ReapService.GracePeriod - TimeSpan.FromMinutes(1));

        var names = new EntityNameResolver(new FakeNameSource(), NullLogger<EntityNameResolver>.Instance);
        var log = new RecordingLogger<L1ReapService>();

        new L1ReapService(store, clock, new BaseConsole.Core.Loop.LoopHeartbeat(clock), log, names).Reap();

        var i = log.Templates.ToList().FindIndex(t => t is not null && t.StartsWith("reaped {ReapedCount}", StringComparison.Ordinal));
        Assert.True(i >= 0);
        Assert.Equal("reaped {ReapedCount} workflow(s) stopped more than {GracePeriod} ago: {WorkflowIds}", log.Templates[i]);
        Assert.Equal(EntityNames.Fallback(W), log.RecordScopes[i][EntityNames.WorkflowNames]);
    }
}
