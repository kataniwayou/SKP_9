using System.Text;
using System.Text.Json;
using BaseProcessor.Core.Startup;
using BaseProcessor.Core.Validation;
using Processor.SKNormalizer;
using Xunit;

namespace BaseApi.Tests.SKNormalizer;

public sealed class SKNormalizerConfigSchemaTests
{
    private static string Definition()
        => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Schemas", "sknormalizer-config.json"));

    private static IReadOnlyList<string> EnumNames()
        => JsonDocument.Parse(Definition())
            .RootElement
            .GetProperty("properties")
            .GetProperty("handler")
            .GetProperty("enum")
            .EnumerateArray()
            .Select(e => e.GetString()!)
            .ToList();

    /// <summary>Every handler this build registers, resolved the way ProcessorHost registers them.</summary>
    private static IReadOnlyList<string> Registered()
        => new ProviderHandlerRegistry([new SampleHandler()]).Names;

    [Fact]
    public void TheEnumAndTheRegistryAreTheSameSet()
    {
        // THE CHECK THAT CANNOT BE A STARTUP HOOK. ProcessorStartupOrchestrator hands the config
        // definition to ConfigSchemaConformance.Check and never stores it, and ConfigSchemaConformance
        // does not read enum values — so there is no runtime seam without amending
        // BaseProcessor.Core. This test is the whole defence against adding a handler and forgetting
        // the enum, which is the realistic drift.
        Assert.Equal(Registered().Order().ToArray(), EnumNames().Order().ToArray());
    }

    [Fact]
    public void TheSchemaDescribesTheConfigRecord()
    {
        // The same check ProcessorStartupOrchestrator runs at startup, run here so a mismatch fails
        // the build rather than leaving a replica published UNHEALTHY. camelCase is pinned: the
        // binder is case-insensitive but a JSON Schema property name is not, so only one of
        // {"Handler":...} and {"handler":...} would validate.
        var problems = ConfigSchemaConformance.Check(typeof(SKNormalizerConfig), Definition());

        Assert.Empty(problems);
    }

    [Fact]
    public void APayloadNamingAKnownHandlerValidates()
    {
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), Encoding.UTF8.GetBytes("""{"handler":"Sample"}"""), out var errors);

        Assert.True(ok, string.Join("; ", errors));
    }

    [Fact]
    public void APayloadNamingAnAbsentHandlerIsRejected()
    {
        // THE PUBLISH-TIME REJECTION, which is the whole point of the enum:
        // PayloadConfigSchemaValidator runs this in BaseApi's OrchestrationService, so an operator
        // naming a handler that does not exist is refused while they are still at the screen.
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), Encoding.UTF8.GetBytes("""{"handler":"NotHere"}"""), out _);

        Assert.False(ok);
    }

    [Fact]
    public void APayloadWithNoHandlerIsRejected()
    {
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), Encoding.UTF8.GetBytes("{}"), out _);

        Assert.False(ok);
    }

    [Fact]
    public void APascalCasePayloadIsRejected()
    {
        // The drift this pinning exists to catch. ProcessorConfig.SerializerOptions binds
        // case-insensitively, so {"Handler":"Sample"} would reach the record — but a JSON Schema
        // property name is case-sensitive, so it must not validate.
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), Encoding.UTF8.GetBytes("""{"Handler":"Sample"}"""), out _);

        Assert.False(ok);
    }
}
