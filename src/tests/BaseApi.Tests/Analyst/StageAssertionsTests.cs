using System.Text.Json;
using Processor.Analyst.Loop;
using Xunit;

namespace BaseApi.Tests.Analyst;

public sealed class StageAssertionsTests
{
    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private static StageArtifacts Complete()
    {
        var artifacts = new StageArtifacts();
        artifacts.Record("record_research", Json("""{"observations":["arrival mean rose"]}"""));
        artifacts.Record("record_validation", Json("""{"analysable":true,"concerns":[],"reason":"series present"}"""));
        artifacts.Record("record_plan", Json("""
            {"hypotheses":[{"hypothesis":"broker slow","disconfirmingCriterion":"queue depth over 100",
                            "panelsToRead":["queue-depth"]}]}
            """));
        artifacts.Record("record_readings", Json("""
            {"readings":[{"panelId":"queue-depth","summary":"max 4","trusted":true}]}
            """));
        artifacts.Record("record_verification", Json("""
            {"verdicts":[{"hypothesis":"broker slow","survived":false,"whatWasSeen":"max 4",
                          "citedPanels":["queue-depth"]}]}
            """));
        return artifacts;
    }

    private static InvestigationTrace TraceOver(params string[] panels)
    {
        var trace = new InvestigationTrace();
        foreach (var p in panels) trace.Record(p, dataReturned: true);
        return trace;
    }

    private static JsonElement Finding(string evidencePanel = "queue-depth") => Json($$"""
        {"verdict":"Drifting","narrative":"n","samplesExamined":91,
         "evidence":[{"panelId":"{{evidencePanel}}","layer":"ops","label":"l","value":"v"}],
         "ruledOut":[{"hypothesis":"broker slow","disconfirmingCriterion":"queue depth over 100",
                      "whatWasSeen":"max 4"}]}
        """);

    [Fact]
    public void ACompleteInvestigationHasNoProblems()
    {
        var problems = StageAssertions.Check(Complete(), TraceOver("queue-depth"), Finding());

        Assert.Empty(problems);
    }

    [Fact]
    public void AMissingStageIsAProblem()
    {
        var artifacts = Complete();
        var without = new StageArtifacts();
        foreach (var name in new[] { "record_research", "record_validation", "record_plan", "record_readings" })
        {
            without.Record(name, artifacts.Get(name));
        }

        var problems = StageAssertions.Check(without, TraceOver("queue-depth"), Finding());

        Assert.Contains(problems, p => p.Contains("record_verification", StringComparison.Ordinal));
    }

    [Fact]
    public void APlanRecordedAfterTheReadingsIsAProblem()
    {
        // The pre-commitment is the whole point. A criterion stated after the evidence was seen is
        // not a criterion, it is a rationalisation -- and verify then has nothing to hold the agent to.
        var artifacts = new StageArtifacts();
        artifacts.Record("record_research", Json("""{"observations":["x"]}"""));
        artifacts.Record("record_validation", Json("""{"analysable":true,"concerns":[],"reason":"r"}"""));
        artifacts.Record("record_readings", Json("""
            {"readings":[{"panelId":"queue-depth","summary":"max 4","trusted":true}]}
            """));
        artifacts.Record("record_plan", Json("""
            {"hypotheses":[{"hypothesis":"broker slow","disconfirmingCriterion":"over 100",
                            "panelsToRead":["queue-depth"]}]}
            """));
        artifacts.Record("record_verification", Json("""
            {"verdicts":[{"hypothesis":"broker slow","survived":false,"whatWasSeen":"max 4",
                          "citedPanels":["queue-depth"]}]}
            """));

        var problems = StageAssertions.Check(artifacts, TraceOver("queue-depth"), Finding());

        Assert.Contains(problems, p => p.Contains("before", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void AVerdictCitingAPanelThatWasNeverReadIsAProblem()
    {
        var problems = StageAssertions.Check(Complete(), TraceOver("arrival-mean"), Finding());

        Assert.Contains(problems, p => p.Contains("queue-depth", StringComparison.Ordinal));
    }

    [Fact]
    public void EvidenceReferencingAPanelThatWasNeverReadIsAProblem()
    {
        var problems = StageAssertions.Check(Complete(), TraceOver("queue-depth"), Finding(evidencePanel: "ghost"));

        Assert.Contains(problems, p => p.Contains("ghost", StringComparison.Ordinal));
    }

    [Fact]
    public void AHypothesisRuledOutWithoutReadingItsOwnCriterionIsAProblem()
    {
        // "I suspected the broker and ruled it out" is only worth something if the thing that would
        // have shown a slow broker was actually looked at.
        var artifacts = Complete();
        var plan = Json("""
            {"hypotheses":[{"hypothesis":"broker slow","disconfirmingCriterion":"queue depth over 100",
                            "panelsToRead":["queue-depth","broker-liveness"]}]}
            """);
        var revised = new StageArtifacts();
        revised.Record("record_research", artifacts.Get("record_research"));
        revised.Record("record_validation", artifacts.Get("record_validation"));
        revised.Record("record_plan", plan);
        revised.Record("record_readings", artifacts.Get("record_readings"));
        revised.Record("record_verification", artifacts.Get("record_verification"));

        var problems = StageAssertions.Check(revised, TraceOver("queue-depth"), Finding());

        Assert.Contains(problems, p => p.Contains("broker-liveness", StringComparison.Ordinal));
    }

    [Fact]
    public void ASurvivingHypothesisWithNoStatedCriterionIsAProblem()
    {
        var artifacts = Complete();
        var verification = Json("""
            {"verdicts":[{"hypothesis":"something else entirely","survived":true,"whatWasSeen":"w",
                          "citedPanels":["queue-depth"]}]}
            """);
        var revised = new StageArtifacts();
        foreach (var name in new[] { "record_research", "record_validation", "record_plan", "record_readings" })
        {
            revised.Record(name, artifacts.Get(name));
        }
        revised.Record("record_verification", verification);

        var problems = StageAssertions.Check(revised, TraceOver("queue-depth"), Finding());

        Assert.Contains(problems, p => p.Contains("something else entirely", StringComparison.Ordinal));
    }
}
