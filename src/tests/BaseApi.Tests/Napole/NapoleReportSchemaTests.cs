using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using BaseProcessor.Core.Validation;
using Xunit;

namespace BaseApi.Tests.Napole;

public sealed class NapoleReportSchemaTests
{
    private static string Definition()
        => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Schemas", "napole-report.json"));

    [Fact]
    public void TheSerializedReportValidates()
    {
        // The document the kafka-exporter ships. If this fails, the topic carries something no
        // consumer agreed to parse.
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), ReportBuilderTests.WorkedExample().Serialize(), out var errors);

        Assert.True(ok, string.Join("; ", errors));
    }

    [Fact]
    public void TheFieldNamesAreTheContractsVerbatim()
    {
        // Misspellings included: commonDimentions, mandatoryMeasurments, timStampHour are the
        // external contract's names, not typos to fix.
        using var doc = JsonDocument.Parse(ReportBuilderTests.WorkedExample().Serialize());
        var root = doc.RootElement;

        Assert.Equal(["commonDimentions", "mandatoryMeasurments"], Names(root));
        Assert.Equal(
            ["reporterComponentName", "reporterSubComponentName", "reporterNetworkName", "reportFromTime",
             "reportToTime", "insertionTime", "srcCode", "sagCode", "timStampHour"],
            Names(root.GetProperty("commonDimentions")));
        Assert.Equal(
            ["inputCount", "outputCount", "discardedCount", "failedCount"],
            Names(root.GetProperty("mandatoryMeasurments")));

        var dims = root.GetProperty("commonDimentions");
        foreach (var name in new[] { "reportFromTime", "reportToTime", "insertionTime", "timStampHour" })
        {
            Assert.Equal(JsonValueKind.Number, dims.GetProperty(name).ValueKind);
        }

        foreach (var count in root.GetProperty("mandatoryMeasurments").EnumerateObject())
        {
            Assert.Equal(JsonValueKind.Number, count.Value.ValueKind);
        }

        Assert.Equal(2026110810, dims.GetProperty("timStampHour").GetInt64());
    }

    [Fact]
    public void AnExtraFieldIsRejected()
    {
        var node = JsonNode.Parse(ReportBuilderTests.WorkedExample().Serialize())!;
        node["mandatoryMeasurments"]!["extra"] = 1;

        Assert.False(ProcessorJsonSchemaValidator.TryValidate(
            Definition(), Encoding.UTF8.GetBytes(node.ToJsonString()), out _));
    }

    [Fact]
    public void AMissingCountIsRejected()
    {
        var node = JsonNode.Parse(ReportBuilderTests.WorkedExample().Serialize())!;
        node["mandatoryMeasurments"]!.AsObject().Remove("failedCount");

        Assert.False(ProcessorJsonSchemaValidator.TryValidate(
            Definition(), Encoding.UTF8.GetBytes(node.ToJsonString()), out _));
    }

    private static string[] Names(JsonElement e) => [.. e.EnumerateObject().Select(p => p.Name)];
}
