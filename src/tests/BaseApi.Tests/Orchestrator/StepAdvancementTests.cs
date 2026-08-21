using Messaging.Contracts;
using Orchestrator.Dispatch;
using Xunit;

namespace BaseApi.Tests.Orchestrator;

public sealed class StepAdvancementTests
{
    private static readonly Guid A = Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    private static readonly Guid B = Guid.Parse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    private static readonly Guid C = Guid.Parse("cccccccc-cccc-cccc-cccc-cccccccccccc");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");

    private static StepL1 Step(Guid id, int condition, params Guid[] next) =>
        new(id, condition, P, "{}", [.. next]);

    private static Dictionary<Guid, StepL1> Map(params StepL1[] steps) =>
        steps.ToDictionary(s => s.StepId);

    [Theory]
    [InlineData(StepResult.Completed, 1)]
    [InlineData(StepResult.Failed, 2)]
    [InlineData(StepResult.Cancelled, 3)]
    public void ASuccessorGatedOnTheOutcomeThatHappenedIsSelected(StepResult result, int condition)
    {
        var a = Step(A, 1, B);
        var selection = StepAdvancement.SelectNext(result, a, Map(a, Step(B, condition)));

        Assert.Equal(B, Assert.Single(selection.Matches).StepId);
    }

    [Theory]
    [InlineData(StepResult.Completed)]
    [InlineData(StepResult.Failed)]
    [InlineData(StepResult.Cancelled)]
    public void AlwaysAcceptsEveryOutcome(StepResult result)
    {
        var a = Step(A, 1, B);
        var selection = StepAdvancement.SelectNext(result, a, Map(a, Step(B, 4)));

        Assert.Single(selection.Matches);
    }

    [Theory]
    [InlineData(StepResult.Completed)]
    [InlineData(StepResult.Failed)]
    [InlineData(StepResult.Cancelled)]
    public void NeverAcceptsNothing(StepResult result)
    {
        // Never (5) is not tested for — it is every value the predicate declines. A branch that
        // treated it as a case would be one more place for it to leak through.
        var a = Step(A, 1, B);
        var selection = StepAdvancement.SelectNext(result, a, Map(a, Step(B, 5)));

        Assert.Empty(selection.Matches);
        Assert.Empty(selection.Dangling);
    }

    [Fact]
    public void AConditionMismatchIsNotADanglingEdge()
    {
        // The distinction that keeps every branching workflow from looking broken: a step gated on
        // failure is MEANT not to run when its predecessor completed. Counting that as unresolved
        // would put a warning on the ordinary path of every graph that branches.
        var a = Step(A, 1, B);
        var selection = StepAdvancement.SelectNext(StepResult.Completed, a, Map(a, Step(B, 2)));

        Assert.Empty(selection.Matches);
        Assert.Empty(selection.Dangling);
    }

    [Fact]
    public void ASuccessorMissingFromTheMapIsReportedRatherThanDropped()
    {
        var a = Step(A, 1, B);
        var selection = StepAdvancement.SelectNext(StepResult.Completed, a, Map(a));

        Assert.Empty(selection.Matches);
        Assert.Equal(B, Assert.Single(selection.Dangling));
    }

    [Fact]
    public void ADanglingEdgeDoesNotSuppressItsResolvedSiblings()
    {
        // The two lists are independent: one broken edge must not cost the branches that are fine.
        var a = Step(A, 1, B, C);
        var selection = StepAdvancement.SelectNext(StepResult.Completed, a, Map(a, Step(C, 1)));

        Assert.Equal(C, Assert.Single(selection.Matches).StepId);
        Assert.Equal(B, Assert.Single(selection.Dangling));
    }

    [Fact]
    public void ATerminalStepIsNotAnUnresolvedOne()
    {
        // The contract-defined end of a branch: no successors, no dangling ids, no exception. A null
        // list has to behave as an empty one — it is what a projection with no nextStepIds member
        // deserializes to.
        var a = new StepL1(A, 1, P, "{}", null!);
        var selection = StepAdvancement.SelectNext(StepResult.Completed, a, Map());

        Assert.Empty(selection.Matches);
        Assert.Empty(selection.Dangling);
    }

    [Fact]
    public void EveryMatchedSuccessorIsReturnedInOrder()
    {
        var a = Step(A, 1, B, C);
        var selection = StepAdvancement.SelectNext(
            StepResult.Completed, a, Map(a, Step(B, 1), Step(C, 4)));

        Assert.Equal([B, C], selection.Matches.Select(s => s.StepId));
    }
}
