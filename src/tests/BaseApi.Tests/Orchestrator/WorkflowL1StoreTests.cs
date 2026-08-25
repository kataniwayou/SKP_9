using Messaging.Contracts;
using Orchestrator.L1;
using Xunit;

namespace BaseApi.Tests.Orchestrator;

/// <summary>
/// L1 is a dictionary, and the activation tests already drive <c>Set</c> and the lookups through the
/// real path. This covers what that path does not reach: the mark a stop leaves, and the reap that
/// eventually collects it.
/// <para>
/// <b>Why a stop marks instead of removing.</b> Removing the entry settled the control plane instantly
/// and broke the data plane for the length of one round trip — every step still running when the stop
/// landed came back to <c>StepOutcomeHandler</c>, found no workflow in L1, and was parked. The mark
/// keeps the definition resolvable while hiding the workflow from every path that could start new
/// work, and these tests pin both halves of that.
/// </para>
/// </summary>
public sealed class WorkflowL1StoreTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid V = Guid.Parse("22222222-2222-2222-2222-222222222222");

    private static readonly DateTimeOffset T0 =
        new(2026, 8, 25, 12, 0, 0, TimeSpan.Zero);

    private static WorkflowL1 Definition(Guid workflowId) => new(workflowId, [], null, []);

    private static WorkflowL1Store Holding(params Guid[] workflowIds)
    {
        var store = new WorkflowL1Store();
        foreach (var id in workflowIds)
        {
            store.Set(id, Definition(id), Guid.NewGuid());
        }

        return store;
    }

    [Fact]
    public void AMarkedWorkflowIsStillResolvableButNoLongerActive()
    {
        // The two halves of what a mark means. A test asserting only the first would pass on a stop
        // that did nothing at all; one asserting only the second would pass on the delete this
        // replaced.
        var store = Holding(W);

        Assert.True(store.MarkDeleted(W, T0));

        Assert.True(store.TryGetIncludingStopped(W, out var marked));
        Assert.Equal(T0, marked.DeletedAt);
        Assert.False(store.TryGetActive(W, out _));
    }

    [Fact]
    public void MarkingReportsWhetherThisCallIsWhatMarkedIt()
    {
        // What makes the stop path idempotent without a second read: a redelivery gets false and can
        // say "already stopped" rather than guessing.
        var store = Holding(W);

        Assert.True(store.MarkDeleted(W, T0));
        Assert.False(store.MarkDeleted(W, T0 + TimeSpan.FromMinutes(30)));
        Assert.False(store.MarkDeleted(V, T0));   // never held at all
    }

    [Fact]
    public void ASecondMarkDoesNotMoveTheStampThatBoundsTheGracePeriod()
    {
        // The reap is what bounds how long a stopped workflow stays resolvable, and it reads this
        // stamp. Refreshing it per delivery would postpone the reap by a full grace period each time,
        // so a stop redelivered on a loop would keep the entry alive forever — a leak that looks
        // exactly like correct idempotency from the outside.
        var store = Holding(W);
        store.MarkDeleted(W, T0);

        store.MarkDeleted(W, T0 + TimeSpan.FromHours(5));

        Assert.True(store.TryGetIncludingStopped(W, out var entry));
        Assert.Equal(T0, entry.DeletedAt);
    }

    [Fact]
    public void MarkingKeepsTheStepMapBuiltAtActivation()
    {
        // The mark rides a `with`-expression, and a record copy constructor does not re-run property
        // initializers — so the step map survives rather than being rebuilt on the control path. If
        // that ever stopped holding, marking would silently become O(steps) on every stop.
        var steps = new List<StepL1> { new(V, 0, Guid.NewGuid(), "{}", []) };
        var store = new WorkflowL1Store();
        store.Set(W, new WorkflowL1(W, [V], null, steps), Guid.NewGuid());
        Assert.True(store.TryGetActive(W, out var before));

        store.MarkDeleted(W, T0);

        Assert.True(store.TryGetIncludingStopped(W, out var after));
        Assert.Same(before.Steps, after.Steps);
    }

    [Fact]
    public void SettingAWorkflowClearsAnyMarkOnIt()
    {
        // A workflow stopped and started again inside the grace period has to come back fully, not as
        // a marked entry that resolves outcomes but never fires. Nothing in the activation path clears
        // the mark explicitly, so this is the guarantee that makes that work.
        var store = Holding(W);
        store.MarkDeleted(W, T0);

        store.Set(W, Definition(W), Guid.NewGuid());

        Assert.True(store.TryGetActive(W, out var restarted));
        Assert.Null(restarted.DeletedAt);
    }

    [Fact]
    public void TheReapTakesMarkedEntriesAtOrBeforeTheCutoffAndLeavesTheRest()
    {
        // Non-strict at the boundary, matching every other threshold here, so a grace period reads as
        // the number it is written as.
        var store = Holding(W, V);
        store.MarkDeleted(W, T0);
        store.MarkDeleted(V, T0 + TimeSpan.FromMinutes(1));

        Assert.Equal([W], store.ReapDeletedBefore(T0));

        Assert.False(store.TryGetIncludingStopped(W, out _));
        Assert.True(store.TryGetIncludingStopped(V, out _));
    }

    [Fact]
    public void TheReapNeverTakesAnUnmarkedWorkflowHoweverOldTheCutoff()
    {
        // The guard against the reaper becoming a way to delete running workflows. A cutoff far in the
        // future must still leave everything that was never stopped.
        var store = Holding(W, V);
        store.MarkDeleted(V, T0);

        store.ReapDeletedBefore(DateTimeOffset.MaxValue);

        Assert.True(store.TryGetActive(W, out _));
        Assert.False(store.TryGetIncludingStopped(V, out _));
    }

    [Fact]
    public void AWorkflowRestartedAfterTheCutoffIsNotReaped()
    {
        // The reason the removal is a compare-and-remove rather than a delete by key. A restart
        // between a scan and its removal writes a new, unmarked entry; deleting by key alone would
        // drop the workflow an operator had just started, and the next fire would find nothing in L1.
        var store = Holding(W);
        store.MarkDeleted(W, T0);
        store.Set(W, Definition(W), Guid.NewGuid());

        Assert.Empty(store.ReapDeletedBefore(T0 + TimeSpan.FromHours(2)));
        Assert.True(store.TryGetActive(W, out _));
    }
}
