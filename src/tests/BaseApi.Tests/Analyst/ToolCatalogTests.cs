using System.Text.Json;
using Processor.Analyst.Panels;
using Processor.Analyst.Tools;
using Xunit;

namespace BaseApi.Tests.Analyst;

public sealed class ToolCatalogTests
{
    private static IReadOnlyList<PanelDescriptor> Panels() =>
    [
        new("queue-wait", "ops", "queue wait, p95"),
        new("step-outcomes", "business", "step outcomes by result"),
    ];

    [Fact]
    public void TheCatalogCarriesEveryStageToolAndBothTerminalTools()
    {
        var names = ToolCatalog.Build(Panels()).Select(t => t.Name).ToHashSet();

        Assert.Contains(ToolNames.ReadPanel, names);
        Assert.Contains(ToolNames.ListPanels, names);
        Assert.Contains(ToolNames.RecordResearch, names);
        Assert.Contains(ToolNames.RecordValidation, names);
        Assert.Contains(ToolNames.RecordPlan, names);
        Assert.Contains(ToolNames.RecordReadings, names);
        Assert.Contains(ToolNames.RecordVerification, names);
        Assert.Contains(ToolNames.SubmitFinding, names);
        Assert.Contains(ToolNames.ReportNoFinding, names);
    }

    [Fact]
    public void TheCatalogSizeDoesNotGrowWithThePanelSet()
    {
        // One parameterized read_panel, not one tool per panel. The tool block is the cache prefix,
        // so a growing panel set would inflate every single request.
        var two = ToolCatalog.Build(Panels()).Count;
        var many = ToolCatalog.Build(
            [.. Enumerable.Range(0, 40).Select(i => new PanelDescriptor($"p{i}", "ops", $"panel {i}"))]).Count;

        Assert.Equal(two, many);
    }

    [Fact]
    public void ReadPanelConstrainsItsPanelIdToTheConfiguredSet()
    {
        // The read boundary, expressed where the model can see it: a panel outside this monitor's
        // set is not something it can ask for and be refused -- it is not expressible.
        var spec = ToolCatalog.Build(Panels()).Single(t => t.Name == ToolNames.ReadPanel);

        var enumValues = JsonDocument.Parse(spec.InputSchemaJson)
            .RootElement.GetProperty("properties").GetProperty("panelId").GetProperty("enum")
            .EnumerateArray().Select(e => e.GetString()!).ToArray();

        Assert.Equal(["queue-wait", "step-outcomes"], enumValues);
    }

    [Fact]
    public void EveryToolSchemaForbidsAdditionalProperties()
    {
        // Server-side strict enforcement does not exist on the on-prem path, so the client validates
        // every input itself -- and it can only do that against a closed schema.
        foreach (var spec in ToolCatalog.Build(Panels()))
        {
            var root = JsonDocument.Parse(spec.InputSchemaJson).RootElement;

            Assert.False(
                root.GetProperty("additionalProperties").GetBoolean(),
                $"{spec.Name} allows additional properties");
        }
    }

    [Fact]
    public void BothTerminalToolsAreNamedAsTerminal()
    {
        Assert.Equal(
            new HashSet<string> { ToolNames.SubmitFinding, ToolNames.ReportNoFinding },
            ToolNames.Terminal.ToHashSet());
    }

    [Fact]
    public void SubmitFindingRequiresRuledOutAndEvidenceButNotTrace()
    {
        // The two fields an agent optimizing for looking decisive would quietly drop. Requiring them
        // in the schema is cheaper than hoping the prompt asks nicely.
        var schema = ToolCatalog.SchemaFor(ToolNames.SubmitFinding);
        var required = JsonDocument.Parse(schema).RootElement.GetProperty("required")
            .EnumerateArray().Select(e => e.GetString()).ToHashSet();

        Assert.Contains("ruledOut", required);
        Assert.Contains("evidence", required);
        // NOT "trace": the loop assembles it from what it actually executed. A model-supplied trace
        // is a claim about what happened; a loop-assembled one is what happened.
        Assert.DoesNotContain("trace", required);
    }
}
