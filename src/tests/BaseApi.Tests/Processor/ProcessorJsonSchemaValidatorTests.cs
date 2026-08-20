using System.Text;
using BaseProcessor.Core.Validation;
using Xunit;

namespace BaseApi.Tests.Processor;

public sealed class ProcessorJsonSchemaValidatorTests
{
    private const string NumberSchema = """
        {"type":"object","properties":{"number":{"type":"integer"}},"required":["number"]}
        """;

    private static byte[] Utf8(string s) => Encoding.UTF8.GetBytes(s);

    [Fact]
    public void NoDefinitionMeansNoValidation()
    {
        // A processor with no input or output schema is a normal configuration, not an error. Bytes
        // stay opaque and are never decoded without a schema to decode them for.
        Assert.True(ProcessorJsonSchemaValidator.TryValidate(null, Utf8("not json at all"), out _));
        Assert.True(ProcessorJsonSchemaValidator.TryValidate("   ", Utf8("not json at all"), out _));
    }

    [Fact]
    public void AcceptsDataThatMatches()
    {
        Assert.True(ProcessorJsonSchemaValidator.TryValidate(NumberSchema, Utf8("""{"number":7}"""), out var errors));
        Assert.Empty(errors);
    }

    [Fact]
    public void RejectsDataThatDoesNotMatchAndSaysWhere()
    {
        Assert.False(ProcessorJsonSchemaValidator.TryValidate(NumberSchema, Utf8("""{"number":"seven"}"""), out var errors));
        Assert.NotEmpty(errors);
    }

    [Fact]
    public void RejectsBytesThatAreNotJson()
    {
        Assert.False(ProcessorJsonSchemaValidator.TryValidate(NumberSchema, Utf8("not json"), out var errors));
        Assert.NotEmpty(errors);
    }

    [Fact]
    public void RejectsAnUnparseableSchemaWithoutCrashing()
    {
        // A malformed definition is a data problem in the schema table, and it must produce a business
        // failure rather than take the host down — the row can be fixed while the processor keeps
        // running.
        Assert.False(ProcessorJsonSchemaValidator.TryValidate("{not a schema", Utf8("""{"number":7}"""), out var errors));
        Assert.NotEmpty(errors);
    }

    [Fact]
    public void RefusesAnExternalReferenceInsteadOfFetchingIt()
    {
        // The global fetcher is disabled, so an external $ref cannot reach the network. It surfaces as
        // a business failure rather than an outbound request from inside a message handler.
        const string remote = """{"$ref":"https://example.invalid/schema.json"}""";

        Assert.False(ProcessorJsonSchemaValidator.TryValidate(remote, Utf8("""{"number":7}"""), out var errors));
        Assert.NotEmpty(errors);
    }

    [Fact]
    public void NoErrorMessageQuotesTheData()
    {
        // Validator messages reach StepFailed and the orchestrator's projections. They may name an
        // instance location, never a value.
        ProcessorJsonSchemaValidator.TryValidate(NumberSchema, Utf8("""{"number":"topsecret"}"""), out var errors);

        Assert.DoesNotContain(errors, e => e.Contains("topsecret", StringComparison.Ordinal));
    }
}
