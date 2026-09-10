using System.Text;
using System.Text.Json;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using BaseProcessor.Core.Validation;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Options;
using NSubstitute;
using Processor.FilePersister;
using Xunit;

namespace BaseApi.Tests.FilePersister;

/// <summary>
/// The mirror of <c>FileFetcherEnvelopeTests</c>: that one asserts what goes ON the wire, this one
/// asserts what comes OFF it and lands on a disk.
/// <para>
/// <b>The pair assertion — a file read by FileFetcher and written by FilePersister is the same
/// file</b> — lives in <see cref="TheFileWrittenIsByteIdenticalToTheFileFetched"/>, and it is the
/// only test here that runs both processors. Everything else pins one half.
/// </para>
/// </summary>
public sealed class FilePersisterTests : IDisposable
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private readonly string _in = Directory.CreateTempSubdirectory("skp-persist-in-").FullName;
    private readonly string _out = Directory.CreateTempSubdirectory("skp-persist-out-").FullName;

    public void Dispose()
    {
        Directory.Delete(_in, recursive: true);
        Directory.Delete(_out, recursive: true);
    }

    private string Payload(string? folder = null) =>
        JsonSerializer.Serialize(new { folderPath = folder ?? _out });

    /// <summary>An envelope in exactly the shape FileFetcher and ArchiveCollapser both emit.</summary>
    private static byte[] Envelope(
        string fileName, byte[] content, string? extension = null, bool omitContent = false)
    {
        var body = new Dictionary<string, object?>
        {
            ["fileName"] = fileName,
            ["extension"] = extension ?? Path.GetExtension(fileName),
            ["sizeBytes"] = content.Length,
            ["createdUtc"] = null,
            ["modifiedUtc"] = null,
        };

        if (!omitContent)
        {
            body["content"] = Convert.ToBase64String(content);
        }

        return JsonSerializer.SerializeToUtf8Bytes(body);
    }

    private Task<List<ProcessedData>> Persist(byte[] envelope, string? payload = null)
        => PersistWith(envelope, payload ?? Payload());

    /// <summary>
    /// The raw call, so a test can pass a NULL step payload — which is a different case than a
    /// malformed one and cannot be reached through the defaulting overload above.
    /// </summary>
    private async Task<List<ProcessedData>> PersistWith(byte[] envelope, string? payload)
    {
        var sender = Substitute.For<IQueueSender>();
        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        var processor = new FilePersisterProcessor(new RecordingLogger<FilePersisterProcessor>());
        processor.BeginDispatch(new DispatchState(sender, C, W, S, P));

        // payload! because the NULL case is exactly what one test here exercises: ExecuteAsync
        // declares it non-nullable, and the processor's own guard is what must answer for it.
        await processor.ExecuteAsync(envelope, payload!, E, CancellationToken.None);

        return sends;
    }

    private static string PathOf(ProcessedData branch)
        => JsonDocument.Parse(branch.Data).RootElement.GetProperty("filePath").GetString()!;

    // ---- the write ----------------------------------------------------------------------------

    [Fact]
    public async Task TheBytesReachTheFolderUnchanged()
    {
        var content = Encoding.UTF8.GetBytes("id,name\n1,alice\n");

        await Persist(Envelope("orders.csv", content));

        Assert.Equal(content, File.ReadAllBytes(Path.Combine(_out, "orders.csv")));
    }

    [Fact]
    public async Task TheExtensionIsNotAppendedToTheName()
    {
        // THE REGRESSION THIS FILE EXISTS FOR. FetchedFile is built from FileInfo.Name, which
        // ALREADY carries the extension — an envelope reads {"fileName":"a.zip","extension":".zip"}.
        // A path built as folder + name + extension yields "a.zip.zip", which writes a real file,
        // reports a real path, and is wrong in a way nothing downstream would notice.
        await Persist(Envelope("orders.zip", [1, 2, 3]));

        Assert.True(File.Exists(Path.Combine(_out, "orders.zip")));
        Assert.False(File.Exists(Path.Combine(_out, "orders.zip.zip")));
    }

    [Fact]
    public async Task AnExistingFileIsOverwritten()
    {
        // Re-running a workflow over the same input must land in the same state, exactly as
        // re-running FileFetcher reads the same file twice.
        File.WriteAllBytes(Path.Combine(_out, "orders.csv"), [9, 9, 9, 9, 9, 9]);

        await Persist(Envelope("orders.csv", [1, 2, 3]));

        Assert.Equal([1, 2, 3], File.ReadAllBytes(Path.Combine(_out, "orders.csv")));
    }

    [Fact]
    public async Task AnEmptyContentWritesAZeroByteFile()
    {
        // A zero-byte file is a file. FileFetcher admits one — MinimumSizeBytes 0 disables the floor
        // — so refusing here would lose a file the far end of the workflow accepted.
        await Persist(Envelope("empty.csv", []));

        Assert.Empty(File.ReadAllBytes(Path.Combine(_out, "empty.csv")));
    }

    // ---- the branch ---------------------------------------------------------------------------

    [Fact]
    public async Task OneBranchIsSentOnTheDispatchsOwnExecutionId()
    {
        // A transform, not a source: the lineage it was handed is the lineage it continues.
        var branch = Assert.Single(await Persist(Envelope("orders.csv", [1])));

        Assert.Equal(E, branch.ExecutionId);
    }

    [Fact]
    public async Task TheLocatorCarriesTheFullPathInCamelCase()
    {
        var branch = Assert.Single(await Persist(Envelope("orders.csv", [1])));

        using var doc = JsonDocument.Parse(branch.Data);
        var prop = Assert.Single(doc.RootElement.EnumerateObject().Select(p => p.Name));
        Assert.Equal("filePath", prop);
        Assert.Equal(Path.Combine(_out, "orders.csv"), PathOf(branch));
    }

    [Fact]
    public async Task TheLocatorValidatesAgainstTheRegisteredSchema()
    {
        // The SAME validator the post handler runs, against the same locator.json the importer's
        // output is checked with. The two producers of this row must be indistinguishable to it.
        var branch = Assert.Single(await Persist(Envelope("orders.csv", [1])));

        var ok = ProcessorJsonSchemaValidator.TryValidate(
            File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Schemas", "locator.json")),
            branch.Data,
            out var errors);

        Assert.True(ok, string.Join("; ", errors));
    }

    // ---- the pair -----------------------------------------------------------------------------

    [Fact]
    public async Task TheFileWrittenIsByteIdenticalToTheFileFetched()
    {
        // THE MIRROR ASSERTION, and the only test here that runs both processors: bytes leave the
        // filesystem through FileFetcher and return to it through FilePersister, and the two files
        // are the same file.
        //
        // Content only, deliberately. Timestamps are not restored — see FilePersisterProcessor's
        // summary — so a FileInfo-level comparison would fail for a reason that is not about the
        // file. The live gate compares the same way, between the in and out folders.
        var source = Path.Combine(_in, "orders.zip");
        var original = Encoding.UTF8.GetBytes("PK not really a zip, and nothing here opens it");
        File.WriteAllBytes(source, original);

        var fetcher = new global::Processor.FileFetcher.FileFetcherProcessor(
            new RecordingLogger<global::Processor.FileFetcher.FileFetcherProcessor>(),
            Options.Create(new global::Processor.FileFetcher.FileFetcherOptions()));

        var sender = Substitute.For<IQueueSender>();
        var fetched = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(fetched.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());
        fetcher.BeginDispatch(new DispatchState(sender, C, W, S, P));

        await fetcher.ExecuteAsync(
            JsonSerializer.SerializeToUtf8Bytes(new { filePath = source }),
            """{"AllowedExtensions":[".zip"],"MinimumSizeBytes":0,"MaximumSizeBytes":4096}""",
            E, CancellationToken.None);

        var branch = Assert.Single(await Persist(Assert.Single(fetched).Data));

        Assert.Equal(original, File.ReadAllBytes(PathOf(branch)));
        Assert.Equal(Path.Combine(_out, "orders.zip"), PathOf(branch));
    }

    // ---- payload faults -----------------------------------------------------------------------

    [Fact]
    public async Task AnAbsentPayloadIsRejected()
    {
        var ex = await Assert.ThrowsAsync<FailedException>(
            () => PersistWith(Envelope("orders.csv", [1]), payload: null));

        Assert.Contains("step payload rejected", ex.Message, StringComparison.Ordinal);
        Assert.Contains("FolderPath", ex.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("""{"folderPath":""}""", "must not be empty")]
    [InlineData("""{"folderPath":"out"}""", "must be absolute")]
    public async Task AMalformedFolderPathIsARejectedPayload(string payload, string expected)
    {
        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Persist(Envelope("orders.csv", [1]), payload));

        Assert.Contains("step payload rejected", ex.Message, StringComparison.Ordinal);
        Assert.Contains(expected, ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AFolderThatDoesNotExistIsARejectedPayloadAndIsNotCreated()
    {
        // NOT created: an absent folder means the volume is not mounted, and creating it would put
        // the file in the container's own layer where it reports a path and is gone at the next
        // restart.
        var missing = Path.Combine(_out, "nope");

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Persist(Envelope("orders.csv", [1]), Payload(missing)));

        Assert.Contains("does not exist", ex.Message, StringComparison.Ordinal);
        Assert.False(Directory.Exists(missing));
    }

    // ---- envelope faults ----------------------------------------------------------------------

    [Fact]
    public async Task AnEnvelopeThatIsNotJsonIsDiagnosedWithoutQuotingIt()
    {
        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Persist(Encoding.UTF8.GetBytes("{not json at all")));

        Assert.Contains("the branch is not JSON", ex.Message, StringComparison.Ordinal);
        // The fragment that failed to parse is upstream content and must not reach a log store.
        Assert.DoesNotContain("not json at all", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnEnvelopeWithNoContentIsRejected()
    {
        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Persist(Envelope("orders.csv", [1], omitContent: true)));

        Assert.Contains("carries no content", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnEnvelopeWithNoFileNameIsRejected()
    {
        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Persist(Envelope("", [1], extension: ".csv")));

        Assert.Contains("carries no fileName", ex.Message, StringComparison.Ordinal);
    }

    // ---- the name guard -----------------------------------------------------------------------

    [Theory]
    [InlineData("../escape.csv")]
    [InlineData("..\\escape.csv")]
    [InlineData("sub/orders.csv")]
    [InlineData("sub\\orders.csv")]
    [InlineData("..")]
    public async Task AFileNameThatNamesADirectoryIsRejectedAndNothingIsWritten(string name)
    {
        // The name is the ONE piece of upstream data that reaches the filesystem. Without this,
        // whoever wrote the envelope chooses where this pod writes.
        //
        // Both separators are covered on both platforms on purpose: Path.GetInvalidFileNameChars is
        // platform-dependent and would let a backslash through on Linux.
        var ex = await Assert.ThrowsAsync<FailedException>(() => Persist(Envelope(name, [1])));

        Assert.Contains("rejected", ex.Message, StringComparison.Ordinal);
        Assert.Contains("names a directory", ex.Message, StringComparison.Ordinal);
        Assert.Empty(Directory.GetFileSystemEntries(_out));
    }
}
