using System.Text;
using BaseProcessor.Core.Validation;
using Xunit;

namespace BaseApi.Tests.FileFetcher;

/// <summary>
/// The registered input schema for FileFetcher — the shape KafkaImporter emits and
/// <c>FileFetcherProcessor.ReadPath</c> reads back off it — validated through the SAME validator the
/// post handler uses.
/// <para>
/// See <c>Schemas/README.md</c> for what this schema does and deliberately does not assert: in
/// particular, it does not encode <c>Path.IsPathFullyQualified</c>, which is platform-dependent and
/// stays a runtime check in <c>FileFetcherProcessor</c>.
/// </para>
/// </summary>
public sealed class FileFetcherLocatorSchemaTests
{
    // locator.json is the importer's output shape (and the fetcher's input shape). See
    // src/tests/BaseApi.Tests/Schemas/README.md.
    private static string Definition()
        => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Schemas", "locator.json"));

    private static byte[] Utf8(string json) => Encoding.UTF8.GetBytes(json);

    [Fact]
    public void AnOrdinaryLocatorValidates()
    {
        // Goes red if "filePath" stopped being the recognized property name (e.g. a typo in
        // locator.json's "required" or "properties" keys), since then this exact payload would
        // fail both the required check and additionalProperties: false.
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(),
            Utf8("""{"filePath":"C:\\data\\orders.csv"}"""),
            out var errors);

        Assert.True(ok, string.Join("; ", errors));
    }

    [Fact]
    public void ARelativeFilePathStillValidates()
    {
        // The schema does not, and must not, encode Path.IsPathFullyQualified — see the README's
        // "What it deliberately does not assert". Goes red if a pattern approximating "absolute"
        // were ever added to locator.json, since a relative path like this one would then fail.
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(),
            Utf8("""{"filePath":"orders.csv"}"""),
            out var errors);

        Assert.True(ok, string.Join("; ", errors));
    }

    [Fact]
    public void AnEmptyFilePathIsRejected()
    {
        // ReadPath's pattern match, `locator?.FilePath is { Length: > 0 } filePath`, treats an
        // empty string as "the branch carries no filePath". Goes red if minLength: 1 were removed
        // from locator.json's filePath property.
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(),
            Utf8("""{"filePath":""}"""),
            out _);

        Assert.False(ok);
    }

    [Fact]
    public void AMissingFilePathIsRejected()
    {
        // Goes red if "filePath" were dropped from locator.json's "required" array.
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(),
            Utf8("{}"),
            out _);

        Assert.False(ok);
    }

    [Fact]
    public void ANullFilePathIsRejected()
    {
        // ReadPath treats a null FilePath identically to a missing or empty one. Goes red if
        // locator.json's filePath type were widened to ["string", "null"].
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(),
            Utf8("""{"filePath":null}"""),
            out _);

        Assert.False(ok);
    }

    [Fact]
    public void ALocatorWithAnExtraKeyIsRejected()
    {
        // additionalProperties: false. providerName in particular must not travel silently — see
        // FileLocator's own doc comment on why it is absent from the record. Goes red if
        // additionalProperties: false were removed (or set true) in locator.json.
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(),
            Utf8("""{"filePath":"C:\\data\\orders.csv","providerName":"acme"}"""),
            out _);

        Assert.False(ok);
    }
}
