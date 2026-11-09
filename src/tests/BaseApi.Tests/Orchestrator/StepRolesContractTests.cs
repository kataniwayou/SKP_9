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
        Assert.Equal(["entry", "terminal"], new[] { StepRoles.Entry, StepRoles.Terminal });
    }

    [Fact]
    public void ThereAreExactlyTwoRoles()
    {
        // The run's two edges. A third value would put a graph role back on every step.
        var values = typeof(StepRoles).GetFields()
            .Where(f => f.IsLiteral && f.Name != nameof(StepRoles.Key))
            .Select(f => (string)f.GetRawConstantValue()!);
        Assert.Equal(["entry", "terminal"], values.Order());
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

    // Napole reads these two by exact equality on {OriginalFormat}, against the text the running
    // orchestrator already writes, so they are pinned as literals: a reworded template would make every
    // advanced-anyway step read as Completed, with no error anywhere.
    [Fact]
    public void TheEntryTemplateIsWhatTheOrchestratorWritesToday()
        => Assert.Equal("the entry step completed with {Result}", OutcomeTemplates.EntryCompleted);

    [Fact]
    public void TheAdvancedAnywayTemplateIsWhatTheOrchestratorWritesToday()
        => Assert.Equal(
            "advancing {SuccessorCount} successor(s) on a {Result} step — their entry conditions accept it",
            OutcomeTemplates.AdvancedAnyway);

    [Fact]
    public void NapolesTemplatesStayOutOfTheFunnelList()
    {
        Assert.DoesNotContain(OutcomeTemplates.EntryCompleted, OutcomeTemplates.All);
        Assert.DoesNotContain(OutcomeTemplates.AdvancedAnyway, OutcomeTemplates.All);
    }
}
