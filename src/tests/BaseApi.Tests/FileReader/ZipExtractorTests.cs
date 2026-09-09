using System.IO.Compression;
using System.Text;
using System.Text.Json;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Options;
using NSubstitute;
using Processor.FileReader;
using Processor.FileReader.Extractors;
using Xunit;

namespace BaseApi.Tests.FileReader;

public sealed class ZipExtractorTests : IDisposable
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private readonly string _dir = Directory.CreateTempSubdirectory("skp-filereader-zip-").FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    /// <summary>A real zip on disk, built from bytes. No fixture file, no abstraction.</summary>
    private string WriteZip(string name, params (string Entry, string Text)[] entries)
    {
        var path = Path.Combine(_dir, name);
        using var file = File.Create(path);
        using var archive = new ZipArchive(file, ZipArchiveMode.Create);
        foreach (var (entry, text) in entries)
        {
            using var writer = new StreamWriter(archive.CreateEntry(entry).Open());
            writer.Write(text);
        }

        return path;
    }

    private const string ZipPayload =
        """{"ExpectedExtension":".zip","MinimumSizeBytes":0,"MaximumSizeBytes":65536}""";

    private static (FileReaderProcessor Processor, IQueueSender Sender) Build()
    {
        var sender = Substitute.For<IQueueSender>();
        var processor = new FileReaderProcessor(
            new RecordingLogger<FileReaderProcessor>(),
            Options.Create(new FileReaderOptions()),
            new FileContentBuilder([new ZipExtractor()]));
        processor.BeginDispatch(new DispatchState(sender, C, W, S, P));
        return (processor, sender);
    }

    private static async Task<JsonElement> DocumentOf(string path)
    {
        var (processor, sender) = Build();
        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        await processor.ExecuteAsync(
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { filePath = path })),
            ZipPayload, E, CancellationToken.None);

        return JsonDocument.Parse(Assert.Single(sends).Data).RootElement;
    }

    [Fact]
    public void ItHandlesZipAndNothingElse()
    {
        var extractor = new ZipExtractor();

        Assert.True(extractor.CanHandle(".zip"));
        Assert.True(extractor.CanHandle(".ZIP"));
        Assert.False(extractor.CanHandle(".tar"));
    }

    [Fact]
    public async Task AnArchiveBecomesEntriesAndCarriesNoContentOfItsOwn()
    {
        var path = WriteZip("orders.zip", ("a.csv", "id\n"), ("b.csv", "id,name\n"));

        var doc = await DocumentOf(path);

        Assert.Equal(JsonValueKind.Null, doc.GetProperty("content").ValueKind);
        Assert.Equal(2, doc.GetProperty("metadata").GetProperty("entryCount").GetInt32());
        Assert.Equal(2, doc.GetProperty("entries").GetArrayLength());
    }

    [Fact]
    public async Task EachEntryIsALeafWithItsOwnMetadata()
    {
        var path = WriteZip("orders.zip", ("a.csv", "id\n"));

        var doc = await DocumentOf(path);
        var entry = doc.GetProperty("entries")[0];

        Assert.Equal("a.csv", entry.GetProperty("metadata").GetProperty("name").GetString());
        Assert.Equal(".csv", entry.GetProperty("metadata").GetProperty("extension").GetString());
        Assert.Equal(3, entry.GetProperty("metadata").GetProperty("sizeBytes").GetInt64());
        Assert.Equal("id\n", Encoding.UTF8.GetString(entry.GetProperty("content").GetBytesFromBase64()));
        Assert.Empty(entry.GetProperty("entries").EnumerateArray());
    }

    [Fact]
    public async Task ANestedArchiveIsALeafRatherThanASecondLevel()
    {
        // Depth is one, by design. The inner zip's bytes are recorded; it is not expanded.
        var inner = WriteZip("inner.zip", ("deep.csv", "id\n"));
        var path = Path.Combine(_dir, "outer.zip");
        using (var file = File.Create(path))
        using (var archive = new ZipArchive(file, ZipArchiveMode.Create))
        {
            using var target = archive.CreateEntry("inner.zip").Open();
            using var source = File.OpenRead(inner);
            source.CopyTo(target);
        }

        var doc = await DocumentOf(path);
        var entry = doc.GetProperty("entries")[0];

        Assert.Equal("inner.zip", entry.GetProperty("metadata").GetProperty("name").GetString());
        Assert.Equal(JsonValueKind.String, entry.GetProperty("content").ValueKind);
        Assert.Empty(entry.GetProperty("entries").EnumerateArray());
    }

    [Fact]
    public async Task ADirectoryEntryIsNotANode()
    {
        // A zip records directories as zero-length entries ending in a slash. They carry no content
        // and no metadata worth a node, and counting them would make entryCount disagree with what a
        // reader sees.
        var path = Path.Combine(_dir, "orders.zip");
        using (var file = File.Create(path))
        using (var archive = new ZipArchive(file, ZipArchiveMode.Create))
        {
            archive.CreateEntry("nested/");
            using var writer = new StreamWriter(archive.CreateEntry("nested/a.csv").Open());
            writer.Write("id\n");
        }

        var doc = await DocumentOf(path);

        Assert.Equal(1, doc.GetProperty("metadata").GetProperty("entryCount").GetInt32());
        Assert.Equal("a.csv",
            doc.GetProperty("entries")[0].GetProperty("metadata").GetProperty("name").GetString());
    }

    [Fact]
    public async Task ACorruptArchiveFailsTheStepNamingThePath()
    {
        var path = Path.Combine(_dir, "broken.zip");
        File.WriteAllText(path, "this is not a zip");

        var (processor, _) = Build();

        var ex = await Assert.ThrowsAsync<FailedException>(() => processor.ExecuteAsync(
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { filePath = path })),
            ZipPayload, E, CancellationToken.None));

        Assert.Contains($"extracting {path} failed", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ExtractedEntryModifiedUtcCarriesUtcKind()
    {
        // Task 4 review requirement: ZipArchiveEntry.LastWriteTime is a DateTimeOffset, and
        // .UtcDateTime is the conversion that yields DateTimeKind.Utc. .DateTime or .LocalDateTime
        // would silently produce Kind.Local/Unspecified, which System.Text.Json renders without a
        // trailing Z (or with an offset) — a schema failure one hop downstream, in a branch that is
        // discarded rather than reported.
        var path = WriteZip("orders.zip", ("a.csv", "id\n"));

        using var stream = File.OpenRead(path);
        var entries = new ZipExtractor().Extract(stream);

        Assert.Equal(DateTimeKind.Utc, Assert.Single(entries).ModifiedUtc!.Value.Kind);
    }
}
