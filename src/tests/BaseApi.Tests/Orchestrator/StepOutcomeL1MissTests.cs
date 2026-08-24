using Messaging.Contracts;
using Orchestrator.L1;
using Orchestrator.Messaging;
using Xunit;

namespace BaseApi.Tests.Orchestrator;

/// <summary>
/// When a step outcome cannot be resolved in L1, the record must say WHICH lookup missed.
/// <para>
/// <b>This exists because the undifferentiated message cost an investigation.</b> Six step outcomes
/// were found dead-lettered on the live stack, each carrying
/// <c>"the outcome names a workflow or step this replica does not hold in L1"</c>. That sentence
/// covers two conditions with different causes and different fixes — the workflow is absent from this
/// replica's L1, or the workflow is present and does not carry that step — and the logs could not
/// separate them. Ruling out even one reading took correlating dead-letter <c>x-death</c> headers
/// against restart records across two days, and it still did not settle which half had failed.
/// </para>
/// <para>
/// The two readings are genuinely different incidents. A missing WORKFLOW means this replica never
/// activated it, or dropped it — a control-plane problem. A missing STEP means the replica holds a
/// definition that disagrees with the outcome in flight — a versioning problem. Nothing downstream
/// can tell them apart if the record does not.
/// </para>
/// </summary>
public sealed class StepOutcomeL1MissTests
{
    private static readonly Guid Workflow = Guid.Parse("4cd8af45-1295-43db-ab2e-e955dd82b5c5");
    private static readonly Guid StepHeld = Guid.Parse("4510e105-6730-4e02-a8ec-e53e0a77498e");
    private static readonly Guid StepAbsent = Guid.Parse("2da2bb32-22a6-46a6-8c34-04316b4c9693");

    private static WorkflowL1Store StoreHolding(params Guid[] stepIds)
    {
        var store = new WorkflowL1Store();
        var steps = stepIds
            .Select(id => new StepL1(id, 0, Guid.NewGuid(), "{}", []))
            .ToList();
        store.Set(Workflow, new WorkflowL1(Workflow, [.. stepIds.Take(1)], "0/30 * * * * ?", steps), Guid.NewGuid());
        return store;
    }

    [Fact]
    public void AnAbsentWorkflowSaysTheWorkflowIsAbsent()
    {
        var store = new WorkflowL1Store();   // holds nothing at all

        var message = StepOutcomeHandler.DescribeL1Miss(store, Workflow, StepHeld);

        Assert.Contains("does not hold workflow", message, StringComparison.Ordinal);
        Assert.DoesNotContain("does not carry step", message, StringComparison.Ordinal);
    }

    [Fact]
    public void AnAbsentStepSaysTheStepIsAbsentAndHowManyAreHeld()
    {
        // The workflow IS held. This is the other reading entirely, and the step count is what makes
        // it actionable: a replica holding a definition with the wrong number of steps is a
        // versioning problem you can see at a glance.
        var store = StoreHolding(StepHeld);

        var message = StepOutcomeHandler.DescribeL1Miss(store, Workflow, StepAbsent);

        Assert.Contains("does not carry step", message, StringComparison.Ordinal);
        Assert.DoesNotContain("does not hold workflow", message, StringComparison.Ordinal);
        Assert.Contains("1 step", message, StringComparison.Ordinal);
    }

    [Fact]
    public void TheMessageNamesTheIdsSoADeadLetteredCopyCanBeMatchedToIt()
    {
        // A parked message is recoverable only by hand, from the dead-letter queue, and the only way
        // to pair a queued body with the log line that refused it is the ids. Six of them sat in a
        // DLQ for two days precisely because nothing connected the two.
        var store = new WorkflowL1Store();

        var message = StepOutcomeHandler.DescribeL1Miss(store, Workflow, StepHeld);

        Assert.Contains(Workflow.ToString(), message, StringComparison.Ordinal);
        Assert.Contains(StepHeld.ToString(), message, StringComparison.Ordinal);
    }

    [Fact]
    public void AResolvableOutcomeIsNotAMiss()
    {
        // The guard against a diagnostic that fires on the healthy path. If this ever returns a
        // message for a step the replica holds, every successful outcome would be described as a
        // failure -- and the whole point of the split is that the two are told apart.
        var store = StoreHolding(StepHeld, StepAbsent);

        Assert.Null(StepOutcomeHandler.DescribeL1Miss(store, Workflow, StepHeld));
        Assert.Null(StepOutcomeHandler.DescribeL1Miss(store, Workflow, StepAbsent));
    }
}
