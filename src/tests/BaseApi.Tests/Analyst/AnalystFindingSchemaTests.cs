using BaseProcessor.Core.Validation;
using Processor.Analyst;
using Xunit;

namespace BaseApi.Tests.Analyst;

public sealed class AnalystFindingSchemaTests
{
    private static string Definition()
        => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Schemas", "analyst-finding.json"));

    private static AnalystFinding Sample() => new(
        Verdict: "Drifting",
        Target: new FindingTarget(Guid.Parse("1a56b3ca-e276-4815-87fa-5c2f48ab6dad"), "filefetcher-archiveexpander-chain"),
        Window: new RealizedWindow(
            From: new DateTimeOffset(2026, 9, 24, 0, 0, 0, TimeSpan.Zero),
            To: new DateTimeOffset(2026, 9, 24, 6, 0, 0, TimeSpan.Zero),
            SamplesExamined: 91),
        Reason: null,
        Insights:
        [
            new FindingInsight(
                Claim: "The broker is not the bottleneck; consumers are falling behind.",
                Why: "Arrival mean rose fourfold while produce duration stayed flat at 12ms.",
                Panels: ["arrival-mean", "produce-duration"]),
        ],
        Evidence:
        [
            new FindingEvidence("arrival-mean", "ops", "arrival mean, last hour", "180ms"),
            new FindingEvidence("produce-duration", "ops", "produce duration, last hour", "12ms"),
        ],
        RuledOut:
        [
            new RuledOutHypothesis(
                "The broker is slow",
                "queue depth would exceed 100 across the window",
                "queue depth never exceeded 4"),
        ],
        Trace:
        [
            new TraceEntry(1, "arrival-mean", true),
            new TraceEntry(2, "queue-depth", true),
            new TraceEntry(3, "produce-duration", true),
        ],
        Usage: new FindingUsage(
            Calls: 9,
            InputTokens: 120_000,
            OutputTokens: 6_000,
            ElapsedSeconds: 214,
            Budget: new FindingBudget(MaxIterations: 12, MaxTokens: 1_500_000, WallClockSeconds: 240),
            Dispatch: new DispatchSpend(Calls: 27, InputTokens: 347_528, OutputTokens: 17_001)),
        PromptHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

    [Fact]
    public void TheSerializedFindingValidatesAgainstItsSchema()
    {
        // The document KafkaExporter ships. If this ever fails, the exporter is publishing something
        // no consumer agreed to parse.
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), AnalystFinding.Serialize(Sample()), out var errors);

        Assert.True(ok, string.Join("; ", errors));
    }

    [Fact]
    public void TheSerializedFindingIsCamelCase()
    {
        // A single top-level assertion would not prove much: JsonSerializerOptions.CamelCase is one
        // setting applied to the whole object graph, so if it holds for one property it holds for
        // all of them by construction, and if it were somehow bypassed on a nested record the
        // strongest evidence would be exactly there, not at the top level. Every record in the
        // graph -- window, each evidence/ruledOut/trace element -- gets one assertion pair so a
        // regression that breaks casing on a nested type specifically (a stray [JsonPropertyName],
        // a nested type built with different options, ...) fails here with a clear name instead of
        // surfacing as an opaque schema-validation failure in the test above (additionalProperties
        // is false throughout, so a PascalCase nested property does fail that test too -- but it
        // fails as "unknown property", not as "casing is wrong").
        var json = System.Text.Encoding.UTF8.GetString(AnalystFinding.Serialize(Sample()));

        // Top level.
        Assert.Contains("\"verdict\"", json, StringComparison.Ordinal);
        Assert.Contains("\"window\"", json, StringComparison.Ordinal);
        Assert.Contains("\"target\"", json, StringComparison.Ordinal);
        Assert.Contains("\"insights\"", json, StringComparison.Ordinal);
        Assert.Contains("\"usage\"", json, StringComparison.Ordinal);
        Assert.Contains("\"reason\"", json, StringComparison.Ordinal);
        Assert.Contains("\"evidence\"", json, StringComparison.Ordinal);
        Assert.Contains("\"ruledOut\"", json, StringComparison.Ordinal);
        Assert.Contains("\"trace\"", json, StringComparison.Ordinal);
        Assert.Contains("\"promptHash\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Verdict\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Window\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Target\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Insights\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Usage\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"narrative\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Evidence\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"RuledOut\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Trace\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"PromptHash\"", json, StringComparison.Ordinal);

        // RealizedWindow.
        Assert.Contains("\"from\"", json, StringComparison.Ordinal);
        Assert.Contains("\"to\"", json, StringComparison.Ordinal);
        Assert.Contains("\"samplesExamined\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"From\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"To\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"SamplesExamined\"", json, StringComparison.Ordinal);

        // FindingEvidence.
        Assert.Contains("\"panelId\"", json, StringComparison.Ordinal);
        Assert.Contains("\"layer\"", json, StringComparison.Ordinal);
        Assert.Contains("\"label\"", json, StringComparison.Ordinal);
        Assert.Contains("\"value\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"PanelId\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Layer\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Label\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Value\"", json, StringComparison.Ordinal);

        // RuledOutHypothesis.
        Assert.Contains("\"hypothesis\"", json, StringComparison.Ordinal);
        Assert.Contains("\"disconfirmingCriterion\"", json, StringComparison.Ordinal);
        Assert.Contains("\"whatWasSeen\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Hypothesis\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"DisconfirmingCriterion\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"WhatWasSeen\"", json, StringComparison.Ordinal);

        // FindingTarget, FindingInsight, FindingUsage, FindingBudget, DispatchSpend.
        Assert.Contains("\"workflowId\"", json, StringComparison.Ordinal);
        Assert.Contains("\"claim\"", json, StringComparison.Ordinal);
        Assert.Contains("\"why\"", json, StringComparison.Ordinal);
        Assert.Contains("\"panels\"", json, StringComparison.Ordinal);
        Assert.Contains("\"inputTokens\"", json, StringComparison.Ordinal);
        Assert.Contains("\"elapsedSeconds\"", json, StringComparison.Ordinal);
        Assert.Contains("\"maxIterations\"", json, StringComparison.Ordinal);
        Assert.Contains("\"dispatch\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"WorkflowId\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Claim\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"InputTokens\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"MaxIterations\"", json, StringComparison.Ordinal);

        // TraceEntry.
        Assert.Contains("\"ordinal\"", json, StringComparison.Ordinal);
        Assert.Contains("\"dataReturned\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Ordinal\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"DataReturned\"", json, StringComparison.Ordinal);
    }

    [Fact]
    public void AVerdictOutsideTheEnumIsRejected()
    {
        // Four verdicts and no more. "Indeterminate" is not one: a run that could not see because a
        // facility failed is a Failed step with no document, not a verdict.
        var json = System.Text.Encoding.UTF8.GetString(AnalystFinding.Serialize(Sample()))
            .Replace("\"Drifting\"", "\"Indeterminate\"", StringComparison.Ordinal);

        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), System.Text.Encoding.UTF8.GetBytes(json), out _);

        Assert.False(ok);
    }

    [Fact]
    public void AFindingWithNoTraceIsRejected()
    {
        // Without the trace you cannot tell "checked the ops layer and it was clean" from "never
        // looked", which makes a wrong conclusion unauditable.
        var json = System.Text.Encoding.UTF8.GetString(AnalystFinding.Serialize(Sample()));
        var stripped = System.Text.Json.Nodes.JsonNode.Parse(json)!.AsObject();
        stripped.Remove("trace");

        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), System.Text.Encoding.UTF8.GetBytes(stripped.ToJsonString()), out _);

        Assert.False(ok);
    }

    [Fact]
    public void AnInsightCitingOnePanelIsRejected()
    {
        // One panel restated is a reading, not an insight. The schema refuses it so a finding that
        // only describes what a panel showed can never be exported.
        var json = System.Text.Json.Nodes.JsonNode.Parse(AnalystFinding.Serialize(Sample()))!.AsObject();
        json["insights"]![0]!["panels"] = new System.Text.Json.Nodes.JsonArray("arrival-mean");

        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), System.Text.Encoding.UTF8.GetBytes(json.ToJsonString()), out _);

        Assert.False(ok);
    }

    [Fact]
    public void AFindingWithNoInsightIsRejected()
    {
        // A Drifting or Notable verdict with nothing inferred is a contradiction; a run that reaches
        // no insight publishes Quiet instead.
        var json = System.Text.Json.Nodes.JsonNode.Parse(AnalystFinding.Serialize(Sample()))!.AsObject();
        json["insights"] = new System.Text.Json.Nodes.JsonArray();

        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), System.Text.Encoding.UTF8.GetBytes(json.ToJsonString()), out _);

        Assert.False(ok);
    }

    [Fact]
    public void AFindingWithAnUnreadableTargetNameAndNoMeterStillValidates()
    {
        // The name is a convenience read from L2 and the dispatch total needs a meter; neither may
        // stop a finding from being exported.
        var sample = Sample();
        var finding = sample with
        {
            Target = sample.Target with { Name = null },
            Usage = sample.Usage with { Dispatch = null },
        };

        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), AnalystFinding.Serialize(finding), out var errors);

        Assert.True(ok, string.Join("; ", errors));
    }

    private static AnalystFinding QuietSample()
    {
        var sample = Sample();
        return sample with
        {
            Verdict = "Quiet",
            Reason = "the thrown-work hypothesis died on a flat depth with no parked refusals",
            Insights = [],
            Evidence = [],
            RuledOut = [],
        };
    }

    [Theory]
    [InlineData("Quiet")]
    [InlineData("Inconclusive")]
    public void ANoFindingVerdictWithAReasonAndNoInsightValidates(string verdict)
    {
        // Every run whose facilities worked is published, so "nothing wrong" and "could not
        // believe the evidence" must be documents the schema accepts.
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), AnalystFinding.Serialize(QuietSample() with { Verdict = verdict }), out var errors);

        Assert.True(ok, string.Join("; ", errors));
    }

    [Fact]
    public void AQuietVerdictWithoutAReasonIsRejected()
    {
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), AnalystFinding.Serialize(QuietSample() with { Reason = null }), out _);

        Assert.False(ok);
    }

    [Fact]
    public void AQuietVerdictCarryingAnInsightIsRejected()
    {
        // An insight is a finding; publishing one under Quiet would hide it from any consumer that
        // filters on the verdict.
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), AnalystFinding.Serialize(QuietSample() with { Insights = Sample().Insights }), out _);

        Assert.False(ok);
    }

    [Fact]
    public void AFindingCarryingAReasonIsRejected()
    {
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), AnalystFinding.Serialize(Sample() with { Reason = "why not" }), out _);

        Assert.False(ok);
    }
}
