using BaseApi.Tests.Support;
using BaseConsole.Core.Naming;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Microsoft.Extensions.Logging.Abstractions;
using Orchestrator.L1;
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
}
