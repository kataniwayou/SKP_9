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
        // Isolate the citedPanels branch specifically: the plan's own panelsToRead panel WAS read
        // (so the "judged without reading its own criterion" check is satisfied) and the finding's
        // evidence panel WAS read too (so the evidence check is satisfied) -- only the verdict's
        // citedPanels names something, "ghost-panel", that was never read anywhere. An earlier
        // version of this test made "queue-depth" unread in three places at once, so all three
        // unrelated checks produced a problem containing "queue-depth" and the assertion passed on
        // any of them -- proving nothing about citedPanels specifically. Verified by temporarily
        // deleting the citedPanels loop in StageAssertions.Check: only this test failed.
        var artifacts = Complete();
        var verification = Json("""
            {"verdicts":[{"hypothesis":"broker slow","survived":false,"whatWasSeen":"max 4",
                          "citedPanels":["queue-depth","ghost-panel"]}]}
            """);
        var revised = new StageArtifacts();
        foreach (var name in new[] { "record_research", "record_validation", "record_plan", "record_readings" })
        {
            revised.Record(name, artifacts.Get(name));
        }
        revised.Record("record_verification", verification);

        var problems = StageAssertions.Check(revised, TraceOver("queue-depth"), Finding());

        Assert.Contains(problems, p => p.Contains("ghost-panel", StringComparison.Ordinal));
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

    [Fact]
    public void AHypothesisWhoseCriterionPanelWasAlreadyReadBeforeThePlanWasRecordedIsAProblem()
    {
        // The natural rationalising sequence: read everything, THEN write the "disconfirming"
        // criterion for what you already saw. record_plan's ordinal can still precede
        // record_readings' -- the two self-reports agree with each other -- but the trace shows the
        // panel's answer was already in hand when the plan was recorded (mark: 1, one panel already
        // read).
        var artifacts = new StageArtifacts();
        artifacts.Record("record_research", Json("""{"observations":["x"]}"""), panelsReadMark: 1);
        artifacts.Record("record_validation", Json("""{"analysable":true,"concerns":[],"reason":"r"}"""), panelsReadMark: 1);
        artifacts.Record("record_plan", Json("""
            {"hypotheses":[{"hypothesis":"broker slow","disconfirmingCriterion":"queue depth over 100",
                            "panelsToRead":["queue-depth"]}]}
            """), panelsReadMark: 1);
        artifacts.Record("record_readings", Json("""
            {"readings":[{"panelId":"queue-depth","summary":"max 4","trusted":true}]}
            """), panelsReadMark: 1);
        artifacts.Record("record_verification", Json("""
            {"verdicts":[{"hypothesis":"broker slow","survived":false,"whatWasSeen":"max 4",
                          "citedPanels":["queue-depth"]}]}
            """), panelsReadMark: 1);

        var problems = StageAssertions.Check(artifacts, TraceOver("queue-depth"), Finding());

        Assert.Contains(problems,
            p => p.Contains("broker slow", StringComparison.Ordinal)
                && p.Contains("already read", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void ARuledOutHypothesisThatRecordPlanNeverProposedIsAProblem()
    {
        // record_plan and record_verification are checked, but finding.ruledOut is the only one of
        // the three that actually reaches the operator -- so a hypothesis invented at submit time,
        // with no plan or verification behind it, must be caught here.
        var finding = Json("""
            {"verdict":"Drifting","narrative":"n","samplesExamined":91,
             "evidence":[{"panelId":"queue-depth","layer":"ops","label":"l","value":"v"}],
             "ruledOut":[{"hypothesis":"disk full","disconfirmingCriterion":"disk over 90 percent",
                          "whatWasSeen":"n/a"}]}
            """);

        var problems = StageAssertions.Check(Complete(), TraceOver("queue-depth"), finding);

        Assert.Contains(problems,
            p => p.Contains("disk full", StringComparison.Ordinal)
                && p.Contains("never proposed", StringComparison.Ordinal));
    }

    [Fact]
    public void ARuledOutCriterionThatDoesNotMatchRecordPlansIsAProblem()
    {
        // The finding can name a real, planned hypothesis and still misquote what would have killed
        // it -- a softer or harder criterion than the one actually pre-committed to.
        var finding = Json("""
            {"verdict":"Drifting","narrative":"n","samplesExamined":91,
             "evidence":[{"panelId":"queue-depth","layer":"ops","label":"l","value":"v"}],
             "ruledOut":[{"hypothesis":"broker slow","disconfirmingCriterion":"queue depth over 1000",
                          "whatWasSeen":"max 4"}]}
            """);

        var problems = StageAssertions.Check(Complete(), TraceOver("queue-depth"), finding);

        Assert.Contains(problems, p => p.Contains("does not match", StringComparison.Ordinal));
    }

    [Fact]
    public void ARuledOutHypothesisThatRecordVerificationSaysSurvivedIsAProblem()
    {
        // A finding claiming a hypothesis was ruled out while its own verification says it survived
        // is a direct self-contradiction between the exported document and the record behind it.
        var artifacts = Complete();
        var verification = Json("""
            {"verdicts":[{"hypothesis":"broker slow","survived":true,"whatWasSeen":"max 4",
                          "citedPanels":["queue-depth"]}]}
            """);
        var revised = new StageArtifacts();
        foreach (var name in new[] { "record_research", "record_validation", "record_plan", "record_readings" })
        {
            revised.Record(name, artifacts.Get(name));
        }
        revised.Record("record_verification", verification);

        var problems = StageAssertions.Check(revised, TraceOver("queue-depth"), Finding());

        Assert.Contains(problems,
            p => p.Contains("broker slow", StringComparison.Ordinal)
                && p.Contains("surviving=false", StringComparison.Ordinal));
    }

    [Fact]
    public void AHypothesisProposedInThePlanThatVerificationNeverJudgesIsAProblem()
    {
        // The reverse direction of the plan/verification cross-check: a planned hypothesis that
        // verification silently drops cannot later be claimed, honestly, as ruled out -- nothing
        // ever judged it.
        var artifacts = new StageArtifacts();
        artifacts.Record("record_research", Json("""{"observations":["x"]}"""));
        artifacts.Record("record_validation", Json("""{"analysable":true,"concerns":[],"reason":"r"}"""));
        artifacts.Record("record_plan", Json("""
            {"hypotheses":[
                {"hypothesis":"broker slow","disconfirmingCriterion":"queue depth over 100","panelsToRead":["queue-depth"]},
                {"hypothesis":"consumer stuck","disconfirmingCriterion":"lag over 500","panelsToRead":["queue-depth"]}
            ]}
            """));
        artifacts.Record("record_readings", Json("""
            {"readings":[{"panelId":"queue-depth","summary":"max 4","trusted":true}]}
            """));
        artifacts.Record("record_verification", Json("""
            {"verdicts":[{"hypothesis":"broker slow","survived":false,"whatWasSeen":"max 4",
                          "citedPanels":["queue-depth"]}]}
            """));

        var problems = StageAssertions.Check(artifacts, TraceOver("queue-depth"), Finding());

        Assert.Contains(problems,
            p => p.Contains("consumer stuck", StringComparison.Ordinal)
                && p.Contains("never judges", StringComparison.Ordinal));
    }

    [Fact]
    public void ADuplicateHypothesisInThePlanIsAProblemNotACrash()
    {
        // The record_plan schema has no way to express hypothesis-name uniqueness, so a schema-valid
        // reply can name the same hypothesis twice. Building the lookup with Dictionary.ToDictionary
        // throws a raw ArgumentException on that -- a genuinely defective record should become a
        // problem, not an exception that escapes Check's own contract.
        var artifacts = new StageArtifacts();
        artifacts.Record("record_research", Json("""{"observations":["x"]}"""));
        artifacts.Record("record_validation", Json("""{"analysable":true,"concerns":[],"reason":"r"}"""));
        artifacts.Record("record_plan", Json("""
            {"hypotheses":[
                {"hypothesis":"broker slow","disconfirmingCriterion":"queue depth over 100","panelsToRead":["queue-depth"]},
                {"hypothesis":"broker slow","disconfirmingCriterion":"a different criterion","panelsToRead":["queue-depth"]}
            ]}
            """));
        artifacts.Record("record_readings", Json("""
            {"readings":[{"panelId":"queue-depth","summary":"max 4","trusted":true}]}
            """));
        artifacts.Record("record_verification", Json("""
            {"verdicts":[{"hypothesis":"broker slow","survived":false,"whatWasSeen":"max 4",
                          "citedPanels":["queue-depth"]}]}
            """));

        var problems = StageAssertions.Check(artifacts, TraceOver("queue-depth"), Finding());

        Assert.Contains(problems,
            p => p.Contains("broker slow", StringComparison.Ordinal)
                && p.Contains("more than once", StringComparison.Ordinal));
    }
}
