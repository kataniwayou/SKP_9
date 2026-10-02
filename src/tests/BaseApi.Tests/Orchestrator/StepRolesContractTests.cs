using Messaging.Contracts;
using Xunit;

namespace BaseApi.Tests.Orchestrator;

/// <summary>The values the dashboard and the Analyst select on, pinned as literals.</summary>
public sealed class StepRolesContractTests
{
    [Fact]
    public void TheKeyAndValuesAreFixed()
    {
        Assert.Equal("StepRole", StepRoles.Key);
        Assert.Equal(["entry", "intermediate", "terminal"], new[] { StepRoles.Entry, StepRoles.Intermediate, StepRoles.Terminal });
    }

    [Fact]
    public void AScopeCarriesExactlyTheRole()
        => Assert.Equal("terminal", Assert.Single(StepRoles.Scope(StepRoles.Terminal)).Value);

    [Fact]
    public void TheOutcomeTemplatesAreTheHandlersTwoPerOutcomeLines()
    {
        Assert.Equal("advanced {SuccessorCount} successor(s) in {ElapsedMs}ms", OutcomeTemplates.Advanced);
        Assert.Equal(
            "the terminal step completed with {Result} — no successor accepts it, the run ends here",
            OutcomeTemplates.BranchEnds);
        Assert.Equal([OutcomeTemplates.BranchEnds, OutcomeTemplates.Advanced], OutcomeTemplates.All);
    }
}
