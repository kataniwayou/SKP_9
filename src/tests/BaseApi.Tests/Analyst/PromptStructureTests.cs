using Processor.Analyst.Bit;
using Xunit;

namespace BaseApi.Tests.Analyst;

/// <summary>
/// The deterministic half of the gate. Every case here must hold identically on every run — that is
/// the entire reason this check does not go to the model.
/// </summary>
public sealed class PromptStructureTests
{
    private static string Body(string text) => text + new string('x', 100);

    private static string WellFormed() => string.Join("\n\n",
        "You are reviewing a chain. The earlier stages observe, judge the evidence, plan, and gather.",
        Body("STAGE 1 - RESEARCH. Spend one read and record what it returned. "),
        Body("STAGE 2 - VALIDATE. Decide whether each observation can be believed, and stop if not. "),
        Body("STAGE 3 - PLAN. State each hypothesis with the criterion that would kill it. "),
        Body("STAGE 4 - EXECUTE. Gather exactly the evidence each criterion calls for. "),
        Body("STAGE 5 - VERIFY. Judge each hypothesis, and be able to end with nothing. "));

    [Fact]
    public void AWellFormedPromptHasNoStructuralFaults()
        => Assert.Empty(PromptStructure.Check(WellFormed()));

    [Fact]
    public void ThePublishedV9PromptHasAllFiveStages()
    {
        // tools/analyst-prompt-v9.txt is what the dev rollout PUTs into the analyst-monitor payload.
        // The deterministic half of the BIT runs on it there; running it here first means a stage
        // broken by the graph bullets fails the build rather than the next scheduled fire.
        var root = AppContext.BaseDirectory;
        while (!File.Exists(Path.Combine(root, "SK_P.sln")) && Directory.GetParent(root) is { } parent)
        {
            root = parent.FullName;
        }

        var prompt = File.ReadAllText(Path.Combine(root, "tools", "analyst-prompt-v9.txt"));

        Assert.Empty(PromptStructure.Check(prompt));
    }

    [Fact]
    public void ProseWithNoStagesIsRejectedWithoutAskingAnyone()
    {
        // The original analyst-monitor prompt: real domain guidance, no stage structure at all.
        var problems = PromptStructure.Check(
            "You are reviewing a document-processing chain. Decide whether anything in this window "
            + "deserves an operator's attention tonight. A dead-letter queue above zero is always "
            + "worth reporting. If nothing contributes, say so.");

        Assert.Equal(5, problems.Count);
        Assert.All(problems, p => Assert.Equal("missing", p.Kind));
        Assert.Equal(
            ["research", "validate", "plan", "execute", "verify"],
            problems.Select(p => p.Stage).ToArray());
    }

    [Fact]
    public void AStageMentionedOnlyInProseDoesNotCountAsDefiningIt()
    {
        var problems = PromptStructure.Check(WellFormed().Replace("STAGE 3 - PLAN.", "Thirdly,"));

        var plan = Assert.Single(problems);
        Assert.Equal("plan", plan.Stage);
        Assert.Equal("missing", plan.Kind);
    }

    /// <summary>
    /// The regression that made this check worth writing carefully: the deployed prompt says
    /// "observe, judge the evidence, plan, and gather" in its preamble, so the word <c>plan</c>
    /// appears before the research heading. Ordering judged on word position would reject it.
    /// </summary>
    [Fact]
    public void AStageWordInThePreambleDoesNotBreakTheOrdering()
    {
        var prompt = WellFormed();

        Assert.Contains("plan, and gather", prompt, StringComparison.Ordinal);
        Assert.True(prompt.IndexOf("plan, and gather", StringComparison.Ordinal)
                    < prompt.IndexOf("STAGE 1 - RESEARCH", StringComparison.Ordinal));

        Assert.Empty(PromptStructure.Check(prompt));
    }

    [Fact]
    public void StagesOutOfOrderAreReported()
    {
        var prompt = WellFormed()
            .Replace("STAGE 3 - PLAN.", "STAGE 3 - TEMP.")
            .Replace("STAGE 4 - EXECUTE.", "STAGE 4 - PLAN.")
            .Replace("STAGE 3 - TEMP.", "STAGE 3 - EXECUTE.");

        var problem = Assert.Single(PromptStructure.Check(prompt));

        Assert.Equal("contradicting", problem.Kind);
        Assert.Contains("execute", problem.Offending, StringComparison.Ordinal);
    }

    [Fact]
    public void AHeadingWithNothingUnderItIsMalformed()
    {
        var prompt = string.Join("\n\n",
            "Preamble.",
            Body("STAGE 1 - RESEARCH. Spend one read. "),
            Body("STAGE 2 - VALIDATE. Decide what can be believed. "),
            "STAGE 3 - PLAN.",
            Body("STAGE 4 - EXECUTE. Gather the evidence. "),
            Body("STAGE 5 - VERIFY. Judge each hypothesis and be able to end with nothing. "));

        var problem = Assert.Single(PromptStructure.Check(prompt));

        Assert.Equal("plan", problem.Stage);
        Assert.Equal("malformed", problem.Kind);
    }

    [Fact]
    public void TheCheckIsDeterministic()
    {
        var prompt = WellFormed().Replace("STAGE 2 - VALIDATE.", "Secondly,");

        var runs = Enumerable.Range(0, 50)
            .Select(_ => string.Join("|", PromptStructure.Check(prompt).Select(p => $"{p.Stage}:{p.Kind}")))
            .Distinct()
            .ToList();

        Assert.Single(runs);
        Assert.Equal("validate:missing", runs[0]);
    }
}
