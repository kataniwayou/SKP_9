using System.Text;
using BaseProcessor.Core.Startup;
using BaseProcessor.Core.Validation;
using Processor.Napole;
using Xunit;

namespace BaseApi.Tests.Napole;

public sealed class NapoleConfigSchemaTests
{
    private static string Definition()
        => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Schemas", "napole-config.json"));

    // Spec §3: the whole-run section of the split chain, named as the pod named it before.
    private const string WellFormed = """{"watchedWorkflowId":"8cfdbcdb-a7e0-4a7d-9b4d-e4120ccacf02","fromStepId":"95225f8c-56b2-494b-a59d-d9b34fbde441","toStepId":"06f1c5fd-bdfc-43ae-93c9-5bde2995e167","windowMinutes":10,"reporterSubComponentName":"split-whole-run"}""";

    /// <summary>The well-formed payload with one field replaced, or removed when <paramref name="value"/> is null.</summary>
    private static string With(string field, object? value)
    {
        var node = System.Text.Json.Nodes.JsonNode.Parse(WellFormed)!.AsObject();
        if (value is null)
        {
            node.Remove(field);
        }
        else
        {
            node[field] = System.Text.Json.JsonSerializer.SerializeToNode(value);
        }

        return node.ToJsonString();
    }

    private static bool Validates(string payload)
        => ProcessorJsonSchemaValidator.TryValidate(Definition(), Encoding.UTF8.GetBytes(payload), out _);

    [Fact]
    public void TheSchemaDescribesTheConfigRecord()
    {
        // The check ProcessorStartupOrchestrator runs at startup, here so a mismatch fails the build.
        Assert.Empty(ConfigSchemaConformance.Check(typeof(NapoleConfig), Definition()));
    }

    [Fact]
    public void AWellFormedPayloadValidates()
    {
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(),
            Encoding.UTF8.GetBytes(WellFormed),
            out var errors);

        Assert.True(ok, string.Join("; ", errors));
    }

    [Fact]
    public void APayloadWithAnyOtherFieldIsRejected()
    {
        // The payload is the target and the time frame and nothing else (spec §5): the lag, the
        // trail and the dimensions are the pod's, and a payload naming one would silently do nothing.
        Assert.False(Validates(With("lagSeconds", 60)));
    }

    [Fact]
    public void AWindowBelowOneIsRejected()
    {
        Assert.False(Validates(With("windowMinutes", 0)));
    }

    [Fact]
    public void APayloadWithNoWorkflowIsRejected()
    {
        Assert.False(Validates(With("watchedWorkflowId", null)));
    }

    [Fact]
    public void AWorkflowThatIsNoGuidIsRejected()
    {
        Assert.False(Validates(With("watchedWorkflowId", "split-chain")));
    }

    [Fact]
    public void APayloadWithNoFromStepIsRejected() => Assert.False(Validates(With("fromStepId", null)));

    [Fact]
    public void APayloadWithNoToStepIsRejected() => Assert.False(Validates(With("toStepId", null)));

    [Fact]
    public void AStepThatIsNoGuidIsRejected()
    {
        Assert.False(Validates(With("fromStepId", "split-importer")));
        Assert.False(Validates(With("toStepId", "split-exporter")));
    }

    [Fact]
    public void AnEmptySubComponentIsRejected() => Assert.False(Validates(With("reporterSubComponentName", "")));

    [Fact]
    public void APayloadWithNoSubComponentIsRejected() => Assert.False(Validates(With("reporterSubComponentName", null)));

    [Fact]
    public void ASingleStepSectionValidates()
        => Assert.True(Validates(With("toStepId", "95225f8c-56b2-494b-a59d-d9b34fbde441")));
}
