using Messaging.Contracts;
using Orchestrator.L1;
using Xunit;

namespace BaseApi.Tests.Orchestrator;

/// <summary>
/// L1 is a dictionary, and the activation tests already drive <c>Set</c> and <c>TryGet</c> through the
/// real path. This covers the one operation that path does not reach — the stop handler's
/// <c>Remove</c> — so nothing on this type ships unexercised.
/// </summary>
public sealed class WorkflowL1StoreTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");

    private static WorkflowL1 Definition(Guid workflowId) => new(workflowId, [], null, []);

    [Fact]
    public void RemoveReportsWhetherThereWasAnythingToRemove()
    {
        // The stop handler is idempotent because of this: a second delivery finds nothing and says so.
        var store = new WorkflowL1Store();
        store.Set(W, Definition(W), Guid.NewGuid());

        Assert.True(store.Remove(W));
        Assert.False(store.Remove(W));
        Assert.False(store.TryGet(W, out _));
    }
}
