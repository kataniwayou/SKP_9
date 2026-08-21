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
        // Validator messages are logged by both handlers as the only record of why a step failed.
        // They may name an instance location, never a value — a log store is no better a place for a
        // payload than the projection these used to reach.
        ProcessorJsonSchemaValidator.TryValidate(NumberSchema, Utf8("""{"number":"topsecret"}"""), out var errors);

        Assert.DoesNotContain(errors, e => e.Contains("topsecret", StringComparison.Ordinal));
    }

    public static TheoryData<string, string> LeakyKeywords() => new()
    {
        // Every one of these keywords embeds the offending instance value in the library's own error
        // message — "-999888 should be at least 18", and so on. The `type` case above happens not to,
        // which is exactly why testing only `type` gave false confidence.
        { """{"type":"object","properties":{"n":{"minimum":18}}}""",    """{"n":-999888}""" },
        { """{"type":"object","properties":{"n":{"maximum":18}}}""",    """{"n":777666}"""  },
        { """{"type":"object","properties":{"n":{"multipleOf":5}}}""",  """{"n":123457}"""  },
    };

    [Theory]
    [MemberData(nameof(LeakyKeywords))]
    public void NoErrorMessageQuotesANumericValueEither(string schema, string json)
    {
        // The digits are distinctive so a substring match cannot pass by accident.
        var value = System.Text.RegularExpressions.Regex.Match(json, @"-?\d+").Value;

        Assert.False(ProcessorJsonSchemaValidator.TryValidate(schema, Utf8(json), out var errors));
        Assert.NotEmpty(errors);
        Assert.DoesNotContain(errors, e => e.Contains(value, StringComparison.Ordinal));
    }

    public static TheoryData<string> MalformedSchemasThatAreValidJson() =>
    [
        // Valid JSON, but not a schema. Both of these throw from inside JsonSchema.FromText with
        // exception types the specific catches do not name — a RegexParseException and an
        // ArgumentException respectively. Either escaping would park a message instead of reporting a
        // failed step.
        """{"type":"object","properties":{"a":{"type":"string","pattern":"("}}}""",
        """"just a string"""",
    ];

    [Theory]
    [MemberData(nameof(MalformedSchemasThatAreValidJson))]
    public void ReturnsAVerdictForASchemaThatIsValidJsonButNotAValidSchema(string definition)
    {
        // A malformed row in the schema table is a business failure, never a crash. The row can be
        // fixed while the processor keeps running.
        var thrown = Record.Exception(
            () => ProcessorJsonSchemaValidator.TryValidate(definition, Utf8("""{"a":"x"}"""), out _));

        Assert.Null(thrown);
        Assert.False(ProcessorJsonSchemaValidator.TryValidate(definition, Utf8("""{"a":"x"}"""), out var errors));
        Assert.NotEmpty(errors);
    }
}
