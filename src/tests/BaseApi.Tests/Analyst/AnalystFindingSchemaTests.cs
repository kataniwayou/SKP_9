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
        Window: new RealizedWindow(
            From: new DateTimeOffset(2026, 9, 24, 0, 0, 0, TimeSpan.Zero),
            To: new DateTimeOffset(2026, 9, 24, 6, 0, 0, TimeSpan.Zero),
            SamplesExamined: 91),
        Narrative: "Arrival mean rose from 40ms to 180ms across the window.",
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
        Assert.Contains("\"narrative\"", json, StringComparison.Ordinal);
        Assert.Contains("\"evidence\"", json, StringComparison.Ordinal);
        Assert.Contains("\"ruledOut\"", json, StringComparison.Ordinal);
        Assert.Contains("\"trace\"", json, StringComparison.Ordinal);
        Assert.Contains("\"promptHash\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Verdict\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Window\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Narrative\"", json, StringComparison.Ordinal);
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

        // TraceEntry.
        Assert.Contains("\"ordinal\"", json, StringComparison.Ordinal);
        Assert.Contains("\"dataReturned\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Ordinal\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"DataReturned\"", json, StringComparison.Ordinal);
    }

    [Fact]
    public void AVerdictOutsideTheEnumIsRejected()
    {
        // Quiet and Indeterminate deliberately do not exist here: they are step dispositions, not
        // values. A finding document only ever describes a real finding.
        var json = System.Text.Encoding.UTF8.GetString(AnalystFinding.Serialize(Sample()))
            .Replace("\"Drifting\"", "\"Quiet\"", StringComparison.Ordinal);

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
}
