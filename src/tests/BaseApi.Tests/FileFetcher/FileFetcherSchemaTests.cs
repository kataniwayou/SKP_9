using System.Text;
using System.Text.Json;
using BaseProcessor.Core.Validation;
using Processor.FileFetcher;
using Xunit;

namespace BaseApi.Tests.FileFetcher;

/// <summary>
/// The registered output schema, against envelopes this processor actually emits, through the SAME
/// validator the post handler uses.
/// <para>
/// A schema failure in production is destructive: the post handler reports Failed with EntryId
/// Guid.Empty and acks, so nothing is written to L2 and the step's input was already reclaimed. The
/// file has been read and the result is discarded with no key to recover it.
/// </para>
/// </summary>
public sealed class FileFetcherSchemaTests
{
    // fetcher-output.json, not output.json: ArchiveExpander's output schema owns that name in the
    // test output. See the link in BaseApi.Tests.csproj.
    private static string Definition()
        => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "schema", "fetcher-output.json"));

    private static DateTime Stamp => new(2026, 9, 10, 8, 31, 2, DateTimeKind.Utc);

    private static byte[] Serialize(FetchedFile file)
        => JsonSerializer.SerializeToUtf8Bytes(file, FetchedFileJson.Options);

    [Fact]
    public void AnOrdinaryEnvelopeValidates()
    {
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(),
            Serialize(new FetchedFile("orders.csv", ".csv", 7, Stamp, Stamp,
                                      Encoding.UTF8.GetBytes("id,name"))),
            out var errors);

        Assert.True(ok, string.Join("; ", errors));
    }

    [Fact]
    public void NullTimestampsValidate()
    {
        // Archives record no creation time and some filesystems record neither. Null is a legal
        // value for both, and the keys are still present.
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(),
            Serialize(new FetchedFile("orders.csv", ".csv", 0, null, null, [])),
            out var errors);

        Assert.True(ok, string.Join("; ", errors));
    }

    [Fact]
    public void AnExtensionlessNameValidates()
    {
        // Admitted under "*.*", so the schema must accept an empty extension string.
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(),
            Serialize(new FetchedFile("README", "", 2, Stamp, Stamp, [1, 2])),
            out var errors);

        Assert.True(ok, string.Join("; ", errors));
    }

    [Fact]
    public void AnEnvelopeMissingContentIsRejected()
    {
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(),
            Encoding.UTF8.GetBytes(
                """{"fileName":"a.csv","extension":".csv","sizeBytes":1,"createdUtc":null,"modifiedUtc":null}"""),
            out _);

        Assert.False(ok);
    }

    [Fact]
    public void AnEnvelopeWithAnExtraKeyIsRejected()
    {
        // additionalProperties: false. A key nobody agreed on must not travel silently.
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(),
            Encoding.UTF8.GetBytes(
                """{"fileName":"a.csv","extension":".csv","sizeBytes":1,"createdUtc":null,"modifiedUtc":null,"content":"AQ==","filePath":"/mnt/a.csv"}"""),
            out _);

        Assert.False(ok);
    }
}
